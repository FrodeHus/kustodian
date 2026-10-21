using System.Net;
using System.Text;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Graph.Tests;

/// <summary>The reader's side of count, sort and filter-clause pushdown: what it sends, the advanced query header, and how a
/// refusal falls back and is remembered.</summary>
public sealed partial class GraphCollectionReaderTests
{
    private static readonly GraphTable DirectoryUsers = new("users", "users", "microsoft.graph.user", "", "",
        [new("id", "string", "", ["eq"], false, null), new("createdDateTime", "datetime", "", ["ge", "le"], false, null)], DirectoryObject: true);

    private static readonly GraphTable Alerts = new("security_alerts_v2", "security/alerts_v2", "microsoft.graph.security.alert", "", "",
        [new("id", "string", "", ["eq"], false, null)]);

    private static readonly FilterClause Enabled = new("accountEnabled eq true");
    private static readonly FilterClause EndsWith = new("endswith(mail,'@contoso.com')", "endswith(mail)", Advanced: true);

    private static GraphFetch UsersFetch(params FilterClause[] clauses)
        => new(DirectoryUsers, ["id", "createdDateTime"], clauses.Length == 0 ? null : string.Join(" and ", clauses.Select(c => c.OData)))
        {
            Clauses = clauses,
        };

    private static HttpResponseMessage Text(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "text/plain") };

    private static bool IsAdvanced(HttpRequestMessage request)
        => request.Headers.TryGetValues("ConsistencyLevel", out var values) && values.Single() == "eventual"
            && request.RequestUri!.Query.Contains("$count=true", StringComparison.Ordinal);

    private static bool HasHeader(HttpRequestMessage request) => request.Headers.Contains("ConsistencyLevel");

    private static string Dated(params string?[] instants) => "{\"value\":[" + string.Join(",", instants.Select((d, i) =>
        "{\"id\":\"" + i + "\",\"createdDateTime\":" + (d is null ? "null" : "\"" + d + "\"") + "}")) + "]}";

    /// <summary>A probe cache that knows the default columns already, so no read starts with learning them.</summary>
    private static MemoryGraphProbeCache Probes()
    {
        var probes = new MemoryGraphProbeCache(new FakeTimeProvider());
        foreach (var path in new[] { "users", "security/alerts_v2" })
            probes.SetDefaultsAsync(Account, path, ["id", "createdDateTime"], CancellationToken.None).AsTask().Wait();
        return probes;
    }

    private static async Task<IReadOnlySet<string>> Refused(IGraphProbeCache probes, string path = "users")
        => await probes.RefusedAsync(Account, path, CancellationToken.None);

    // count

    [Fact]
    public async Task A_count_of_directory_objects_asks_for_the_count_segment_in_advanced_mode()
    {
        var sent = new List<HttpRequestMessage>();
        var handler = new Scripted((r, _) =>
        {
            sent.Add(r);
            return Text("﻿1234");
        });

        var result = await Read(Reader(handler), UsersFetch(Enabled, EndsWith) with { Count = "Count" });

        Assert.Equal(1234, result.Count);
        Assert.Empty(result.Objects);
        Assert.Equal("users/$count?$filter=" + Uri.EscapeDataString("accountEnabled eq true and endswith(mail,'@contoso.com')"),
            Assert.Single(result.Requests));
        Assert.Equal("eventual", Assert.Single(sent).Headers.GetValues("ConsistencyLevel").Single());
    }

    [Fact]
    public async Task A_count_elsewhere_reads_odata_count_of_a_one_object_page()
    {
        var sent = new List<HttpRequestMessage>();
        var handler = new Scripted((r, _) =>
        {
            sent.Add(r);
            return Json(HttpStatusCode.OK, "{\"@odata.count\":57,\"value\":[{\"id\":\"1\"}]}");
        });

        var result = await Read(Reader(handler), new GraphFetch(Alerts, ["id"], null) { Count = "Count" });

        Assert.Equal(57, result.Count);
        Assert.Equal("security/alerts_v2?$select=id&$count=true&$top=1", Assert.Single(result.Requests));
        Assert.False(HasHeader(Assert.Single(sent)));
    }

    [Fact]
    public async Task A_refused_count_reads_the_objects_and_is_remembered()
    {
        var probes = Probes();
        HttpResponseMessage Respond(HttpRequestMessage r, int n) => r.RequestUri!.AbsolutePath.EndsWith("/$count", StringComparison.Ordinal)
            ? Json(HttpStatusCode.BadRequest, Error("Request_BadRequest", "Unsupported query."))
            : Json(HttpStatusCode.OK, Page(0, 3));
        var diagnostics = new RunDiagnostics(TimeProvider.System);

        var result = await Read(Reader(new Scripted(Respond), probes: probes), UsersFetch(Enabled) with { Count = "Count" }, diagnostics: diagnostics);

        Assert.Null(result.Count);
        Assert.Equal(3, result.Objects.Count);
        Assert.StartsWith("users/$count", result.Requests[0], StringComparison.Ordinal);
        Assert.Contains("$filter=", result.Requests[^1]);
        Assert.Contains(GraphCollectionReader.CountClause, await Refused(probes));
        Assert.Contains("users: Graph didn't count; reading the objects", OfKind(diagnostics, DiagnosticKinds.Probe).Select(e => e.Detail));

        var again = new Scripted(Respond);
        var second = await Read(Reader(again, probes: probes), UsersFetch(Enabled) with { Count = "Count" });

        Assert.DoesNotContain(second.Requests, r => r.Contains("$count", StringComparison.Ordinal) && !r.Contains("$top=1", StringComparison.Ordinal));
        Assert.Equal(3, second.Objects.Count);
    }

    [Fact]
    public async Task A_count_graph_ignores_reads_the_objects_and_is_remembered()
    {
        var probes = Probes();
        var handler = new Scripted((_, _) => Json(HttpStatusCode.OK, Page(0, 2)));

        var result = await Read(Reader(handler, probes: probes), new GraphFetch(Alerts, ["id"], null) { Count = "Count" });

        Assert.Null(result.Count);
        Assert.Equal(2, result.Objects.Count);
        Assert.Contains(GraphCollectionReader.CountClause, await Refused(probes, "security/alerts_v2"));
    }

    // A count refused for permission is the table's, not the count's: the list read reports it, and nothing is remembered.
    [Fact]
    public async Task A_count_refused_for_permission_is_not_remembered()
    {
        var probes = Probes();
        var handler = new Scripted((r, _) => r.RequestUri!.AbsolutePath.EndsWith("/$count", StringComparison.Ordinal)
            ? Json(HttpStatusCode.Forbidden, Error("Authorization_RequestDenied", "Insufficient privileges."))
            : Json(HttpStatusCode.OK, Page(0, 1)));

        var result = await Read(Reader(handler, probes: probes), UsersFetch() with { Count = "Count" });

        Assert.Single(result.Objects);
        Assert.Empty(await Refused(probes));
    }

    // A count whose filter Graph refuses is the filter's fault: the clause is remembered, not the count.
    [Fact]
    public async Task A_count_with_a_refused_clause_remembers_the_clause_not_the_count()
    {
        var probes = Probes();
        var handler = new Scripted((r, _) => Uri.UnescapeDataString(r.RequestUri!.Query).Contains("endswith", StringComparison.Ordinal)
            ? Json(HttpStatusCode.BadRequest, Error("Request_UnsupportedQuery", "Unsupported or invalid query filter clause."))
            : Json(HttpStatusCode.OK, Page(0, 1)));

        await Read(Reader(handler, probes: probes), UsersFetch(Enabled, EndsWith) with { Count = "Count" });

        Assert.Equal(["endswith(mail)"], await Refused(probes));
    }

    // sort and take

    [Fact]
    public async Task A_sort_sends_orderby_and_top_in_advanced_mode_on_directory_objects()
    {
        var sent = new List<HttpRequestMessage>();
        var handler = new Scripted((r, _) =>
        {
            sent.Add(r);
            return Json(HttpStatusCode.OK, Dated("2026-10-03T00:00:00Z", "2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z"));
        });

        var result = await Read(Reader(handler), UsersFetch(Enabled) with { Top = 3, OrderBy = new GraphOrderBy("createdDateTime", true) });

        Assert.Equal(3, result.Objects.Count);
        Assert.EndsWith("&$orderby=" + Uri.EscapeDataString("createdDateTime desc") + "&$count=true&$top=3", Assert.Single(result.Requests),
            StringComparison.Ordinal);
        Assert.True(IsAdvanced(Assert.Single(sent)));
    }

    [Fact]
    public async Task A_sort_elsewhere_sends_no_advanced_query_parameters()
    {
        var sent = new List<HttpRequestMessage>();
        var handler = new Scripted((r, _) =>
        {
            sent.Add(r);
            return Json(HttpStatusCode.OK, Dated("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"));
        });
        var fetch = new GraphFetch(Alerts, ["id"], null) { Top = 2, OrderBy = new GraphOrderBy("createdDateTime", false) };

        var result = await Read(Reader(handler), fetch);

        Assert.EndsWith("&$orderby=" + Uri.EscapeDataString("createdDateTime asc") + "&$top=2", Assert.Single(result.Requests), StringComparison.Ordinal);
        Assert.False(HasHeader(Assert.Single(sent)));
    }

    private static HttpResponseMessage RefusesOrderBy(HttpRequestMessage request, int _) => request.RequestUri!.Query.Contains("$orderby")
        ? Json(HttpStatusCode.BadRequest, Error("Request_UnsupportedQuery", "Sorting not supported for 'createdDateTime'."))
        : Json(HttpStatusCode.OK, request.RequestUri!.Query.Contains("$skiptoken") ? Page(10, 4) : Page(0, 10, Next + "a"));

    [Fact]
    public async Task A_refused_sort_reads_every_object_without_it_and_is_remembered()
    {
        var probes = Probes();
        var diagnostics = new RunDiagnostics(TimeProvider.System);
        var fetch = UsersFetch(Enabled) with { Top = 3, OrderBy = new GraphOrderBy("createdDateTime", true) };

        var result = await Read(Reader(new Scripted(RefusesOrderBy), probes: probes), fetch, diagnostics: diagnostics);

        // Without the sort, the first rows aren't the query's: every one is read, and the filter is kept.
        Assert.Equal(14, result.Objects.Count);
        Assert.DoesNotContain("$orderby", result.Requests[1]);
        Assert.EndsWith("&$top=999", result.Requests[1], StringComparison.Ordinal);
        Assert.Contains("$filter=", result.Requests[1]);
        Assert.False(result.Unfiltered);
        Assert.Equal([GraphCollectionReader.OrderByClause], await Refused(probes));
        Assert.Contains("users: Graph refused $orderby=createdDateTime desc; reading without it",
            OfKind(diagnostics, DiagnosticKinds.Probe).Select(e => e.Detail));

        var again = new Scripted(RefusesOrderBy);
        var second = await Read(Reader(again, probes: probes), fetch);

        Assert.All(second.Requests, r => Assert.DoesNotContain("$orderby", r));
        Assert.Equal(14, second.Objects.Count);
    }

    [Fact]
    public async Task A_sort_graph_ignores_is_caught_by_the_order_and_remembered()
    {
        var probes = Probes();
        var handler = new Scripted((r, _) => Json(HttpStatusCode.OK, r.RequestUri!.Query.Contains("$orderby")
            ? Dated("2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z")
            : Dated("2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z", "2026-10-02T00:00:00Z")));

        var result = await Read(Reader(handler, probes: probes), UsersFetch() with { Top = 2, OrderBy = new GraphOrderBy("createdDateTime", true) });

        Assert.Equal(3, result.Objects.Count);
        Assert.Equal(2, result.Requests.Count);
        Assert.Contains(GraphCollectionReader.OrderByClause, await Refused(probes));
    }

    // A null sorts last in KQL; Graph may put it first. That is the data's, not the table's: not remembered.
    [Fact]
    public async Task A_sort_with_an_empty_value_reads_again_without_it_and_is_not_remembered()
    {
        var probes = Probes();
        var handler = new Scripted((r, _) => Json(HttpStatusCode.OK, r.RequestUri!.Query.Contains("$orderby")
            ? Dated(null, "2026-10-03T00:00:00Z")
            : Dated(null, "2026-10-03T00:00:00Z", "2026-10-02T00:00:00Z")));

        var result = await Read(Reader(handler, probes: probes), UsersFetch() with { Top = 2, OrderBy = new GraphOrderBy("createdDateTime", true) });

        Assert.Equal(3, result.Objects.Count);
        Assert.Empty(await Refused(probes));
    }

    // filter clauses with a feature

    private static HttpResponseMessage RefusesEndsWith(HttpRequestMessage request, int n)
        => Uri.UnescapeDataString(request.RequestUri!.Query).Contains("endswith", StringComparison.Ordinal)
            ? Json(HttpStatusCode.BadRequest, Error("Request_UnsupportedQuery", "Unsupported or invalid query filter clause specified for property 'mail'."))
            : Json(HttpStatusCode.OK, Page(0, 4));

    [Fact]
    public async Task A_clause_that_needs_advanced_mode_sends_the_header_and_count()
    {
        var sent = new List<HttpRequestMessage>();
        var handler = new Scripted((r, _) =>
        {
            sent.Add(r);
            return Json(HttpStatusCode.OK, Page(0, 2));
        });

        await Read(Reader(handler), UsersFetch(Enabled, EndsWith));
        await Read(Reader(handler), UsersFetch(Enabled));

        Assert.True(IsAdvanced(sent[0]));
        // A filter without such a clause is read as before.
        Assert.False(HasHeader(sent[1]));
        Assert.DoesNotContain("$count", sent[1].RequestUri!.Query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_refused_clause_is_left_out_with_the_rest_kept_and_is_remembered()
    {
        var probes = Probes();
        var sent = new List<HttpRequestMessage>();
        var diagnostics = new RunDiagnostics(TimeProvider.System);
        var handler = new Scripted((r, n) =>
        {
            sent.Add(r);
            return RefusesEndsWith(r, n);
        });

        var result = await Read(Reader(handler, probes: probes), UsersFetch(Enabled, EndsWith) with { Top = 2 }, diagnostics: diagnostics);

        Assert.Equal(2, result.Requests.Count);
        Assert.Contains("$filter=" + Uri.EscapeDataString("accountEnabled eq true") + "&", result.Requests[1]);
        // The row limit goes too: the first rows of a wider filter aren't the query's.
        Assert.EndsWith("&$top=999", result.Requests[1], StringComparison.Ordinal);
        Assert.False(HasHeader(sent[1]));
        Assert.DoesNotContain("$count", result.Requests[1]);
        Assert.False(result.Unfiltered);
        Assert.Equal(4, result.Objects.Count);
        Assert.Equal(["endswith(mail)"], await Refused(probes));
        Assert.Contains("users: Graph refused the filter; reading without endswith(mail,'@contoso.com')",
            OfKind(diagnostics, DiagnosticKinds.Probe).Select(e => e.Detail));

        var again = new Scripted(RefusesEndsWith);
        var later = new RunDiagnostics(TimeProvider.System);
        var second = await Read(Reader(again, probes: probes), UsersFetch(Enabled, EndsWith), diagnostics: later);

        Assert.Equal(1, again.Calls);
        Assert.DoesNotContain("endswith", Uri.UnescapeDataString(second.Requests.Single()));
        Assert.Contains("users: left out (Graph refused it earlier) endswith(mail,'@contoso.com')", OfKind(later, DiagnosticKinds.Probe).Select(e => e.Detail));
    }

    [Fact]
    public async Task A_refused_plain_filter_is_still_dropped_whole()
    {
        var probes = Probes();
        var handler = new Scripted((r, _) => r.RequestUri!.Query.Contains("$filter")
            ? Json(HttpStatusCode.BadRequest, Error("Request_UnsupportedQuery", "Unsupported or invalid query filter clause."))
            : Json(HttpStatusCode.OK, Page(0, 2)));

        var result = await Read(Reader(handler, probes: probes), UsersFetch(Enabled, EndsWith));

        Assert.Equal(3, result.Requests.Count);
        Assert.True(result.Unfiltered);
        Assert.DoesNotContain("$filter", result.Requests[2]);
        Assert.Equal(["endswith(mail)"], await Refused(probes));
    }

    [Fact]
    public async Task Refresh_sends_a_refused_clause_again_and_forgets_it_when_graph_takes_it()
    {
        var probes = Probes();
        await probes.SetRefusedAsync(Account, "users", "endswith(mail)", true, CancellationToken.None);
        await probes.SetRefusedAsync(Account, "users", GraphCollectionReader.OrderByClause, true, CancellationToken.None);
        var handler = new Scripted((_, _) => Json(HttpStatusCode.OK, Dated("2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z")));

        var result = await Read(Reader(handler, probes: probes),
            UsersFetch(EndsWith) with { Top = 2, OrderBy = new GraphOrderBy("createdDateTime", true) }, refresh: true);

        Assert.Contains("endswith", Uri.UnescapeDataString(result.Requests[^1]));
        Assert.Contains("$orderby", result.Requests[^1]);
        Assert.Empty(await Refused(probes));
    }
}
