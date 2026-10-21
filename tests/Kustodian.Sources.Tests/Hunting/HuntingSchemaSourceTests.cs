using System.Net;
using Kustodian.Graph.Fetch;
using Kustodian.Sources.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Sources.Tests.Hunting;

public class HuntingSchemaSourceTests
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero));

    private static StubGraph Tenant() => new(_ => StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("hunting-schema-200.json")));

    [Fact]
    public async Task Hunting_schema_from_tenant_with_functions()
    {
        var graph = Tenant();
        var source = new HuntingSchemaSource(graph.Client(), _time);

        var view = await source.GetAsync("account-1", false, TestContext.Current.CancellationToken);

        var seen = Assert.Single(graph.Seen);
        Assert.Equal(HttpMethod.Get, seen.Method);
        Assert.Equal("https://graph.microsoft.com/beta/security/getHuntingSchema", seen.Uri!.AbsoluteUri);
        Assert.Equal("account-1", seen.Options.TryGetValue(GraphRequestAccount.Key, out var account) ? account : null);
        Assert.Equal("tenant", view.Origin);
        Assert.Null(view.FallbackReason);
        Assert.Equal(_time.GetUtcNow(), view.RetrievedAt);
        Assert.Equal(["DeviceProcessEvents", "DeviceNetworkEvents"], view.Tables.Select(t => t.Name));
        var processes = view.Tables[0];
        Assert.Equal("Process creation and related events", processes.Description);
        Assert.Equal(new HuntingColumn("Timestamp", "datetime", "Date and time when the record was generated"), processes.Columns[0]);
        Assert.Equal("string", processes.Columns[1].Type);
        Assert.Equal(["FileProfile", "MyCustomQuery"], view.Functions.Select(f => f.Name));
        Assert.Equal("Enriches query results with file information such as file name, size, and hash.", view.Functions[0].Description);
        Assert.Equal([new HuntingParameter("SHA1", "string")], view.Functions[0].Parameters);
        Assert.Equal("A custom query that filters device events by severity.", view.Functions[1].Description);
        Assert.Empty(view.Functions[1].Parameters);
    }

    [Fact]
    public async Task Hunting_schema_falls_back_to_builtin_with_reason()
    {
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.Forbidden,
            """{"error":{"code":"Forbidden","message":"The user has no Defender role."}}"""));
        var source = new HuntingSchemaSource(graph.Client(), _time);

        var view = await source.GetAsync("account-1", false, TestContext.Current.CancellationToken);

        Assert.Equal("builtIn", view.Origin);
        Assert.Equal("The tenant's schema couldn't be read (The user has no Defender role.). The built-in schema is shown.", view.FallbackReason);
        Assert.Equal(66, view.Tables.Count);
        Assert.Equal(4, view.Functions.Count);

        // The failure stands for 10 minutes, then the tenant is asked again.
        _time.Advance(TimeSpan.FromMinutes(9));
        await source.GetAsync("account-1", false, TestContext.Current.CancellationToken);
        Assert.Single(graph.Seen);
        _time.Advance(TimeSpan.FromMinutes(1));
        await source.GetAsync("account-1", false, TestContext.Current.CancellationToken);
        Assert.Equal(2, graph.Seen.Count);
    }

    [Fact]
    public async Task Hunting_schema_with_no_tables_falls_back()
    {
        var graph = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, """{"tables":[],"functions":{}}"""));

        var view = await new HuntingSchemaSource(graph.Client(), _time).GetAsync("account-1", false, TestContext.Current.CancellationToken);

        Assert.Equal("builtIn", view.Origin);
        Assert.Equal("The tenant's schema has no tables. The built-in schema is shown.", view.FallbackReason);
    }

    [Fact]
    public async Task Hunting_schema_cached_24h_per_account()
    {
        var graph = Tenant();
        var source = new HuntingSchemaSource(graph.Client(), _time);
        var ct = TestContext.Current.CancellationToken;

        var first = await source.GetAsync("account-1", false, ct);
        _time.Advance(TimeSpan.FromHours(23));
        var again = await source.GetAsync("account-1", false, ct);
        Assert.Same(first, again);
        Assert.Single(graph.Seen);

        await source.GetAsync("account-2", false, ct);
        Assert.Equal(2, graph.Seen.Count);
        Assert.Equal("account-2", graph.Seen[1].Options.TryGetValue(GraphRequestAccount.Key, out var account) ? account : null);

        _time.Advance(TimeSpan.FromHours(1));
        await source.GetAsync("account-1", false, ct);
        Assert.Equal(3, graph.Seen.Count);
    }

    [Fact]
    public async Task Hunting_schema_refresh_bypasses_cache()
    {
        var graph = Tenant();
        var source = new HuntingSchemaSource(graph.Client(), _time);
        var ct = TestContext.Current.CancellationToken;

        await source.GetAsync("account-1", false, ct);
        await source.GetAsync("account-1", true, ct);
        await source.GetAsync("account-1", false, ct);

        Assert.Equal(2, graph.Seen.Count);
    }

    [Fact]
    public async Task Hunting_schema_failed_refresh_keeps_the_tenant_schema_and_says_why()
    {
        var failing = false;
        var graph = new StubGraph(_ => failing
            ? StubGraph.Json(HttpStatusCode.ServiceUnavailable, """{"error":{"code":"ServiceUnavailable","message":"Defender is busy."}}""")
            : StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("hunting-schema-200.json")));
        var source = new HuntingSchemaSource(graph.Client(), _time);
        var ct = TestContext.Current.CancellationToken;
        var read = await source.GetAsync("account-1", false, ct);
        failing = true;
        _time.Advance(TimeSpan.FromHours(1));

        var refreshed = await source.GetAsync("account-1", true, ct);

        Assert.Equal("tenant", refreshed.Origin);
        Assert.Equal(read.Tables, refreshed.Tables);
        Assert.Equal(read.RetrievedAt, refreshed.RetrievedAt);
        Assert.Equal("The tenant's schema couldn't be refreshed (Defender is busy.). The schema read earlier is shown.", refreshed.FallbackReason);

        // The tenant's schema stays cached as it was read.
        var later = await source.GetAsync("account-1", false, ct);
        Assert.Same(read, later);
        Assert.Equal(2, graph.Seen.Count);
    }

    [Fact]
    public async Task Hunting_schema_failed_reread_after_a_day_keeps_the_tenant_schema()
    {
        var failing = false;
        var graph = new StubGraph(_ => failing
            ? StubGraph.Json(HttpStatusCode.Forbidden, """{"error":{"code":"Forbidden","message":"No role."}}""")
            : StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("hunting-schema-200.json")));
        var source = new HuntingSchemaSource(graph.Client(), _time);
        var ct = TestContext.Current.CancellationToken;
        var read = await source.GetAsync("account-1", false, ct);
        failing = true;
        _time.Advance(TimeSpan.FromHours(25));

        var again = await source.GetAsync("account-1", false, ct);

        Assert.Equal(("tenant", read.Tables.Count), (again.Origin, again.Tables.Count));
        Assert.Equal("The tenant's schema couldn't be refreshed (No role.). The schema read earlier is shown.", again.FallbackReason);
        // As with a failed first read, Graph isn't asked again for 10 minutes.
        _time.Advance(TimeSpan.FromMinutes(9));
        await source.GetAsync("account-1", false, ct);
        Assert.Equal(2, graph.Seen.Count);
        _time.Advance(TimeSpan.FromMinutes(1));
        await source.GetAsync("account-1", false, ct);
        Assert.Equal(3, graph.Seen.Count);
    }

    [Fact]
    public async Task Hunting_schema_removing_an_account_drops_its_cache_only()
    {
        var graph = Tenant();
        var source = new HuntingSchemaSource(graph.Client(), _time);
        var ct = TestContext.Current.CancellationToken;
        await source.GetAsync("account-1", false, ct);
        await source.GetAsync("account-2", false, ct);

        source.RemoveAccount("account-1");
        await source.GetAsync("account-1", false, ct);
        await source.GetAsync("account-2", false, ct);

        Assert.Equal(["account-1", "account-2", "account-1"],
            graph.Seen.Select(s => s.Options.TryGetValue(GraphRequestAccount.Key, out var account) ? account : null));
    }

    [Fact]
    public async Task Hunting_schema_cancellation_is_not_recorded_as_a_failure()
    {
        var graph = Tenant();
        var source = new HuntingSchemaSource(graph.Client(), _time);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => source.GetAsync("account-1", false, cts.Token));
        var view = await source.GetAsync("account-1", false, TestContext.Current.CancellationToken);

        Assert.Equal("tenant", view.Origin);
    }

    [Fact]
    public void Builtin_hunting_schema_has_66_tables_and_4_functions()
    {
        Assert.Equal(66, BuiltInHuntingSchema.Tables.Count);
        Assert.Equal(4, BuiltInHuntingSchema.Functions.Count);
        Assert.Equal(["AssignedIPAddresses", "DeviceFromIP", "FileProfile", "SeenBy"], BuiltInHuntingSchema.Functions.Select(f => f.Name));
        Assert.Contains(BuiltInHuntingSchema.Tables, t => t.Name == "DeviceProcessEvents" && t.Columns.Count > 0);
        Assert.Equal([new HuntingParameter("SHA1", "string"), new("limit", "long")],
            BuiltInHuntingSchema.Functions.Single(f => f.Name == "FileProfile").Parameters);
    }
}
