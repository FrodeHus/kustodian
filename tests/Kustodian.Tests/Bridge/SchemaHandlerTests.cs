using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;
using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Schema;
using Kustodian.Messaging.Handlers;
using Kustodian.Sources.Hunting;
using Kustodian.Sources.Logs;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Bridge;

public class SchemaHandlerTests
{
    private const string TenantSchema = """
        {"tables":[{"name":"DeviceProcessEvents","description":"Process creation and related events",
          "columns":[{"name":"Timestamp","dataType":"DateTime","description":"When"}]}],
         "functions":{"builtInFunctions":[{"name":"FileProfile","documentation":"File details.",
           "inputParameters":[{"name":"SHA1","cslType":"string"}]}],"savedFunctions":[]}}
        """;

    /// <summary>A handler whose hunting schema comes from <paramref name="graph"/> (none: every read fails) for
    /// <c>account-1</c>, or for nobody when <paramref name="account"/> is null.</summary>
    internal static SchemaHandler Handler(Stub? graph, string? account = null) =>
        new(GraphSchemaCatalog.Beta,
            new HuntingSchemaSource(new HttpClient(graph ?? new Stub(_ => new HttpResponseMessage(HttpStatusCode.Forbidden))),
                new FakeTimeProvider()),
            () => Task.FromResult(account));

    [Fact]
    public async Task Schema_get_hunting_returns_the_tenant_schema_with_functions()
    {
        var graph = new Stub(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(TenantSchema, Encoding.UTF8, "application/json"),
        });
        var bridge = new Messaging.Bridge(_ => { });
        Handler(graph, "account-1").Register(bridge);

        var view = Result(await bridge.HandleAsync("""{"id":"s","method":"schema.get","params":{"source":"hunting"}}"""));
        await bridge.HandleAsync("""{"id":"s","method":"schema.get","params":{"source":"hunting"}}""");
        await bridge.HandleAsync("""{"id":"s","method":"schema.get","params":{"source":"hunting","refresh":true}}""");

        Assert.Equal(2, graph.Requests.Count);
        Assert.Equal("account-1", graph.Requests[0]);
        Assert.Equal(["source", "origin", "fallbackReason", "generatedAt", "tables", "functions", "complexTypes"],
            view.EnumerateObject().Select(p => p.Name));
        Assert.Equal("hunting", view.GetProperty("source").GetString());
        Assert.Equal("tenant", view.GetProperty("origin").GetString());
        Assert.Equal(JsonValueKind.Null, view.GetProperty("fallbackReason").ValueKind);
        var table = view.GetProperty("tables")[0];
        Assert.Equal("DeviceProcessEvents", table.GetProperty("name").GetString());
        foreach (var graphOnly in new[] { "path", "area", "docsUrl", "permissions" })
        {
            Assert.Equal(JsonValueKind.Null, table.GetProperty(graphOnly).ValueKind);
        }

        var column = table.GetProperty("columns")[0];
        Assert.Equal("datetime", column.GetProperty("type").GetString());
        foreach (var graphOnly in new[] { "filterable", "listable", "complexType" })
        {
            Assert.Equal(JsonValueKind.Null, column.GetProperty(graphOnly).ValueKind);
        }

