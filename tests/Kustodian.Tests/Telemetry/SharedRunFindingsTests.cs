using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Telemetry;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Telemetry;

/// <summary>What a Graph run shares when the user opted in: refusals, filters kept local, permission mismatches and limits hit,
/// each with the table's schema path and short codes only, once per session; and nothing when they didn't.</summary>
public sealed class SharedRunFindingsTests : IDisposable
{
    private const string Connection = "InstrumentationKey=key-1;IngestionEndpoint=https://ingest.example/";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 3, 12, 0, 0, TimeSpan.Zero));
    private readonly Recorder _sent = new();
    private readonly HttpClient _http;

    public SharedRunFindingsTests() => _http = new HttpClient(_sent);

    public void Dispose() => _http.Dispose();

    private SharedRunFindings Findings(bool sharing, IReadOnlyList<string>? scopes = null) =>
        new(GraphSchemaCatalog.Beta, GraphLimits.Default, new GraphEngineOptions(), _ => Task.FromResult(sharing),
            new AppInsightsTelemetry(_http, Connection, _time), (_, _) => Task.FromResult(scopes ?? []));

    private static RunResult Result(RunOutcome outcome, params TableFetch[] tables) =>
        new(outcome, null, null, [], [], 0, tables, TimeSpan.Zero);

    private static TableFetch Table(string name, bool perObjectCapped = false) => new(name, [], false, [], [], [], 0, perObjectCapped, 0);

    /// <summary>The events sent, as name and properties, once <paramref name="count"/> have arrived and any more had time to.</summary>
    private async Task<List<(string Name, string Properties)>> SentAsync(int count)
    {
        await _sent.WaitForAsync(count);
        await Task.Delay(50, Ct);
        return [.. _sent.Bodies.Select(b => JsonNode.Parse(b)!.AsArray().Single()!["data"]!["baseData"]!)
            .Select(d => ((string)d["name"]!, d["properties"]!.ToJsonString()))
            .OrderBy(e => e.Item1, StringComparer.Ordinal).ThenBy(e => e.Item2, StringComparer.Ordinal)];
    }

    [Fact]
    public async Task A_run_shares_its_refusal_its_filters_kept_local_and_its_limits_and_nothing_else()
    {
        JsonElement[][] rows = [[JsonSerializer.SerializeToElement("x")]];
        var signIns = Table("auditLogs_signIns", perObjectCapped: true) with
        {
            Local =
            [
                new LocalCondition("userPrincipalName =~ 'alice@contoso.com'", PushdownReasons.CaseInsensitive),
                new LocalCondition("appDisplayName != 'secret'", PushdownReasons.Operator("appDisplayName")),
                new LocalCondition("customAttribute.secret == 'x'", PushdownReasons.Operator("customAttribute.secret")),
                new LocalCondition("riskLevel == 'high'", PushdownReasons.Unlicensed("riskLevel", "Entra ID P2")),
                new LocalCondition("isInteractive", PushdownReasons.NotLeading),
            ],
        };
        var ok = new RunResult(RunOutcome.Ok, null, null, [], rows, 2, [signIns], TimeSpan.Zero);
        var refused = Result(RunOutcome.Failed, Table("applications")) with
        {
            ReadFailure = new RunReadFailure("applications", GraphReadFailure.Failed, 400, "Request_UnsupportedQuery"),
        };
        var findings = Findings(sharing: true);

        await findings.ShareAsync("account-1", ok, Ct);
        await findings.ShareAsync("account-1", refused, Ct);
        var sent = await SentAsync(6);

        Assert.Equal(
            [
                ("GraphLimitHit", """{"path":"auditLogs/signIns","limit":"perObjectReadsPerTable","value":"2000"}"""),
                ("GraphLimitHit", """{"path":"auditLogs/signIns","limit":"rowsPerRun","value":"50000"}"""),
                ("GraphPushdownMiss", """{"path":"auditLogs/signIns","reason":"caseInsensitive"}"""),
                ("GraphPushdownMiss", """{"path":"auditLogs/signIns","reason":"operator","column":"appDisplayName"}"""),
                ("GraphPushdownMiss", """{"path":"auditLogs/signIns","reason":"operator"}"""),
                ("GraphRefusal", """{"path":"applications","status":"400","code":"Request_UnsupportedQuery"}"""),
            ],
            sent);
        Assert.All(_sent.Bodies, b => Assert.DoesNotContain("account-1", b, StringComparison.Ordinal));
        Assert.All(_sent.Bodies, b => Assert.DoesNotContain("secret", b, StringComparison.Ordinal));
        Assert.All(_sent.Bodies, b => Assert.DoesNotContain("riskLevel", b, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_permission_refusal_is_shared_only_when_the_token_holds_a_permission_the_schema_lists()
    {
        var result = Result(RunOutcome.NoPermission, Table("applications")) with
        {
            ReadFailure = new RunReadFailure("applications", GraphReadFailure.NoPermission, 403, "Authorization_RequestDenied"),
            Permissions = ["Application.Read.All", "Directory.Read.All"],
        };

        await Findings(sharing: true, scopes: ["User.Read"]).ShareAsync("account-1", result, Ct);
        await Findings(sharing: true, scopes: ["User.Read", "directory.read.all"]).ShareAsync("account-1", result, Ct);
        var sent = await SentAsync(1);

        Assert.Equal([("GraphPermissionMismatch", """{"path":"applications","permission":"Directory.Read.All"}""")], sent);
    }

    [Fact]
    public async Task Engine_limits_name_every_table_the_run_read()
    {
        var result = Result(RunOutcome.EngineTimeout, Table("users"), Table("applications"));

        await Findings(sharing: true).ShareAsync("account-1", result, Ct);
        var sent = await SentAsync(1);

        Assert.Equal([("GraphLimitHit", """{"path":"applications,users","limit":"engineTimeoutSeconds","value":"120"}""")], sent);
    }

    [Fact]
    public async Task An_event_is_shared_once_per_session()
    {
        var result = Result(RunOutcome.TooLarge, Table("users")) with
        {
            ReadFailure = new RunReadFailure("users", GraphReadFailure.TooManyObjects, null, null),
        };
        var findings = Findings(sharing: true);

        await findings.ShareAsync("account-1", result, Ct);
        await findings.ShareAsync("account-1", result, Ct);
        var sent = await SentAsync(1);

        Assert.Equal([("GraphLimitHit", """{"path":"users","limit":"objectsPerTable","value":"50000"}""")], sent);
    }

    [Fact]
    public async Task Nothing_is_shared_unless_the_user_opted_in()
    {
        var result = Result(RunOutcome.EngineMemory, Table("users"));

        await Findings(sharing: false).ShareAsync("account-1", result, Ct);
        await Task.Delay(100, Ct);

        Assert.Empty(_sent.Bodies);
    }
}
