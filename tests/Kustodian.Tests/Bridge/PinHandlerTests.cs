using System.Text.Json;
using Kustodian.Messaging.Handlers;
using Kustodian.Storage;

namespace Kustodian.Tests.Bridge;

public sealed class PinHandlerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly Messaging.Bridge _bridge = new(_ => { });

    public PinHandlerTests() => new PinHandler(new JsonFileStore(_dir)).Register(_bridge);

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private async Task<JsonElement> CallAsync(string method, string @params)
    {
        var json = await _bridge.HandleAsync($$"""{"id":"x","method":"{{method}}","params":{{@params}}}""");
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static string[] Ids(JsonElement pins, string name) => [.. pins.GetProperty(name).EnumerateArray().Select(i => i.GetString()!)];

    [Fact]
    public async Task Pins_are_none_until_set_then_kept_in_order_without_repeats()
    {
        var none = (await CallAsync("pins.get", "{}")).GetProperty("result");
        Assert.Empty(Ids(none, "queries"));
        Assert.Empty(Ids(none, "workbooks"));

        await CallAsync("pins.set", """{"pins":{"queries":["b","a","b",""]}}""");
        var got = (await CallAsync("pins.get", "{}")).GetProperty("result");

        Assert.Equal(["b", "a"], Ids(got, "queries"));
        Assert.Empty(Ids(got, "workbooks"));
        Assert.True(File.Exists(Path.Combine(_dir, PinHandler.FileName)));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"pins":{"queries":"a"}}""")]
    [InlineData("""{"pins":{"workbooks":[1]}}""")]
    public async Task Pins_set_refuses_what_isnt_a_list_of_ids(string @params)
    {
        var answer = await CallAsync("pins.set", @params);

        Assert.Equal("bad_request", answer.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Pins_set_refuses_too_many()
    {
        var ids = string.Join(",", Enumerable.Range(0, PinHandler.MaxPins + 1).Select(i => $"\"q{i}\""));

        var answer = await CallAsync("pins.set", $$$"""{"pins":{"queries":[{{{ids}}}]}}""");

        Assert.Equal("bad_request", answer.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Pins_get_reads_a_corrupt_file_as_none()
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(Path.Combine(_dir, PinHandler.FileName), "{not json", TestContext.Current.CancellationToken);

        var got = (await CallAsync("pins.get", "{}")).GetProperty("result");

        Assert.Empty(Ids(got, "queries"));
    }
}