        var function = view.GetProperty("functions")[0];
        Assert.Equal(["name", "description", "parameters"], function.EnumerateObject().Select(p => p.Name));
        Assert.Equal("FileProfile", function.GetProperty("name").GetString());
        Assert.Equal("File details.", function.GetProperty("description").GetString());
        Assert.Equal("""[{"name":"SHA1","type":"string"}]""", function.GetProperty("parameters").GetRawText());
    }

    [Fact]
    public async Task Schema_get_hunting_without_an_account_is_builtin_with_the_reason()
    {
        var graph = new Stub(_ => throw new InvalidOperationException("No request is expected."));
        var bridge = new Messaging.Bridge(_ => { });
        Handler(graph).Register(bridge);

        var view = Result(await bridge.HandleAsync("""{"id":"s","method":"schema.get","params":{"source":"hunting"}}"""));

        Assert.Empty(graph.Requests);
        Assert.Equal("builtIn", view.GetProperty("origin").GetString());
        Assert.Equal(SchemaHandler.SignInForTenantSchema, view.GetProperty("fallbackReason").GetString());
        Assert.Equal(66, view.GetProperty("tables").GetArrayLength());
        Assert.Equal(4, view.GetProperty("functions").GetArrayLength());
    }

    [Fact]
    public async Task Schema_get_arg_returns_the_documented_tables_without_a_request()
    {
        var arm = new Stub(_ => throw new InvalidOperationException("No request is expected."));
        var bridge = new Messaging.Bridge(_ => { });
        Handler(arm, "account-1").Register(bridge);

        var view = Result(await bridge.HandleAsync("""{"id":"s","method":"schema.get","params":{"source":"arg"}}"""));

        Assert.Empty(arm.Requests);
        Assert.Equal("arg", view.GetProperty("source").GetString());
        Assert.Equal("builtIn", view.GetProperty("origin").GetString());
        Assert.Equal(JsonValueKind.Null, view.GetProperty("fallbackReason").ValueKind);
        Assert.Equal(0, view.GetProperty("functions").GetArrayLength());
        var tables = view.GetProperty("tables").EnumerateArray().ToList();
        Assert.Equal(40, tables.Count);
        var resources = tables.Single(t => t.GetProperty("name").GetString() == "Resources");
        Assert.Equal(JsonValueKind.Null, resources.GetProperty("path").ValueKind);
        Assert.Equal(JsonValueKind.Null, resources.GetProperty("area").ValueKind);
        var properties = resources.GetProperty("columns").EnumerateArray().Single(c => c.GetProperty("name").GetString() == "properties");
        Assert.Equal("dynamic", properties.GetProperty("type").GetString());
        Assert.Equal(JsonValueKind.Null, properties.GetProperty("filterable").ValueKind);
    }

    private const string Workspace = "11111111-2222-3333-4444-555555555555";

    private static string Arm(string customerId) =>
        "{\"totalRecords\":1,\"data\":[{\"name\":\"w\",\"resourceId\":\"/r\",\"customerId\":\"" + customerId + "\",\"resourceGroup\":\"rg\",\"subscriptionId\":\"s\",\"location\":\"l\"}]}";

    private static Messaging.Bridge LogsBridge(Stub logs, string? account = "account-1", Stub? arm = null)
    {
        var bridge = new Messaging.Bridge(_ => { });
        new SchemaHandler(GraphSchemaCatalog.Beta, new HuntingSchemaSource(new HttpClient(), TimeProvider.System),
            () => Task.FromResult(account),
            logs: new LogsSchemaSource(new HttpClient(logs) { BaseAddress = new Uri("https://api.loganalytics.azure.com/") },
                new FakeTimeProvider()),
            directory: new ArmDirectory(new HttpClient(arm ?? new Stub(_ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(Arm(Workspace), Encoding.UTF8, "application/json"),
            })), new FakeTimeProvider())).Register(bridge);
        return bridge;
    }

    [Fact]
    public async Task Schema_get_logs_returns_the_workspace_tables_and_functions()
    {
        var logs = new Stub(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"tables":[{"name":"SigninLogs","columns":[{"name":"TimeGenerated","type":"datetime"}]}],"functions":[{"name":"MyFn","parameters":"x:string"}]}""",
                Encoding.UTF8, "application/json"),
        });
        var bridge = LogsBridge(logs);

        var view = Result(await bridge.HandleAsync($$$"""{"id":"s","method":"schema.get","params":{"source":"logs","workspace":"{{{Workspace}}}"}}"""));

        Assert.Equal("account-1", Assert.Single(logs.Requests));
        Assert.Equal("logs", view.GetProperty("source").GetString());
        Assert.Equal("tenant", view.GetProperty("origin").GetString());
        Assert.Equal("SigninLogs", view.GetProperty("tables")[0].GetProperty("name").GetString());
        Assert.Equal("""[{"name":"x","type":"string"}]""", view.GetProperty("functions")[0].GetProperty("parameters").GetRawText());
    }

    [Theory]
    [InlineData("""{"source":"logs"}""", "Pick a workspace to see its tables.")]
    [InlineData("""{"source":"logs","workspace":""}""", "Pick a workspace to see its tables.")]
    [InlineData("""{"source":"logs","workspace":"../x"}""", "../x is not a workspace id.")]
    public async Task Schema_get_logs_without_a_workspace_is_bad_request(string parameters, string message)
    {
        var logs = new Stub(_ => throw new InvalidOperationException("No request is expected."));
        var bridge = LogsBridge(logs);

        var response = await bridge.HandleAsync($$$"""{"id":"s","method":"schema.get","params":{{{parameters}}}}""");

        Assert.NotNull(response);
        using var doc = JsonDocument.Parse(response);
        var error = doc.RootElement.GetProperty("error");
        Assert.Equal("bad_request", error.GetProperty("code").GetString());
        Assert.Equal(message, error.GetProperty("message").GetString());
        Assert.Empty(logs.Requests);
    }

    [Fact]
    public async Task Schema_get_logs_consent_needed_is_its_own_error_code()
    {
        var logs = new Stub(_ => throw new ConsentRequiredException("logs"));

        var response = await LogsBridge(logs).HandleAsync($$$"""{"id":"s","method":"schema.get","params":{"source":"logs","workspace":"{{{Workspace}}}"}}""");

        Assert.NotNull(response);
        using var doc = JsonDocument.Parse(response);
        var error = doc.RootElement.GetProperty("error");
        Assert.Equal("consentNeeded", error.GetProperty("code").GetString());
        Assert.Equal(ConsentRequiredException.LogsMessage, error.GetProperty("message").GetString());
    }

    [Fact]
    public async Task Schema_get_logs_without_an_account_has_no_tables_and_no_request()
    {
        var logs = new Stub(_ => throw new InvalidOperationException("No request is expected."));

        var view = Result(await LogsBridge(logs, account: null).HandleAsync(
            $$$"""{"id":"s","method":"schema.get","params":{"source":"logs","workspace":"{{{Workspace}}}"}}"""));

        Assert.Equal(0, view.GetProperty("tables").GetArrayLength());
        Assert.Equal(SchemaHandler.SignInForWorkspaceSchema, view.GetProperty("fallbackReason").GetString());
        Assert.Empty(logs.Requests);
    }

    [Fact]
    public async Task Schema_get_logs_for_a_workspace_the_account_does_not_list_never_reaches_metadata()
    {
        var logs = new Stub(_ => throw new InvalidOperationException("No request is expected."));
        var arm = new Stub(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(Arm("99999999-0000-0000-0000-000000000000"), Encoding.UTF8, "application/json"),
        });

        var view = Result(await LogsBridge(logs, arm: arm).HandleAsync(
            $$$"""{"id":"s","method":"schema.get","params":{"source":"logs","workspace":"{{{Workspace}}}"}}"""));

        Assert.Equal(0, view.GetProperty("tables").GetArrayLength());
        Assert.Contains("isn't available to this account", view.GetProperty("fallbackReason").GetString());
        Assert.Empty(logs.Requests);
    }

    private static JsonElement Result(string? json)
    {
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetProperty("result").Clone();
    }

    /// <summary>Answers with <c>answer</c> and keeps the account each request was made for.</summary>
    internal sealed class Stub(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<string?> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(GraphRequestAccount.AccountOf(request));
            return Task.FromResult(answer(request));
        }
    }
}
