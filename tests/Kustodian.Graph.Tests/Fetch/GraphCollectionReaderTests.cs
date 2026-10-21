using System.Net;
using System.Text;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphCollectionReaderTests
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

    private static GraphCollectionReader Reader(HttpMessageHandler handler, GraphFetchBudget? budget = null)
        => new(new HttpClient(handler) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") }, budget ?? new GraphFetchBudget(),
            NoGraphObjectCache.Instance);

    private static Task<GraphCollection> Read(GraphCollectionReader reader, GraphFetch fetch, GraphFetchLease? lease = null)
        => reader.ReadAsync(Account, fetch, lease ?? new GraphFetchBudget().Lease(), refresh: false,
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

    [Fact]
    public async Task Ignores_next_links_to_other_hosts()
    {
        var handler = new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 2, "https://evil.example/applications?x=1")));

        var result = await Read(Reader(handler), Fetch());

        Assert.Equal(2, result.Objects.Count);
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
        Assert.Equal("The server is busy, try again", ex.Message);
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
        => Uri.UnescapeDataString(request.RequestUri!.OriginalString).Split("$select=")[1].Split('&')[0];

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

    private static HttpResponseMessage Unauthorized() =>
        Json(HttpStatusCode.Unauthorized, Error("Authorization_RequestDenied", "Unauthorized Access."));

    // onPremisesPublishing needs a permission the Collector app doesn't have: the rest of the table still reads, and the column
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
            new GraphFetchBudget(), NoGraphObjectCache.Instance);

        var result = await Read(reader, Fetch());

        Assert.Equal(2, result.Objects.Count);
        Assert.Equal(2, handler.Calls);
        var other = new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 1, "https://example.test/beta/applications?x=1")));
        var otherReader = new GraphCollectionReader(new HttpClient(other) { BaseAddress = new Uri("https://example.test/beta/") },
            new GraphFetchBudget(), NoGraphObjectCache.Instance);
        await Read(otherReader, Fetch());
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
