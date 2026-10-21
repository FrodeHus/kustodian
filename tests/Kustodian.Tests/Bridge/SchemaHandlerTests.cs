using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Schema;
using Kustodian.Messaging.Handlers;
using Kustodian.Sources.Hunting;
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
        foreach (var graphOnly in new[] { "path", "docsUrl", "permissions" })
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
