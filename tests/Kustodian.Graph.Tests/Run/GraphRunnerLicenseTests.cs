using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Graph.Tests.Run;

/// <summary>Runs with the tenant's licenses: what they lack isn't read.</summary>
public sealed class GraphRunnerLicenseTests
{
    private const string Account = "account-1";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly string WorkerDll = Path.Combine(AppContext.BaseDirectory, "engine-worker", "Kustodian.EngineWorker.dll");

    private sealed class Licenses(TenantLicenses tenant) : ITenantLicenses
    {
        public ValueTask<TenantLicenses> GetAsync(string accountKey, bool refresh, CancellationToken ct) => ValueTask.FromResult(tenant);

        public void RemoveAccount(string accountKey)
        {
        }
    }

    private static async Task<(RunResult Result, FakeGraph Graph)> RunAsync(string kql, TenantLicenses tenant)
    {
        var graph = new FakeGraph
        {
            Answer = (_, _) => Task.FromResult(FakeGraph.Collection([new { id = "1", displayName = "Ada" }])),
        };
        var budget = new GraphFetchBudget(GraphFetchBudget.DefaultMaxBytes);
        await using var engine = new GraphEnginePool(new GraphEngineOptions { Workers = 1, WorkerPath = WorkerDll, WorkerArgs = [] },
            NullLogger<GraphEnginePool>.Instance, TimeProvider.System);
        var runner = new GraphRunner(GraphSchemaCatalog.Beta, graph.Reader(budget), budget, engine, GraphLimits.Default, TimeProvider.System,
            licenses: new Licenses(tenant));
        return (await runner.RunAsync(Account, kql, refresh: false, null, Ct), graph);
    }

    private static TenantLicenses Has(params string[] plans) => new(plans.ToHashSet(StringComparer.OrdinalIgnoreCase));

    [Fact]
    public async Task A_red_column_is_left_out_with_a_notice_naming_it_and_its_license()
    {
        var (result, graph) = await RunAsync("users | project displayName, signInActivity", Has("EXCHANGE_S_STANDARD"));

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.DoesNotContain(graph.Requests, r => r.Contains("signInActivity", StringComparison.Ordinal));
        var left = Assert.Single(Assert.Single(result.Tables).LicenseLeftOut);
        Assert.Equal("signInActivity", left.Column);
        Assert.Equal("Microsoft Entra ID P1 or P2", left.License);
        Assert.Contains(result.Diagnostics, d => d.Detail.Contains("signInActivity (needs Microsoft Entra ID P1 or P2", StringComparison.Ordinal));
        Assert.Equal(["displayName", "signInActivity"], result.Columns.Select(c => c.Name));
    }

    [Fact]
    public async Task A_red_table_is_refused_before_any_request()
    {
        var (result, graph) = await RunAsync("auditLogs_signIns | take 10", Has("EXCHANGE_S_STANDARD"));

        Assert.Equal(RunOutcome.Unlicensed, result.Outcome);
        Assert.Contains("Microsoft Entra ID P1 or P2", result.Message, StringComparison.Ordinal);
        Assert.Empty(graph.Requests);
    }

    [Fact]
    public async Task Unknown_licenses_read_as_before()
    {
        var (result, graph) = await RunAsync("users | project displayName, signInActivity", TenantLicenses.Unknown("no permission"));

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.Contains(graph.Requests, r => r.Contains("signInActivity", StringComparison.Ordinal));
        Assert.Empty(Assert.Single(result.Tables).LicenseLeftOut);
    }

    [Fact]
    public async Task A_licensed_table_and_column_are_read()
    {
        var (result, graph) = await RunAsync("users | project displayName, signInActivity", Has("AAD_PREMIUM"));

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        Assert.Contains(graph.Requests, r => r.Contains("signInActivity", StringComparison.Ordinal));
    }
}
