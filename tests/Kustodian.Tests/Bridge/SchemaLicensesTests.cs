using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Schema;
using Kustodian.Messaging.Handlers;
using Kustodian.Sources.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Bridge;

public class SchemaLicensesTests
{
    private const string Skus = """
        {"value":[{"capabilityStatus":"Enabled","skuPartNumber":"AAD_PREMIUM",
          "servicePlans":[{"servicePlanName":"AAD_PREMIUM","provisioningStatus":"Success","appliesTo":"User"}]}]}
        """;

    private static (Messaging.Bridge Bridge, SchemaHandlerTests.Stub Graph) Host(HttpStatusCode status, string? account = "account-1")
    {
        var graph = new SchemaHandlerTests.Stub(_ => new HttpResponseMessage(status)
        {
            Content = new StringContent(status == HttpStatusCode.OK ? Skus : """{"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges."}}""",
                Encoding.UTF8, "application/json"),
        });
        var time = new FakeTimeProvider();
        var client = new HttpClient(graph) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") };
        var handler = new SchemaHandler(GraphSchemaCatalog.Beta, new HuntingSchemaSource(client, time), () => Task.FromResult(account),
            licenses: new GraphTenantLicenses(client, time));
        var bridge = new Messaging.Bridge(_ => { });
        handler.Register(bridge);
        return (bridge, graph);
    }

    private static async Task<JsonElement> LicensesAsync(Messaging.Bridge bridge, bool refresh = false)
    {
        var json = await bridge.HandleAsync($$$"""{"id":"l","method":"schema.licenses","params":{"source":"graph","refresh":{{{(refresh ? "true" : "false")}}}}}""");
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetProperty("result").Clone();
    }

    [Fact]
    public async Task Tables_and_columns_carry_their_license_and_the_tenants_state()
    {
        var (bridge, graph) = Host(HttpStatusCode.OK);

        var answer = await LicensesAsync(bridge);
        await LicensesAsync(bridge);
        await LicensesAsync(bridge, refresh: true);

        Assert.True(answer.GetProperty("known").GetBoolean());
        Assert.Equal(2, graph.Requests.Count);
        Assert.Equal("account-1", graph.Requests[0]);
        var signIns = answer.GetProperty("tables").GetProperty("auditLogs_signIns");
        Assert.Equal("available", signIns.GetProperty("state").GetString());
        Assert.Equal("Microsoft Entra ID P1 or P2", signIns.GetProperty("license").GetString());
        Assert.StartsWith("https://learn.microsoft.com/", signIns.GetProperty("source").GetString(), StringComparison.Ordinal);
        Assert.Equal("missing", answer.GetProperty("tables").GetProperty("identityProtection_riskyUsers").GetProperty("state").GetString());
        Assert.Equal("available",
            answer.GetProperty("columns").GetProperty("users").GetProperty("signInActivity").GetProperty("state").GetString());
        Assert.False(answer.GetProperty("tables").TryGetProperty("users", out _));
    }

    [Fact]
    public async Task Licenses_that_cannot_be_read_are_unknown()
    {
        var (bridge, _) = Host(HttpStatusCode.Forbidden);

        var answer = await LicensesAsync(bridge);

        Assert.False(answer.GetProperty("known").GetBoolean());
        Assert.Contains("LicenseAssignment.Read.All", answer.GetProperty("reason").GetString(), StringComparison.Ordinal);
        Assert.Equal("unknown", answer.GetProperty("tables").GetProperty("auditLogs_signIns").GetProperty("state").GetString());
    }

    [Fact]
    public async Task Nobody_signed_in_is_unknown_without_a_request()
    {
        var (bridge, graph) = Host(HttpStatusCode.OK, account: null);

        var answer = await LicensesAsync(bridge);

        Assert.False(answer.GetProperty("known").GetBoolean());
        Assert.Equal(SchemaHandler.SignInForLicenses, answer.GetProperty("reason").GetString());
        Assert.Empty(graph.Requests);
    }

    [Fact]
    public async Task Another_source_is_a_bad_request()
    {
        var (bridge, _) = Host(HttpStatusCode.OK);

        var json = await bridge.HandleAsync("""{"id":"l","method":"schema.licenses","params":{"source":"hunting"}}""");

        Assert.Contains("bad_request", json, StringComparison.Ordinal);
    }
}
