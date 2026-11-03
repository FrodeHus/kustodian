using System.Text.Json;
using Kustodian.ExternalTools;
using Kustodian.Messaging.Handlers;

namespace Kustodian.Tests.Bridge;

public sealed class ExternalToolHandlerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly List<string> _events = [];
    private readonly List<string> _opened = [];
    private readonly Messaging.Bridge _bridge;

    public ExternalToolHandlerTests()
    {
        _bridge = new(_events.Add);
        new ExternalToolHandler(new ExternalToolService(_dir, _opened.Add)).Register(_bridge);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private void WriteTools(string json)
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, ExternalToolService.FileName), json);
    }

    private async Task<JsonElement> CallAsync(string method, string @params)
    {
        var json = await _bridge.HandleAsync($$"""{"id":"x","method":"{{method}}","params":{{@params}}}""");
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    [Fact]
    public async Task List_without_a_file_has_no_tools_and_no_problem()
    {
        var result = (await CallAsync("tools.list", "{}")).GetProperty("result");

        Assert.Equal(0, result.GetProperty("tools").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("problem").ValueKind);
    }

    [Fact]
    public async Task Edit_writes_a_valid_example_and_opens_it()
    {
        await CallAsync("tools.edit", "{}");
        var result = (await CallAsync("tools.list", "{}")).GetProperty("result");

        Assert.Equal([Path.Combine(_dir, ExternalToolService.FileName)], _opened);
        Assert.Equal(1, result.GetProperty("tools").GetArrayLength());
    }

    [Theory]
    [InlineData("""{"tools":[{"name":"a","command":"x","args":[],"mode":"sometimes"}]}""", "mode")]
    [InlineData("""{"tools":[{"name":"a","command":"x","args":["{id}"],"mode":"batch"}]}""", "batch mode")]
    [InlineData("""{"tools":[{"name":"a","command":"x","args":[],"mode":"each"},{"name":"a","command":"y","args":[],"mode":"each"}]}""", "two tools")]
    [InlineData("""{"tools":[{"name":"a","args":[],"mode":"each"}]}""", "command")]
    [InlineData("""{"tools": """, "isn't valid")]
    public async Task A_file_that_isnt_valid_is_reported_and_left_alone(string json, string expected)
    {
        WriteTools(json);
        var result = (await CallAsync("tools.list", "{}")).GetProperty("result");

        Assert.Equal(0, result.GetProperty("tools").GetArrayLength());
        Assert.Contains(expected, result.GetProperty("problem").GetString());
        Assert.Equal(json, File.ReadAllText(Path.Combine(_dir, ExternalToolService.FileName)));
    }

    [Fact]
    public async Task Each_mode_passes_a_row_value_as_one_argument_and_never_through_a_shell()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Uses /bin/echo.");
        WriteTools("""{"tools":[{"name":"echo","command":"/bin/echo","args":["id={id}"],"mode":"each"}]}""");

        var response = await CallAsync("tools.run", """
            {"runId":"r","name":"echo","columns":["id","n"],"rows":[["a; echo pwned $(whoami)",1],[null,2]]}
            """);

        var outcomes = response.GetProperty("result").GetProperty("outcomes");
        Assert.Equal("id=a; echo pwned $(whoami)\n", outcomes[0].GetProperty("output").GetString());
        Assert.Equal("id=\n", outcomes[1].GetProperty("output").GetString());
        Assert.Equal(0, outcomes[0].GetProperty("exitCode").GetInt32());
        Assert.Equal(2, _events.Count);
    }

    [Fact]
    public async Task Batch_mode_sends_the_rows_on_stdin_as_json()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Uses /bin/cat.");
        WriteTools("""{"tools":[{"name":"cat","command":"/bin/cat","args":[],"mode":"batch"}]}""");

        var response = await CallAsync("tools.run", """{"runId":"r","name":"cat","columns":["id","tags"],"rows":[["a",["x"]],["b",null]]}""");

        var output = response.GetProperty("result").GetProperty("outcomes")[0].GetProperty("output").GetString();
        Assert.Equal("""[{"id":"a","tags":["x"]},{"id":"b","tags":null}]""" + "\n", output);
    }

    [Fact]
    public async Task A_run_that_needs_a_missing_column_is_refused()
    {
        WriteTools("""{"tools":[{"name":"echo","command":"/bin/echo","args":["{userPrincipalName}"],"mode":"each"}]}""");

        var response = await CallAsync("tools.run", """{"runId":"r","name":"echo","columns":["id"],"rows":[["a"]]}""");

        Assert.Equal("bad_request", response.GetProperty("error").GetProperty("code").GetString());
        Assert.Contains("userPrincipalName", response.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task A_mapping_fills_a_parameter_from_another_column()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Uses /bin/echo.");
        WriteTools("""{"tools":[{"name":"echo","command":"/bin/echo","args":["{upn}","{id}"],"mode":"each"}]}""");

        var response = await CallAsync("tools.run", """
            {"runId":"r","name":"echo","columns":["id","userPrincipalName"],"rows":[["a","a@contoso.com"]],"mapping":{"upn":"userPrincipalName"}}
            """);

        Assert.Equal("a@contoso.com a\n", response.GetProperty("result").GetProperty("outcomes")[0].GetProperty("output").GetString());
    }

    [Fact]
    public async Task A_mapping_to_a_column_the_result_lacks_is_refused()
    {
        WriteTools("""{"tools":[{"name":"echo","command":"/bin/echo","args":["{upn}"],"mode":"each"}]}""");

        var response = await CallAsync("tools.run", """{"runId":"r","name":"echo","columns":["id"],"rows":[["a"]],"mapping":{"upn":"mail"}}""");

        Assert.Equal("bad_request", response.GetProperty("error").GetProperty("code").GetString());
        Assert.Contains("no column mail", response.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task A_command_that_cant_start_is_refused()
    {
        WriteTools("""{"tools":[{"name":"gone","command":"/no/such/command","args":[],"mode":"batch"}]}""");

        var response = await CallAsync("tools.run", """{"runId":"r","name":"gone","columns":[],"rows":[]}""");

        Assert.Contains("couldn't start", response.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Cancel_stops_a_running_tool()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Uses /bin/sleep.");
        WriteTools("""{"tools":[{"name":"sleep","command":"/bin/sleep","args":["30"],"mode":"batch"}]}""");

        var run = CallAsync("tools.run", """{"runId":"r","name":"sleep","columns":[],"rows":[]}""");
        await Task.Delay(300, TestContext.Current.CancellationToken);
        await CallAsync("tools.cancel", """{"runId":"r"}""");

        var response = await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        Assert.Equal("cancelled", response.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public void A_batch_file_cant_take_row_values_on_windows()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Batch files only run through cmd.exe on Windows.");

        var problem = ExternalToolService.Problem([new ExternalTool("az", @"C:\az.cmd", ["{id}"], ExternalToolService.Each)]);

        Assert.Contains("batch file", problem);
    }
}
