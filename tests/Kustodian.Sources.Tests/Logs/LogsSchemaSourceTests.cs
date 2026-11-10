using System.Net;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Sources.Hunting;
using Kustodian.Sources.Logs;
using Kustodian.Sources.Tests.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Sources.Tests.Logs;

public class LogsSchemaSourceTests
{
    private const string Workspace = "11111111-2222-3333-4444-555555555555";
    private const string Other = "66666666-7777-8888-9999-000000000000";

    private const string Metadata = """
        {"tables":[{"name":"SigninLogs","description":"Sign-ins","columns":[{"name":"TimeGenerated","type":"datetime"}]}],
         "functions":[{"name":"MyFn","body":"SigninLogs | take 1","parameters":"x:string"},{"name":"NoArgs","body":"print 1","parameters":""}]}
        """;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 10, 8, 0, 0, TimeSpan.Zero));

    private static HttpClient Client(StubGraph stub) =>
        new(stub, disposeHandler: false) { BaseAddress = new Uri("https://api.loganalytics.azure.com/") };

    private static StubGraph Ok() => new(_ => StubGraph.Json(HttpStatusCode.OK, Metadata));

    private static StubGraph Refused() =>
        new(_ => StubGraph.Json(HttpStatusCode.BadRequest, """{"error":{"code":"BadRequest","message":"Nope."}}"""));

    [Fact]
    public async Task Reads_tables_columns_and_functions()
    {
        var logs = Ok();

        var view = await new LogsSchemaSource(Client(logs), _time).GetAsync("account-1", Workspace, false, TestContext.Current.CancellationToken);

        var seen = Assert.Single(logs.Seen);
        Assert.Equal(HttpMethod.Get, seen.Method);
        Assert.Equal($"https://api.loganalytics.azure.com/v1/workspaces/{Workspace}/metadata", seen.Uri!.AbsoluteUri);
        Assert.Equal("tenant", view.Origin);
        Assert.Null(view.FallbackReason);
        var table = Assert.Single(view.Tables);
        Assert.Equal(new HuntingColumn("TimeGenerated", "datetime", ""), Assert.Single(table.Columns));
        Assert.Equal(["MyFn", "NoArgs"], view.Functions.Select(f => f.Name));
        Assert.Equal([new HuntingParameter("x", "string")], view.Functions[0].Parameters);
        Assert.Empty(view.Functions[1].Parameters);
    }

    [Fact]
    public async Task Cached_24_hours_per_account_and_workspace()
    {
        var logs = Ok();
        var source = new LogsSchemaSource(Client(logs), _time);
        var ct = TestContext.Current.CancellationToken;

        await source.GetAsync("account-1", Workspace, false, ct);
        await source.GetAsync("account-1", Workspace.ToUpperInvariant(), false, ct);
        Assert.Single(logs.Seen);
        await source.GetAsync("account-1", Other, false, ct);
        await source.GetAsync("account-2", Workspace, false, ct);
        Assert.Equal(3, logs.Seen.Count);

        source.RemoveAccount("account-1");
        await source.GetAsync("account-1", Workspace, false, ct);
        await source.GetAsync("account-2", Workspace, false, ct);
        Assert.Equal(4, logs.Seen.Count);

        _time.Advance(TimeSpan.FromHours(24));
        await source.GetAsync("account-1", Workspace, false, ct);
        Assert.Equal(5, logs.Seen.Count);
    }

    [Fact]
    public async Task A_failure_keeps_the_last_good_schema()
    {
        var fail = false;
        var logs = new StubGraph(_ => fail ? StubGraph.Json(HttpStatusCode.BadRequest, """{"error":{"code":"BadRequest","message":"Nope."}}""")
            : StubGraph.Json(HttpStatusCode.OK, Metadata));
        var source = new LogsSchemaSource(Client(logs), _time);
        var ct = TestContext.Current.CancellationToken;
        await source.GetAsync("account-1", Workspace, false, ct);

        fail = true;
        var view = await source.GetAsync("account-1", Workspace, true, ct);

        Assert.Equal("tenant", view.Origin);
        Assert.Single(view.Tables);
        Assert.Contains("Nope.", view.FallbackReason);
        Assert.Equal(2, logs.Seen.Count);

        // A refresh that fails leaves the cache as it was: the 24 hours stand.
        await source.GetAsync("account-1", Workspace, false, ct);
        Assert.Equal(2, logs.Seen.Count);

        // Once out of date, a failed read is not tried again for 10 minutes.
        _time.Advance(TimeSpan.FromHours(24));
        await source.GetAsync("account-1", Workspace, false, ct);
        _time.Advance(TimeSpan.FromMinutes(9));
        var again = await source.GetAsync("account-1", Workspace, false, ct);
        Assert.Equal(3, logs.Seen.Count);
        Assert.Single(again.Tables);
        _time.Advance(TimeSpan.FromMinutes(1));
        await source.GetAsync("account-1", Workspace, false, ct);
        Assert.Equal(4, logs.Seen.Count);
    }

    [Fact]
    public async Task A_failure_with_nothing_read_before_has_no_tables_and_the_reason()
    {
        var logs = Refused();
        var source = new LogsSchemaSource(Client(logs), _time);
        var ct = TestContext.Current.CancellationToken;

        var view = await source.GetAsync("account-1", Workspace, false, ct);

        Assert.Equal("tenant", view.Origin);
        Assert.Empty(view.Tables);
        Assert.Empty(view.Functions);
        Assert.Contains("Nope.", view.FallbackReason);
        _time.Advance(TimeSpan.FromMinutes(9));
        await source.GetAsync("account-1", Workspace, false, ct);
        Assert.Single(logs.Seen);
        _time.Advance(TimeSpan.FromMinutes(1));
        await source.GetAsync("account-1", Workspace, false, ct);
        Assert.Equal(2, logs.Seen.Count);
    }

    [Fact]
    public async Task Consent_propagates()
    {
        var logs = new StubGraph(_ => throw new ConsentRequiredException("logs"));
        var source = new LogsSchemaSource(Client(logs), _time);

        var ex = await Assert.ThrowsAsync<ConsentRequiredException>(() =>
            source.GetAsync("account-1", Workspace, false, TestContext.Current.CancellationToken));

        Assert.Equal("logs", ex.Audience);
    }

    [Fact]
    public async Task A_non_guid_never_reaches_a_request()
    {
        var logs = Ok();

        await Assert.ThrowsAsync<ArgumentException>(() => new LogsSchemaSource(Client(logs), _time)
            .GetAsync("account-1", "../x", false, TestContext.Current.CancellationToken));

        Assert.Empty(logs.Seen);
    }
}
