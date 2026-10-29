using System.Net;
using System.Text;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Graph.Tests.Run;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Graph.Tests;

public sealed partial class GraphCollectionReaderTests
{
    private const string Account = "account-1";

    private sealed class Scripted(Func<HttpRequestMessage, int, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return Task.FromResult(respond(request, Calls++));
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body, int? retryAfter = null)
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (retryAfter is { } r)
            response.Headers.RetryAfter = new(TimeSpan.FromSeconds(r));
        return response;
    }

    private static string Page(int from, int count, string? next = null)
    {
        var items = string.Join(",", Enumerable.Range(from, count).Select(i => "{\"id\":\"" + i + "\"}"));
        var link = next is null ? "" : "\"@odata.nextLink\":\"" + next + "\",";
        return "{" + link + "\"value\":[" + items + "]}";
    }

    private static string Error(string code, string message) => "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + message + "\"}}";

    private static GraphFetch Fetch(string[]? select = null, string? filter = null)
        => new(new GraphTable("applications", "applications", "microsoft.graph.application", "", "https://learn.microsoft.com/x", []),
            select ?? ["id", "displayName"], filter);

    private static GraphCollectionReader Reader(HttpMessageHandler handler, GraphFetchBudget? budget = null, IGraphProbeCache? probes = null,
        TimeProvider? time = null)
        => new(new HttpClient(handler) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") }, budget ?? new GraphFetchBudget(),
            NoGraphObjectCache.Instance, GraphLimits.Default, probes, time ?? new InstantTime());

    private static Task<GraphCollection> Read(GraphCollectionReader reader, GraphFetch fetch, GraphFetchLease? lease = null,
        bool refresh = false, RunDiagnostics? diagnostics = null)
        => reader.ReadAsync(Account, fetch, lease ?? new GraphFetchBudget().Lease(), refresh, diagnostics,
            CancellationToken.None);

    private static async Task<GraphReadException> Fails(Task<GraphCollection> read)
        => await Assert.ThrowsAsync<GraphReadException>(() => read);

    private const string Next = "https://graph.microsoft.com/beta/applications?$skiptoken=";

    [Fact]
    public async Task Follows_next_links_and_sends_select_filter_top()
    {
        var handler = new Scripted((_, n) => Json(HttpStatusCode.OK, n switch
        {
            0 => Page(0, 2, Next + "a"),
            1 => Page(2, 2, Next + "b"),
            _ => Page(4, 1),
        }));

        var result = await Read(Reader(handler), Fetch(filter: "accountEnabled eq true"));

        Assert.Equal(5, result.Objects.Count);
        Assert.Equal(3, result.Requests.Count);
        Assert.StartsWith("applications?$select=", result.Requests[0]);
        Assert.Contains("$top=999", result.Requests[0]);
        Assert.Contains("$filter=" + Uri.EscapeDataString("accountEnabled eq true"), result.Requests[0]);
        Assert.False(result.Unfiltered);
        Assert.Empty(result.Unreadable);
    }

    [Fact]
    public async Task A_row_limit_sends_top_and_stops_after_one_page()
    {
        var handler = new Scripted((_, n) => Json(HttpStatusCode.OK, Page(n * 10, 10, Next + n)));
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        var result = await Read(Reader(handler), Fetch() with { Top = 10 }, diagnostics: diagnostics);

        Assert.Equal(1, handler.Calls);
        Assert.EndsWith("&$top=10", result.Requests.Single(), StringComparison.Ordinal);
        Assert.Equal(10, result.Objects.Count);
        Assert.Contains("applications: stopped after 10 objects (the query takes 10)", OfKind(diagnostics, DiagnosticKinds.Request).Select(e => e.Detail));
    }

    [Fact]
    public async Task A_row_limit_with_a_pushed_filter_sends_both_and_stops_after_one_page()
    {
        var handler = new Scripted((_, n) => Json(HttpStatusCode.OK, Page(n * 10, 10, Next + n)));

        var result = await Read(Reader(handler), Fetch(filter: "accountEnabled eq true") with { Top = 10 });

        Assert.Equal(1, handler.Calls);
        Assert.Contains("$filter=" + Uri.EscapeDataString("accountEnabled eq true"), result.Requests[0]);
        Assert.EndsWith("&$top=10", result.Requests[0], StringComparison.Ordinal);
        Assert.Equal(10, result.Objects.Count);
    }

    // Graph doesn't always honour $top: no more than the limit is kept either way.
    [Fact]
    public async Task A_row_limit_keeps_no_more_objects_than_it_asked_for()
    {
        var handler = new Scripted((_, n) => Json(HttpStatusCode.OK, Page(n * 100, 100, Next + n)));

        var result = await Read(Reader(handler), Fetch() with { Top = 10 });

        Assert.Equal(1, handler.Calls);
        Assert.Equal(Enumerable.Range(0, 10).Select(i => i.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            result.Objects.Select(o => (string)o["id"]!));
    }

    [Fact]
    public async Task A_row_limit_over_a_page_reads_pages_until_it_has_enough()
    {
        var handler = new Scripted((_, n) => Json(HttpStatusCode.OK, Page(n * 999, 999, Next + n)));

        var result = await Read(Reader(handler), Fetch() with { Top = 1500 });

        Assert.Equal(2, handler.Calls);
        Assert.EndsWith("&$top=999", result.Requests[0], StringComparison.Ordinal);
        Assert.Equal(1500, result.Objects.Count);
    }

    [Fact]
    public async Task A_row_limit_reads_every_page_when_graph_refuses_the_filter()
    {
        var handler = new Scripted((r, n) => r.RequestUri!.Query.Contains("$filter")
            ? Json(HttpStatusCode.BadRequest, Error("Request_UnsupportedQuery", "Unsupported or invalid query filter clause."))
            : Json(HttpStatusCode.OK, n < 3 ? Page(n * 10, 10, Next + n) : Page(30, 5)));

        var result = await Read(Reader(handler), Fetch(filter: "accountEnabled eq true") with { Top = 10 });

        // Unfiltered, the first rows aren't the query's: the where runs locally over the whole collection.
        Assert.True(result.Unfiltered);
        Assert.EndsWith("&$top=999", result.Requests[1], StringComparison.Ordinal);
        Assert.Equal(4, result.Requests.Count);
    }

    private static HttpResponseMessage RefusesTop(HttpRequestMessage request, int n) => request.RequestUri!.Query.Contains("$top")
        ? Json(HttpStatusCode.BadRequest, Error("BadRequest",
            "The query specified in the URI is not valid. Query option 'Top' is not allowed. To allow it, set the 'AllowedQueryOptions' property."))
        : Json(HttpStatusCode.OK, Page(n * 20, 20, Next + n));

    [Fact]
    public async Task A_top_refusal_reads_again_without_it_still_stops_early_and_is_remembered()
    {
        var probes = await ListingEverything();
        var handler = new Scripted(RefusesTop);
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        var result = await Read(Reader(handler, probes: probes), Fetch(filter: "accountEnabled eq true") with { Top = 10 },
            diagnostics: diagnostics);

        Assert.Equal(2, result.Requests.Count);
        Assert.DoesNotContain("$top", result.Requests[1]);
        Assert.Contains("$filter=", result.Requests[1]);
        Assert.False(result.Unfiltered);
        Assert.Equal(10, result.Objects.Count);
        Assert.Contains("applications: Graph refused $top; reading without it", OfKind(diagnostics, DiagnosticKinds.Probe).Select(e => e.Detail));
        Assert.True(await probes.RefusesTopAsync(Account, "applications", CancellationToken.None));

        var again = new Scripted(RefusesTop);
        var second = await Read(Reader(again, probes: probes), Fetch() with { Top = 10 });

        Assert.Equal(1, again.Calls);
        Assert.DoesNotContain("$top", second.Requests.Single());
        Assert.Equal(10, second.Objects.Count);
    }

    private static HttpResponseMessage RefusesSelect(HttpRequestMessage request, int n) => request.RequestUri!.Query.Contains("$select")
        ? Json(HttpStatusCode.BadRequest, Error("BadRequest",
            "Query option 'Select' is not allowed. To allow it, set the 'AllowedQueryOptions' property on EnableQueryAttribute or QueryValidationSettings."))
        : Json(HttpStatusCode.OK, Page(n * 20, 20));

    // reports/appCredentialSignInActivities and other reports refuse $select itself: not a property to probe for.
    [Fact]
    public async Task A_select_refusal_reads_again_without_it_and_is_remembered()
    {
        var probes = await ListingEverything();
        var handler = new Scripted(RefusesSelect);
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        var result = await Read(Reader(handler, probes: probes), Fetch() with { Top = 10 }, diagnostics: diagnostics);

        Assert.Equal(2, result.Requests.Count);
        Assert.Equal("applications?$top=10", result.Requests[1]);
        Assert.Equal(10, result.Objects.Count);
        Assert.Contains("applications: Graph refused $select; reading the columns it sends by default",
            OfKind(diagnostics, DiagnosticKinds.Probe).Select(e => e.Detail));
        Assert.Contains(GraphCollectionReader.SelectClause, await probes.RefusedAsync(Account, "applications", CancellationToken.None));

        var again = new Scripted(RefusesSelect);
        var second = await Read(Reader(again, probes: probes), Fetch() with { Top = 10 });

        Assert.Equal(1, again.Calls);
        Assert.Equal("applications?$top=10", second.Requests.Single());

        // A refresh selects again, and forgets the refusal once Graph takes it.
        var takes = new Scripted((_, n) => Json(HttpStatusCode.OK, Page(n * 20, 20)));
        var refreshed = await Read(Reader(takes, probes: probes), Fetch() with { Top = 10 }, refresh: true);

        Assert.Contains("$select=", refreshed.Requests[^1]);
        Assert.DoesNotContain(GraphCollectionReader.SelectClause, await probes.RefusedAsync(Account, "applications", CancellationToken.None));
    }

    // Refused for $top=999 as well: a read without a row limit leaves it out too.
    [Fact]
    public async Task A_top_refusal_without_a_row_limit_reads_every_page_without_it()
    {
        var probes = await ListingEverything();
        var handler = new Scripted((r, n) => r.RequestUri!.Query.Contains("$top") ? RefusesTop(r, n)
            : Json(HttpStatusCode.OK, n < 4 ? Page(n * 20, 20, Next + n) : Page(80, 5)));

        var result = await Read(Reader(handler, probes: probes), Fetch());

        Assert.Equal(65, result.Objects.Count);
        Assert.All(result.Requests.Skip(1), r => Assert.DoesNotContain("$top", r));
        Assert.True(await probes.RefusesTopAsync(Account, "applications", CancellationToken.None));
    }

    // directoryRoles refuses any page size without naming $top.
    [Fact]
    public async Task A_page_size_refusal_reads_every_page_without_top()
    {
        var probes = await ListingEverything();
        var handler = new Scripted((r, n) => r.RequestUri!.Query.Contains("$top")
            ? Json(HttpStatusCode.BadRequest, Error("Request_BadRequest",
                "This resource does not support custom page sizes. Please retry without a page size argument."))
            : Json(HttpStatusCode.OK, n < 3 ? Page((n - 1) * 20, 20, Next + n) : Page(40, 3)));

        var result = await Read(Reader(handler, probes: probes), Fetch());

        Assert.Equal(43, result.Objects.Count);
        Assert.All(result.Requests.Skip(1), r => Assert.DoesNotContain("$top", r));
        Assert.True(await probes.RefusesTopAsync(Account, "applications", CancellationToken.None));
    }

    [Fact]
    public async Task Refresh_sends_a_refused_top_again_and_forgets_the_refusal_when_graph_takes_it()
    {
        var probes = await ListingEverything();
        await probes.SetRefusesTopAsync(Account, "applications", true, CancellationToken.None);
        var handler = new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 10)));

        var result = await Read(Reader(handler, probes: probes), Fetch() with { Top = 10 }, refresh: true);

        Assert.EndsWith("&$top=10", result.Requests.Last(), StringComparison.Ordinal);
        Assert.False(await probes.RefusesTopAsync(Account, "applications", CancellationToken.None));
    }

    [Fact]
    public async Task Encodes_the_whole_filter_and_select()
    {
        const string filter = "startsWith(displayName,'a&b#c+d%') and displayName ne 'it''s'";
        var result = await Read(Reader(new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 1)))), Fetch(["id", "a b"], filter));

        var query = result.Requests[0][(result.Requests[0].IndexOf('?') + 1)..];
        var parts = query.Split('&').ToDictionary(p => p[..p.IndexOf('=')], p => Uri.UnescapeDataString(p[(p.IndexOf('=') + 1)..]));
        Assert.Equal(filter, parts["$filter"]);
        Assert.Equal("id,a b", parts["$select"]);
        Assert.Equal(3, parts.Count);
    }

    // Stopping at such a link would pass the first page off as the whole collection; following it would send the token there.
    [Theory]
    [InlineData("https://evil.example/applications?x=1")]
    [InlineData("http://graph.microsoft.com/beta/applications?$skiptoken=2")]
    [InlineData("https://graph.microsoft.com.evil.example/beta/applications?$skiptoken=2")]
    public async Task Fails_on_next_links_to_other_hosts_without_following_them(string link)
    {
        var handler = new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 2, link)));

        var ex = await Fails(Read(Reader(handler), Fetch()));

        Assert.Equal(GraphReadFailure.Failed, ex.Failure);
        Assert.Equal("Graph returned a next page link to another host; the results would be incomplete.", ex.Message);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task Stops_at_the_object_budget_with_the_spec_message()
    {
        var handler = new Scripted((_, n) => Json(HttpStatusCode.OK, n < 5 ? Page(n * 10_000, 10_000, Next + n) : Page(50_000, 1)));

        var ex = await Fails(Read(Reader(handler), Fetch()));

        Assert.Equal(GraphReadFailure.TooManyObjects, ex.Failure);
        Assert.Equal("applications has more than 50,000 objects. Add a `where` Graph can filter on (see the schema list).", ex.Message);
    }

    [Fact]
    public async Task Stops_at_the_byte_budget()
    {
        var budget = new GraphFetchBudget(maxBytes: 3 * 1024);
        using var lease = budget.Lease();
        var handler = new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 500)));

        var ex = await Fails(Read(Reader(handler, budget), Fetch(), lease));

        Assert.Equal(GraphReadFailure.TooLarge, ex.Failure);
    }

    [Fact]
    public async Task Waits_then_fails_busy_when_the_process_budget_is_full()
    {
        var budget = new GraphFetchBudget(maxBytes: 3 * 1024, patience: TimeSpan.FromMilliseconds(50));
        using var holder = budget.Lease();
        await holder.AddAsync(1024, CancellationToken.None);
        using var lease = budget.Lease();
        var handler = new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 5)));

        var ex = await Fails(Read(Reader(handler, budget), Fetch(), lease));

        Assert.Equal(GraphReadFailure.Busy, ex.Failure);
        Assert.Equal("Other queries are fetching from Graph. Try again when they finish.", ex.Message);
    }

    [Fact]
    public async Task A_waiting_lease_proceeds_when_room_is_returned()
    {
        var budget = new GraphFetchBudget(maxBytes: 3 * 1024, patience: TimeSpan.FromSeconds(5));
        var holder = budget.Lease();
        await holder.AddAsync(1024, CancellationToken.None);
        using var lease = budget.Lease();

        var waiting = lease.AddAsync(512, CancellationToken.None);
        Assert.False(waiting.IsCompleted);
        holder.Dispose();
        await waiting;
    }

    [Fact]
    public async Task Process_budget_counts_the_estimated_in_memory_size()
    {
        // Raw bytes, their DOM and the engine frame's copy: three times the bytes Graph sent.
        var budget = new GraphFetchBudget(maxBytes: 3000, patience: TimeSpan.FromMilliseconds(50));
        using var first = budget.Lease();
        await first.AddAsync(1000, CancellationToken.None);
        using var second = budget.Lease();

        Assert.Equal(3000, budget.Used);
        var ex = await Assert.ThrowsAsync<GraphReadException>(() => second.AddAsync(1, CancellationToken.None));
        Assert.Equal(GraphReadFailure.Busy, ex.Failure);
    }

    [Fact]
    public async Task Lease_maximum_counts_the_raw_bytes()
    {
        var budget = new GraphFetchBudget(maxBytes: 3000);
        using var lease = budget.Lease();

        await lease.AddAsync(1000, CancellationToken.None);

        var ex = await Assert.ThrowsAsync<GraphReadException>(() => lease.AddAsync(1, CancellationToken.None));
        Assert.Equal(GraphReadFailure.TooLarge, ex.Failure);
    }

    [Fact]
    public async Task Default_process_budget_is_512_MB_estimated()
    {
        var budget = new GraphFetchBudget(patience: TimeSpan.FromMilliseconds(50));
        using var first = budget.Lease();
        await first.AddAsync(170L << 20, CancellationToken.None);
        using var second = budget.Lease();

        Assert.Equal(510L << 20, budget.Used);
        var ex = await Assert.ThrowsAsync<GraphReadException>(() => second.AddAsync(1L << 20, CancellationToken.None));
        Assert.Equal(GraphReadFailure.Busy, ex.Failure);   // the other lease holds the budget
    }

    [Fact]
    public async Task A_lone_run_past_a_third_of_the_process_budget_is_too_large_at_once()
    {
        // The defaults: 512 MB estimated is 170 MB as Graph sent it. Never a wait on its own lease that ends Busy.
        var budget = new GraphFetchBudget();
        using var lease = budget.Lease();
        await lease.AddAsync(170L << 20, CancellationToken.None);
        var clock = System.Diagnostics.Stopwatch.StartNew();

        var ex = await Assert.ThrowsAsync<GraphReadException>(() => lease.AddAsync(1L << 20, CancellationToken.None));

        Assert.Equal(GraphReadFailure.TooLarge, ex.Failure);
        Assert.StartsWith("Graph returned more than 170 MB for this query.", ex.Message);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(1), $"It waited {clock.Elapsed}.");
    }

    [Fact]
    public async Task A_page_whose_estimate_alone_is_over_the_process_budget_is_too_large_at_once()
    {
        var budget = new GraphFetchBudget(maxBytes: 3000);
        using var lease = budget.Lease();

        var ex = await Assert.ThrowsAsync<GraphReadException>(() => lease.AddAsync(1001, CancellationToken.None));

        Assert.Equal(GraphReadFailure.TooLarge, ex.Failure);
        Assert.Equal(0, budget.Used);
    }

    [Fact]
    public async Task Two_leases_contending_get_busy_only_while_the_other_holds_the_budget()
    {
        var budget = new GraphFetchBudget(maxBytes: 3000, patience: TimeSpan.FromMilliseconds(50));
        using var first = budget.Lease();
        await first.AddAsync(600, CancellationToken.None);
        using var second = budget.Lease();

        var ex = await Assert.ThrowsAsync<GraphReadException>(() => second.AddAsync(600, CancellationToken.None));
        Assert.Equal(GraphReadFailure.Busy, ex.Failure);

        first.Dispose();
        await second.AddAsync(600, CancellationToken.None);
        Assert.Equal(1800, budget.Used);
    }

    [Fact]
    public async Task Dispose_returns_the_bytes()
    {
        var budget = new GraphFetchBudget(maxBytes: 3 * 1024, patience: TimeSpan.FromMilliseconds(50));
        var first = budget.Lease();
        await first.AddAsync(1024, CancellationToken.None);
        first.Dispose();
        using var second = budget.Lease();

        await second.AddAsync(1024, CancellationToken.None);
    }

    [Fact]
    public async Task Filter_rejected_with_400_refetches_without_it()
    {
        var handler = new Scripted((r, _) => r.RequestUri!.Query.Contains("$filter")
            ? Json(HttpStatusCode.BadRequest, Error("Request_UnsupportedQuery", "Unsupported or invalid query filter clause."))
            : Json(HttpStatusCode.OK, Page(0, 3)));

        var result = await Read(Reader(handler), Fetch(filter: "accountEnabled eq true"));

        Assert.True(result.Unfiltered);
        Assert.Equal(3, result.Objects.Count);
        Assert.Equal(2, result.Requests.Count);
        Assert.DoesNotContain("$filter", result.Requests[1]);
    }

    [Fact]
    public async Task Filter_refusal_naming_a_selected_property_drops_the_filter_not_the_column()
    {
        // Graph's real message for a filter it won't run names the property, which is also selected.
        var handler = new Scripted((r, _) => r.RequestUri!.Query.Contains("$filter")
            ? Json(HttpStatusCode.BadRequest, Error("Request_UnsupportedQuery",
                "Unsupported or invalid query filter clause specified for property 'createdDateTime' of resource 'User'."))
            : Json(HttpStatusCode.OK, Page(0, 2)));

        var result = await Read(Reader(handler), Fetch(["id", "createdDateTime"], "createdDateTime ge 2026-01-01T00:00:00Z"));

        Assert.True(result.Unfiltered);
        Assert.Empty(result.Unreadable);
        Assert.Equal(2, result.Objects.Count);
        Assert.Contains("createdDateTime", Uri.UnescapeDataString(result.Requests[1]));
        Assert.DoesNotContain("$filter", result.Requests[1]);
    }

    [Fact]
    public async Task With_a_filter_a_400_drops_the_filter_first_then_a_refused_select()
    {
        var handler = new Scripted((r, _) =>
        {
            var query = Uri.UnescapeDataString(r.RequestUri!.Query);
            return query.Contains("signInActivity")
                ? Json(HttpStatusCode.BadRequest, Error("BadRequest", "Property 'signInActivity' cannot be selected in a list."))
                : Json(HttpStatusCode.OK, Page(0, 1));
        });

        var result = await Read(Reader(handler), Fetch(["id", "signInActivity"], "accountEnabled eq true"));

        Assert.True(result.Unfiltered);
        Assert.Equal(["signInActivity"], result.Unreadable);
        Assert.Equal(3, result.Requests.Count);
    }

    [Fact]
    public async Task Refused_select_property_is_dropped_and_reported()
    {
        var handler = new Scripted((r, _) => Uri.UnescapeDataString(r.RequestUri!.Query).Contains("signInActivity")
            ? Json(HttpStatusCode.BadRequest, Error("BadRequest", "Property 'signInActivity' cannot be selected in a list."))
            : Json(HttpStatusCode.OK, Page(0, 1)));

        var result = await Read(Reader(handler), Fetch(["id", "displayName", "signInActivity"]));

        Assert.Equal(["signInActivity"], result.Unreadable);
        Assert.Single(result.Objects);
        Assert.DoesNotContain("signInActivity", Uri.UnescapeDataString(result.Requests[1]));
    }

    [Fact]
    public async Task Columns_the_plan_found_unreadable_are_reported_with_those_graph_refuses()
    {
        var handler = new Scripted((r, _) => Uri.UnescapeDataString(r.RequestUri!.Query).Contains("signInActivity")
            ? Json(HttpStatusCode.BadRequest, Error("BadRequest", "Property 'signInActivity' cannot be selected in a list."))
            : Json(HttpStatusCode.OK, Page(0, 1)));
        var fetch = Fetch(["id", "displayName", "signInActivity"]) with { Unreadable = ["hideFromOutlook"] };

        var result = await Read(Reader(handler), fetch);

        Assert.Equal(["hideFromOutlook", "signInActivity"], result.Unreadable);
        Assert.DoesNotContain("hideFromOutlook", Uri.UnescapeDataString(result.Requests[0]));
    }

    [Fact]
    public async Task Too_many_select_refusals_fail()
    {
        var names = Enumerable.Range(0, 8).Select(i => "p" + i).ToArray();
        var handler = new Scripted((r, _) =>
        {
            var select = Uri.UnescapeDataString(r.RequestUri!.Query).Split('&')[0]["?$select=".Length..].Split(',');
            return Json(HttpStatusCode.BadRequest, Error("BadRequest", "Property '" + select[^1] + "' cannot be selected."));
        });

        var ex = await Fails(Read(Reader(handler), Fetch(["id", .. names])));

        Assert.Equal(GraphReadFailure.Failed, ex.Failure);
    }

    [Fact]
    public async Task A_400_that_names_no_selected_property_fails_with_its_message()
    {
        var handler = new Scripted((_, _) => Json(HttpStatusCode.BadRequest, Error("BadRequest", "Property 'other' is odd.")));

        var ex = await Fails(Read(Reader(handler), Fetch()));

        Assert.Equal(GraphReadFailure.Failed, ex.Failure);
        Assert.Contains("odd", ex.Message);
    }

    [Fact]
    public async Task Maps_403_to_no_permission_with_graph_message()
    {
        var handler = new Scripted((_, _) => Json(HttpStatusCode.Forbidden,
            Error("Authorization_RequestDenied", "Insufficient privileges to complete the operation.")));

        var ex = await Fails(Read(Reader(handler), Fetch()));

        Assert.Equal(GraphReadFailure.NoPermission, ex.Failure);
        Assert.Contains("Insufficient privileges to complete the operation.", ex.Message);
    }

    [Fact]
    public async Task Maps_429_with_retry_after()
    {
        var with = await Fails(Read(Reader(new Scripted((_, _) => Json(HttpStatusCode.TooManyRequests, "{}", 30))), Fetch()));
        var without = await Fails(Read(Reader(new Scripted((_, _) => Json(HttpStatusCode.TooManyRequests, "{}"))), Fetch()));

        Assert.Equal((GraphReadFailure.Throttled, 30), (with.Failure, with.RetryAfterSeconds));
        Assert.Equal((GraphReadFailure.Throttled, 60), (without.Failure, without.RetryAfterSeconds));
    }

    private static List<DiagnosticEntry> OfKind(RunDiagnostics diagnostics, string kind)
        => [.. diagnostics.Entries.Where(e => e.Kind == kind)];

    // A throttled page is sent once more after its Retry-After, and the wait shows as Throttled then Retry.
    [Fact]
    public async Task A_throttled_page_is_sent_again_after_its_retry_after()
    {
        var time = new InstantTime();
        var handler = new Scripted((_, n) => n == 0 ? Json(HttpStatusCode.TooManyRequests, "{}", 12) : Json(HttpStatusCode.OK, Page(0, 2)));
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        var result = await Read(Reader(handler, time: time), Fetch(), diagnostics: diagnostics);

        Assert.Equal(2, result.Objects.Count);
        Assert.Equal(2, handler.Calls);
        Assert.Equal([TimeSpan.FromSeconds(12)], time.Waits);
        Assert.Equal(("applications: Graph is throttling; Retry-After 12 s", (int?)429),
            (Assert.Single(OfKind(diagnostics, DiagnosticKinds.Throttled)).Detail, Assert.Single(OfKind(diagnostics, DiagnosticKinds.Throttled)).Status));
        Assert.Equal("applications: sent the request again after 12 s", Assert.Single(OfKind(diagnostics, DiagnosticKinds.Retry)).Detail);
    }

    // Twice throttled: the read fails throttled, with both 429s and the one retry counted.
    [Fact]
    public async Task A_page_throttled_again_after_its_retry_fails_throttled_and_both_are_counted()
    {
        var handler = new Scripted((_, _) => Json(HttpStatusCode.TooManyRequests, "{}", 3));
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        var failed = await Fails(Read(Reader(handler), Fetch(), diagnostics: diagnostics));

        Assert.Equal((GraphReadFailure.Throttled, "Graph is throttling requests, try again later"), (failed.Failure, failed.Message));
        Assert.Equal(2, handler.Calls);
        Assert.Equal(2, OfKind(diagnostics, DiagnosticKinds.Throttled).Count);
        Assert.Single(OfKind(diagnostics, DiagnosticKinds.Retry));
    }

    // The wait is capped: a Retry-After past it is waited for only that long.
    [Fact]
    public async Task The_wait_for_a_long_retry_after_is_capped()
    {
        var time = new InstantTime();
        var handler = new Scripted((_, n) => n == 0 ? Json(HttpStatusCode.TooManyRequests, "{}", 120) : Json(HttpStatusCode.OK, Page(0, 1)));

        var result = await Read(Reader(handler, time: time), Fetch());

        Assert.Single(result.Objects);
        Assert.Equal([GraphCollectionReader.MaxRetryWait], time.Waits);
    }

    /// <summary>A fake clock that says when a timer has been set, so a test can advance it once the reader waits.</summary>
    private sealed class WaitingTime : FakeTimeProvider
    {
        private readonly TaskCompletionSource _waiting = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Waiting => _waiting.Task;

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = base.CreateTimer(callback, state, dueTime, period);
            if (dueTime != Timeout.InfiniteTimeSpan)
                _waiting.TrySetResult();
            return timer;
        }
    }

    // signIns: a probe Graph throttles waits its Retry-After on the clock, then is sent again, and probing goes on.
    [Fact]
    public async Task A_throttled_probe_waits_its_retry_after_then_is_sent_again()
    {
        var time = new WaitingTime();
        var throttledOnce = 0;
        var handler = new Scripted((r, _) =>
        {
            var columns = SelectOf(r).Split(',').Where(c => c != "id").ToList();
            if (r.RequestUri!.OriginalString.Contains("$top=1", StringComparison.Ordinal) && columns.Count == 0
                && Interlocked.Exchange(ref throttledOnce, 1) == 0)
                return Json(HttpStatusCode.TooManyRequests, "{}", 20);
            return columns.Contains("windows") ? WebPage404() : Json(HttpStatusCode.OK, Page(0, 2));
        });
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        var read = Read(Reader(handler, time: time), Fetch(["appId", "windows", "id"]), diagnostics: diagnostics);
        await time.Waiting.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        var sentBeforeTheWait = handler.Calls;
        time.Advance(TimeSpan.FromSeconds(19));
        await Task.Delay(50, TestContext.Current.CancellationToken);
        Assert.Equal(sentBeforeTheWait, handler.Calls);
        time.Advance(TimeSpan.FromSeconds(1));
        var result = await read;

        Assert.Equal(["windows"], result.Unreadable);
        Assert.Equal(2, result.Objects.Count);
        Assert.Single(OfKind(diagnostics, DiagnosticKinds.Throttled));
        Assert.Single(OfKind(diagnostics, DiagnosticKinds.Retry));
    }

    private static Scripted WindowsNotListed() => new((r, _) => SelectOf(r).Split(',').Contains("windows")
        ? WebPage404()
        : Json(HttpStatusCode.OK, Page(0, 2)));

    private static bool IsProbe(string request) => request.EndsWith("&$top=1", StringComparison.Ordinal);

    /// <summary>A probe cache that already knows Graph lists every column of applications by default (for
    /// <paramref name="accounts"/>), so the default set doesn't narrow what the tests of probing select.</summary>
    private static async Task<MemoryGraphProbeCache> ListingEverything(params string[] accounts)
    {
        var probes = new MemoryGraphProbeCache(new FakeTimeProvider());
        foreach (var account in accounts.Append(Account))
            await probes.SetDefaultsAsync(account, "applications", ["appId", "displayName", "windows", "onPremisesPublishing", "tags", "id"],
                CancellationToken.None);
        return probes;
    }

    private const string DefaultRead = "applications?$top=1";

    /// <summary>Graph answering <paramref name="respond"/>, and listing every column of applications by default.</summary>
    private static Scripted EveryColumnByDefault(Func<HttpRequestMessage, int, HttpResponseMessage> respond) => new((r, n) =>
        r.RequestUri!.PathAndQuery == "/beta/" + DefaultRead
            ? Json(HttpStatusCode.OK, "{\"value\":[{\"id\":\"1\",\"appId\":\"a\",\"displayName\":\"d\",\"windows\":null,\"onPremisesPublishing\":null,\"tags\":[]}]}")
            : respond(r, n));

    /// <summary>Graph as it lists applications by default: id, appId and displayName (and an annotation), and a 404 web page for
    /// a list that selects windows.</summary>
    private static Scripted ListsByDefault(string defaultAnswer = "{\"value\":[{\"id\":\"1\",\"appId\":\"a\",\"displayName\":\"d\",\"tags@odata.type\":\"#Collection(String)\"}]}")
        => new((r, _) => r.RequestUri!.PathAndQuery == "/beta/" + DefaultRead
            ? Json(HttpStatusCode.OK, defaultAnswer)
            : SelectOf(r).Split(',').Contains("windows") ? WebPage404() : Json(HttpStatusCode.OK, Page(0, 2)));

    // A bare table: one read without $select learns the columns Graph lists by default, and the list selects only those, so
    // the column Graph won't list is never selected and nothing is probed.
    [Fact]
    public async Task A_bare_table_reads_the_default_columns_once_and_selects_only_them()
    {
        var probes = new MemoryGraphProbeCache(new FakeTimeProvider());
        var handler = ListsByDefault();
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        var result = await Read(Reader(handler, probes: probes), Fetch(["appId", "displayName", "windows", "tags", "id"]), diagnostics: diagnostics);

        Assert.Equal(DefaultRead, result.Requests[0]);
        Assert.Equal(2, result.Requests.Count);
        Assert.Equal(["appId", "displayName", "id"], SelectOfUrl(result.Requests[1]).Split(','));
        Assert.DoesNotContain(result.Requests, IsProbe);
        Assert.Empty(result.Unreadable);
        Assert.Equal(2, result.Objects.Count);
        Assert.Equal(["id", "appId", "displayName"], (await probes.GetDefaultsAsync(Account, "applications", CancellationToken.None))!.Columns);
        Assert.Equal(["applications: Graph lists 3 columns by default: id, appId, displayName",
            "applications: selected the columns Graph lists by default; left out windows, tags (the query doesn't name them)"],
            OfKind(diagnostics, DiagnosticKinds.Probe).Select(e => e.Detail));
    }

    private static string SelectOfUrl(string url) => Uri.UnescapeDataString(url).Split("$select=")[1].Split('&')[0];

    [Fact]
    public async Task A_second_run_does_not_read_the_default_columns_again()
    {
        var probes = new MemoryGraphProbeCache(new FakeTimeProvider());
        var fetch = Fetch(["appId", "displayName", "windows", "id"]);
        await Read(Reader(ListsByDefault(), probes: probes), fetch);

        var second = ListsByDefault();
        var result = await Read(Reader(second, probes: probes), fetch);

        Assert.Equal(1, second.Calls);
        Assert.DoesNotContain(DefaultRead, result.Requests);
        Assert.Equal(["appId", "displayName", "id"], SelectOfUrl(result.Requests[0]).Split(','));
    }

    // A column outside the default set is selected when the query names it: then Graph may refuse it, and probing finds it.
    [Fact]
    public async Task A_named_column_outside_the_default_set_is_still_selected()
    {
        var probes = new MemoryGraphProbeCache(new FakeTimeProvider());
        var handler = ListsByDefault();
        var fetch = Fetch(["appId", "displayName", "tags", "windows", "id"]) with { Named = ["tags", "windows"] };

        var result = await Read(Reader(handler, probes: probes), fetch);

        var list = result.Requests.Last(q => q.EndsWith("$top=999", StringComparison.Ordinal));
        Assert.Contains("tags", SelectOfUrl(list).Split(','));
        Assert.Contains("appId", SelectOfUrl(list).Split(','));
        // Graph refused it in the list: probing found it, and as the query names it, it was read one object at a time.
        Assert.Equal(["windows"], result.PerObject);
        Assert.Contains(result.Requests, IsProbe);
    }

    // No object, no names: nothing is kept, and the list selects as it did before.
    [Theory]
    [InlineData("{\"value\":[]}")]
    [InlineData("{}")]
    [InlineData("null")]
    public async Task An_empty_default_read_keeps_nothing_and_selects_as_before(string answer)
    {
        var probes = new MemoryGraphProbeCache(new FakeTimeProvider());
        var handler = ListsByDefault(answer);

        var result = await Read(Reader(handler, probes: probes), Fetch(["appId", "displayName", "tags", "id"]));

        Assert.Null(await probes.GetDefaultsAsync(Account, "applications", CancellationToken.None));
        Assert.Equal(["appId", "displayName", "tags", "id"], SelectOfUrl(result.Requests[^1]).Split(','));
    }

    [Fact]
    public async Task Refresh_reads_the_default_columns_again()
    {
        var probes = new MemoryGraphProbeCache(new FakeTimeProvider());
        var fetch = Fetch(["appId", "displayName", "id"]);
        await Read(Reader(ListsByDefault(), probes: probes), fetch);

        var result = await Read(Reader(ListsByDefault(), probes: probes), fetch, refresh: true);

        Assert.Equal(DefaultRead, result.Requests[0]);
    }

    // What probing found is kept per account and table: the next run selects without those columns at once, and says so.
    [Fact]
    public async Task A_second_run_leaves_out_what_probing_found_without_probing_again()
    {
        var probes = await ListingEverything();
        var fetch = Fetch(["appId", "windows", "onPremisesPublishing", "id"]);
        var first = new Scripted((r, _) => SelectOf(r).Split(',') switch
        {
            var c when c.Contains("onPremisesPublishing") => Unauthorized(),
            var c when c.Contains("windows") => WebPage404(),
            _ => Json(HttpStatusCode.OK, Page(0, 2)),
        });
        var firstRead = await Read(Reader(first, probes: probes), fetch);
        Assert.Contains(firstRead.Requests, IsProbe);

        var second = new Scripted((r, _) => SelectOf(r).Split(',').Any(c => c is "windows" or "onPremisesPublishing")
            ? Json(HttpStatusCode.InternalServerError, "{}")
            : Json(HttpStatusCode.OK, Page(0, 2)));
        var diagnostics = new RunDiagnostics(TimeProvider.System);
        var result = await Read(Reader(second, probes: probes), fetch, diagnostics: diagnostics);

        Assert.Equal(1, second.Calls);
        Assert.DoesNotContain(result.Requests, IsProbe);
        Assert.Equal(["windows"], result.Unreadable);
        Assert.Equal(["onPremisesPublishing"], result.Denied);
        Assert.Equal(2, result.Objects.Count);
        Assert.Equal("applications: left out (found earlier) windows (Graph won't serve it in a list), "
            + "onPremisesPublishing (Graph refused it for permission)", Assert.Single(OfKind(diagnostics, DiagnosticKinds.Probe)).Detail);
    }

    // Another account, or another table, probes for itself.
    [Fact]
    public async Task Findings_are_kept_per_account_and_table()
    {
        var probes = await ListingEverything("account-2");
        var fetch = Fetch(["appId", "windows", "id"]);
        await Read(Reader(WindowsNotListed(), probes: probes), fetch);

        var other = WindowsNotListed();
        var result = await Reader(other, probes: probes).ReadAsync("account-2", fetch, new GraphFetchBudget().Lease(), false, CancellationToken.None);

        Assert.Contains(result.Requests, IsProbe);
        Assert.Equal(["windows"], (await probes.GetAsync("account-2", "applications", CancellationToken.None))!.NotListed);
        Assert.Null(await probes.GetAsync(Account, "servicePrincipals", CancellationToken.None));
    }

    // refresh doesn't trust what was found earlier: it reads with every column, probes again, and keeps what it finds now.
    [Fact]
    public async Task Refresh_probes_again_and_keeps_what_it_finds_now()
    {
        var probes = await ListingEverything();
        var fetch = Fetch(["appId", "windows", "tags", "id"]);
        await Read(Reader(WindowsNotListed(), probes: probes), fetch);

        var now = EveryColumnByDefault((r, _) => SelectOf(r).Split(',').Contains("tags") ? WebPage404() : Json(HttpStatusCode.OK, Page(0, 2)));
        var result = await Read(Reader(now, probes: probes), fetch, refresh: true);

        Assert.Contains(result.Requests, IsProbe);
        Assert.Equal(["tags"], result.Unreadable);
        Assert.Equal(["tags"], (await probes.GetAsync(Account, "applications", CancellationToken.None))!.NotListed);
    }

    // A refresh whose list reads whole forgets the earlier findings.
    [Fact]
    public async Task Refresh_that_reads_every_column_forgets_the_findings()
    {
        var probes = await ListingEverything();
        var fetch = Fetch(["appId", "windows", "id"]);
        await Read(Reader(WindowsNotListed(), probes: probes), fetch);

        var result = await Read(Reader(EveryColumnByDefault((_, _) => Json(HttpStatusCode.OK, Page(0, 2))), probes: probes), fetch, refresh: true);

        Assert.Empty(result.Unreadable);
        Assert.Null(await probes.GetAsync(Account, "applications", CancellationToken.None));
    }

    // Columns found earlier and columns this run finds are kept together.
    [Fact]
    public async Task New_findings_are_added_to_those_found_earlier()
    {
        var probes = await ListingEverything();
        await Read(Reader(WindowsNotListed(), probes: probes), Fetch(["appId", "windows", "id"]));

        var both = new Scripted((r, _) => SelectOf(r).Split(',').Any(c => c is "windows" or "tags") ? WebPage404() : Json(HttpStatusCode.OK, Page(0, 2)));
        var result = await Read(Reader(both, probes: probes), Fetch(["appId", "windows", "tags", "id"]));

        Assert.Equal(["tags", "windows"], result.Unreadable.Order(StringComparer.Ordinal));
        Assert.Equal(["tags", "windows"], (await probes.GetAsync(Account, "applications", CancellationToken.None))!.NotListed.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Maps_404_and_5xx()
    {
        var notFound = await Fails(Read(Reader(new Scripted((_, _) => Json(HttpStatusCode.NotFound, Error("Request_ResourceNotFound", "Resource not found.")))), Fetch()));
        var down = await Fails(Read(Reader(new Scripted((_, _) => Json(HttpStatusCode.ServiceUnavailable, "oops"))), Fetch()));

        Assert.Equal(GraphReadFailure.NotFound, notFound.Failure);
        Assert.Contains("Resource not found.", notFound.Message);
        Assert.Equal(GraphReadFailure.Failed, down.Failure);
        Assert.Equal("Graph didn't answer (503)", down.Message);
    }

    // Graph passes a backend's IIS error page through as its error message: it is never shown as it is.
    [Fact]
    public async Task A_web_page_as_graphs_message_is_replaced_with_a_short_one()
    {
        const string Page = "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\">\r\n<html><head><title>404 - File or directory not found.</title></head></html>";
        var body = System.Text.Json.JsonSerializer.Serialize(new { error = new { code = "UnknownError", message = Page } });
        var failed = await Fails(Read(Reader(new Scripted((_, _) => Json(HttpStatusCode.NotFound, body))), Fetch()));

        Assert.Equal(GraphReadFailure.NotFound, failed.Failure);
        Assert.DoesNotContain("<", failed.Message);
        Assert.Equal("404 from Graph's backend: 404 - File or directory not found.", failed.Message);
    }

    private static HttpResponseMessage WebPage404() => Json(HttpStatusCode.NotFound, System.Text.Json.JsonSerializer.Serialize(
        new { error = new { code = "UnknownError", message = "<!DOCTYPE html><html><head><title>404 - File or directory not found.</title></head></html>" } }));

    private static string SelectOf(HttpRequestMessage request)
        => Uri.UnescapeDataString(request.RequestUri!.OriginalString).Split("$select=") is [_, var select] ? select.Split('&')[0] : "";

    // Some properties make a backend behind Graph answer 404 with a web page in some tenants. The reader finds them by probing
    // halves of the $select, leaves them out, reads the collection, and says which columns couldn't be read.
    [Fact]
    public async Task Columns_that_make_graph_answer_with_a_web_page_are_found_and_left_out()
    {
        var reader = Reader(new Scripted((r, _) => SelectOf(r).Split(',').Any(c => c is "onPremisesPublishing" or "windows")
            ? WebPage404()
            : Json(HttpStatusCode.OK, Page(0, 3))));

        var result = await Read(reader, Fetch(["appId", "displayName", "onPremisesPublishing", "tags", "windows", "web", "id"]));

        Assert.Equal(["onPremisesPublishing", "windows"], result.Unreadable.Order(StringComparer.Ordinal));
        Assert.Equal(3, result.Objects.Count);
        var last = result.Requests[^1];
        Assert.DoesNotContain("onPremisesPublishing", Uri.UnescapeDataString(last));
        Assert.Contains("$top=999", last);
        Assert.Contains(result.Requests, q => q.Contains("$top=1"));   // the probes are listed too
    }

    // users as a tenant without Entra ID P1/P2 or SharePoint Online sees it: displayName and mail come by default; signInActivity
    // and aboutMe only on $select, and Graph refuses the whole list when either is selected.
    private static GraphFetch Users(params string[] named)
    {
        static GraphColumn Column(string name, bool selectOnly) => new(name, "string", "", [], selectOnly, null);
        var table = new GraphTable("users", "users", "microsoft.graph.user", "", "https://learn.microsoft.com/x",
            [Column("id", false), Column("displayName", false), Column("mail", false), Column("signInActivity", true), Column("aboutMe", true)]);
        return new GraphFetch(table, ["displayName", "mail", "signInActivity", "aboutMe", "id"], null) { Named = named };
    }

    private const string Premium = "Neither tenant is B2C or tenant doesn't have premium license";

    private static HttpResponseMessage PremiumRefused()
        => Json(HttpStatusCode.Forbidden, Error("Authentication_RequestFromNonPremiumTenantOrB2CTenant", Premium));

    private static HttpResponseMessage SpoRefused()
        => Json(HttpStatusCode.BadRequest, Error("BadRequest", "Tenant does not have a SPO license."));

    [Fact]
    public async Task A_license_error_reads_the_list_again_without_the_optional_select_only_columns()
    {
        var handler = new Scripted((r, _) => SelectOf(r).Split(',').Contains("signInActivity") ? PremiumRefused() : Json(HttpStatusCode.OK, Page(0, 3)));

        var result = await Read(Reader(handler), Users("displayName"));

        Assert.Equal(3, result.Objects.Count);
        Assert.Equal(["signInActivity", "aboutMe"], result.Unlicensed);
        Assert.Equal(Premium, result.UnlicensedReason);
        Assert.Equal(2, handler.Calls);
        Assert.Equal("displayName,mail,id", Uri.UnescapeDataString(result.Requests[^1]).Split("$select=")[1].Split('&')[0]);
        Assert.Empty(result.Unreadable);
        Assert.Empty(result.Denied);
    }

    [Fact]
    public async Task A_license_error_reads_the_list_again_only_once()
    {
        var handler = new Scripted((_, _) => SpoRefused());

        var ex = await Fails(Read(Reader(handler), Users()));

        Assert.Equal("Tenant does not have a SPO license.", ex.Message);
        Assert.Equal(2, handler.Calls);
    }

    [Fact]
    public async Task A_license_error_never_drops_a_column_the_query_names()
    {
        var handler = new Scripted((r, _) => SelectOf(r).Split(',').Contains("signInActivity") ? PremiumRefused() : Json(HttpStatusCode.OK, Page(0, 3)));

        var ex = await Fails(Read(Reader(handler), Users("displayName", "signInActivity")));

        Assert.Equal(Premium, ex.Message);
        Assert.Equal(2, handler.Calls);
        Assert.All(ex.Requests, q => Assert.Contains("signInActivity", Uri.UnescapeDataString(q)));
    }

    [Fact]
    public async Task A_license_error_with_only_named_select_only_columns_is_handled_as_before()
    {
        // Nothing optional to leave out: the refusal goes the way any other does (here, probing finds the column).
        var handler = new Scripted((r, _) => SelectOf(r).Split(',').Contains("signInActivity") ? PremiumRefused() : Json(HttpStatusCode.OK, Page(0, 3)));
        var fetch = Users("displayName", "signInActivity") with { Select = ["displayName", "signInActivity", "id"] };

        var result = await Read(Reader(handler), fetch);

        Assert.Empty(result.Unlicensed);
        Assert.Equal(["signInActivity"], result.Denied);
    }

    private static HttpResponseMessage Unauthorized() =>
        Json(HttpStatusCode.Unauthorized, Error("Authorization_RequestDenied", "Unauthorized Access."));

    // onPremisesPublishing needs a permission the signed-in app may not have: the rest of the table still reads, and the column
    // is reported as denied (not as one Graph won't list), and it isn't read one object at a time either.
    [Fact]
    public async Task A_column_graph_refuses_for_permission_is_left_out_and_reported_as_denied()
    {
        var handler = new Scripted((r, _) => SelectOf(r).Contains("onPremisesPublishing") ? Unauthorized() : Json(HttpStatusCode.OK, Page(0, 2)));
        var fetch = Fetch(["appId", "displayName", "onPremisesPublishing", "id"]) with { Named = ["appId", "displayName", "onPremisesPublishing"] };

        var result = await Read(Reader(handler), fetch);

        Assert.Equal(["onPremisesPublishing"], result.Denied);
        Assert.DoesNotContain("onPremisesPublishing", result.Unreadable);
        Assert.Empty(result.PerObject);
        Assert.Equal(2, result.Objects.Count);
        Assert.DoesNotContain(result.Requests, q => q.Contains("{id}"));
    }

    // Reothor Lab: the list with onPremisesPublishing is refused, onPremisesPublishing alongside another column gets a 400
    // "Invalid object identifier '[sourceEntityId]'", and alone a 401. Any client error while probing marks the group, and
    // the single column's own answer says why.
    [Fact]
    public async Task Any_client_error_while_probing_marks_the_column_and_its_own_answer_says_why()
    {
        var handler = new Scripted((r, _) =>
        {
            var columns = SelectOf(r).Split(',').Where(c => c != "id").ToList();
            if (!columns.Contains("onPremisesPublishing"))
                return Json(HttpStatusCode.OK, Page(0, 2));
            return columns.Count == 1 ? Unauthorized() : Json(HttpStatusCode.BadRequest, Error("Request_BadRequest", "Invalid object identifier '[sourceEntityId]'."));
        });
        var fetch = Fetch(["appId", "displayName", "onPremisesPublishing", "passwordCredentials", "id"]);

        var result = await Read(Reader(handler), fetch);

        Assert.Equal(["onPremisesPublishing"], result.Denied);
        Assert.Empty(result.Unreadable);
        Assert.Equal(2, result.Objects.Count);
    }

    [Fact]
    public async Task A_column_graph_answers_with_another_client_error_alone_is_not_listed()
    {
        var reader = Reader(new Scripted((r, _) => SelectOf(r).Contains("windows")
            ? Json(HttpStatusCode.BadRequest, Error("Request_BadRequest", "Invalid object identifier '[sourceEntityId]'."))
            : Json(HttpStatusCode.OK, Page(0, 1))));

        var result = await Read(reader, Fetch(["appId", "windows", "id"]));

        Assert.Equal(["windows"], result.Unreadable);
        Assert.Empty(result.Denied);
    }

    [Fact]
    public async Task A_table_graph_refuses_whatever_is_selected_is_still_no_permission()
    {
        var failed = await Fails(Read(Reader(new Scripted((_, _) => Unauthorized())), Fetch(["appId", "displayName", "id"])));

        Assert.Equal(GraphReadFailure.NoPermission, failed.Failure);
        Assert.Equal("Unauthorized Access.", failed.Message);
    }

    private static HttpResponseMessage InvalidToken()
    {
        var response = Json(HttpStatusCode.Unauthorized, Error("InvalidAuthenticationToken", "Access token has expired or is not yet valid."));
        response.Headers.WwwAuthenticate.ParseAdd("Bearer error=\"invalid_token\", error_description=\"The access token expired\"");
        return response;
    }

    [Fact]
    public async Task First_page_401_with_invalid_token_throws_sign_in_needed()
    {
        var failed = await Fails(Read(Reader(new Scripted((_, _) => InvalidToken())), Fetch()));

        Assert.Equal(GraphReadFailure.SignInNeeded, failed.Failure);
        Assert.Single(failed.Requests);
    }

    [Fact]
    public async Task Probe_401_invalid_token_throws_sign_in_needed()
    {
        // The list answers 404 with a web page (a selected column), then the first probe is told the token is bad.
        var handler = new Scripted((r, _) => r.RequestUri!.OriginalString.Contains("$top=999", StringComparison.Ordinal)
            ? Json(HttpStatusCode.NotFound, Error("UnknownError", "<html><title>404</title></html>"))
            : InvalidToken());

        var failed = await Fails(Read(Reader(handler), Fetch(["appId", "displayName", "id"])));

        Assert.Equal(GraphReadFailure.SignInNeeded, failed.Failure);
        Assert.Equal(2, failed.Requests.Count);
    }

    [Fact]
    public async Task First_page_401_with_invalid_authentication_token_code_throws_sign_in_needed()
    {
        var handler = new Scripted((_, _) => Json(HttpStatusCode.Unauthorized, Error("InvalidAuthenticationToken", "Access token is empty.")));

        var failed = await Fails(Read(Reader(handler), Fetch(["id"])));

        Assert.Equal(GraphReadFailure.SignInNeeded, failed.Failure);
    }

    [Fact]
    public async Task First_page_401_without_a_graph_error_body_throws_sign_in_needed()
    {
        var failed = await Fails(Read(Reader(new Scripted((_, _) => Json(HttpStatusCode.Unauthorized, ""))), Fetch(["id"])));

        Assert.Equal(GraphReadFailure.SignInNeeded, failed.Failure);
    }

    [Fact]
    public async Task First_page_401_request_denied_with_only_id_is_no_permission()
    {
        var failed = await Fails(Read(Reader(new Scripted((_, _) => Unauthorized())), Fetch(["id"])));

        Assert.Equal(GraphReadFailure.NoPermission, failed.Failure);
    }

    [Fact]
    public async Task Probe_of_a_column_group_answering_401_invalid_token_throws_sign_in_needed_not_denied()
    {
        // The list fails with a web page and id alone reads, then a column group's probe is told the token is bad.
        var handler = new Scripted((r, _) =>
        {
            var columns = SelectOf(r).Split(',').Where(c => c != "id").ToList();
            if (r.RequestUri!.OriginalString.Contains("$top=999", StringComparison.Ordinal))
                return WebPage404();
            return columns.Count == 0 ? Json(HttpStatusCode.OK, Page(0, 1)) : InvalidToken();
        });

        var failed = await Fails(Read(Reader(handler), Fetch(["appId", "displayName", "id"])));

        Assert.Equal(GraphReadFailure.SignInNeeded, failed.Failure);
        Assert.Equal(3, failed.Requests.Count);
    }

    [Fact]
    public async Task A_next_link_is_followed_only_to_graph_microsoft_com_whatever_the_base_address()
    {
        var handler = new Scripted((_, n) => Json(HttpStatusCode.OK, n == 0 ? Page(0, 1, Next + "a") : Page(1, 1)));
        var reader = new GraphCollectionReader(new HttpClient(handler) { BaseAddress = new Uri("https://example.test/beta/") },
            new GraphFetchBudget(), NoGraphObjectCache.Instance, GraphLimits.Default);

        var result = await Read(reader, Fetch());

        Assert.Equal(2, result.Objects.Count);
        Assert.Equal(2, handler.Calls);
        var other = new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 1, "https://example.test/beta/applications?x=1")));
        var otherReader = new GraphCollectionReader(new HttpClient(other) { BaseAddress = new Uri("https://example.test/beta/") },
            new GraphFetchBudget(), NoGraphObjectCache.Instance, GraphLimits.Default);
        var failed = await Fails(Read(otherReader, Fetch()));
        Assert.Equal(GraphReadFailure.Failed, failed.Failure);
        Assert.Equal(1, other.Calls);
    }

    [Fact]
    public async Task A_next_link_that_is_not_text_fails_the_read()
    {
        var handler = new Scripted((_, _) => Json(HttpStatusCode.OK, "{\"@odata.nextLink\":42,\"value\":[{\"id\":\"1\"}]}"));

        var failed = await Fails(Read(Reader(handler), Fetch()));

        Assert.Equal(GraphReadFailure.Failed, failed.Failure);
    }

    [Fact]
    public async Task A_single_selected_column_that_makes_graph_answer_with_a_web_page_is_left_out_too()
    {
        var reader = Reader(new Scripted((r, _) => SelectOf(r).Contains("onPremisesPublishing") ? WebPage404() : Json(HttpStatusCode.OK, Page(0, 2))));

        var result = await Read(reader, Fetch(["onPremisesPublishing", "id"]));

        Assert.Equal(["onPremisesPublishing"], result.Unreadable);
        Assert.Equal(2, result.Objects.Count);
    }

    [Fact]
    public async Task A_collection_that_answers_with_a_web_page_whatever_is_selected_fails_as_before()
    {
        var failed = await Fails(Read(Reader(new Scripted((_, _) => WebPage404())), Fetch(["appId", "displayName", "tags", "id"])));

        Assert.Equal(GraphReadFailure.NotFound, failed.Failure);
        Assert.StartsWith("404 from Graph's backend: ", failed.Message);
    }

    [Fact]
    public async Task Probing_stops_at_its_budget()
    {
        var handler = new Scripted((r, _) => SelectOf(r).Split(',').Any(c => c.StartsWith("bad", StringComparison.Ordinal)) ? WebPage404() : Json(HttpStatusCode.OK, Page(0, 1)));
        var select = Enumerable.Range(0, 40).Select(i => i % 2 == 0 ? "bad" + i : "ok" + i).Append("id").ToArray();

        var failed = await Fails(Read(Reader(handler), Fetch(select)));

        Assert.StartsWith("404 from Graph's backend: ", failed.Message);
        Assert.True(handler.Calls <= 1 + GraphCollectionReader.MaxProbes, $"{handler.Calls} calls");
    }

    [Fact]
    public async Task A_failed_read_carries_the_requests_it_sent()
    {
        var failed = await Fails(Read(Reader(new Scripted((_, _) => Json(HttpStatusCode.NotFound, Error("Request_ResourceNotFound", "Resource not found.")))), Fetch()));

        // The read itself, then the probe of id alone that shows the table (not a column) is what fails.
        Assert.Equal(GraphReadFailure.NotFound, failed.Failure);
        Assert.Equal(2, failed.Requests.Count);
        Assert.StartsWith("applications?$select=", failed.Requests[0]);
        Assert.Equal("applications?$select=id&$top=1", failed.Requests[1]);
    }
}
