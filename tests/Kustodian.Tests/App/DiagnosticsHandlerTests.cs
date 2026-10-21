using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.App;
using Kustodian.Auth;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Messaging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.App;

/// <summary>The HTTP pipeline's request log: <see cref="DiagnosticsHandler"/> inside the token handler, as
/// <see cref="GraphHttp"/> builds it, over a fake Graph, and a whole run through it on the app itself as the engine worker.</summary>
public sealed class DiagnosticsHandlerTests : IAsyncDisposable
{
    private const string Account = "account-1";
    private const string Token = "eyJ0eXAiOiJKV1QiLCJzZWNyZXQiOiJ0b2tlbiJ9.secret-token-value";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly GraphEnginePool _engine = new(
        new GraphEngineOptions { Workers = 1, WorkerPath = Path.Combine(AppContext.BaseDirectory, "Kustodian.dll"), WorkerArgs = ["--engine"] },
        NullLogger<GraphEnginePool>.Instance, TimeProvider.System);

    public ValueTask DisposeAsync() => _engine.DisposeAsync();

    [Fact]
    public async Task Logs_method_relative_url_status_duration_and_content_length()
    {
        var time = new FakeTimeProvider();
        var diagnostics = new RunDiagnostics(time);
        var graph = new Graph(time);
        using var http = Client(graph);

        using var page = new HttpRequestMessage(HttpMethod.Get, "applications?$select=id%2CdisplayName&$top=999").ForAccount(Account).ForRun(diagnostics);
        using var probe = new HttpRequestMessage(HttpMethod.Get, "applications?$select=id&$top=1").ForAccount(Account)
            .ForRun(diagnostics, DiagnosticKinds.Probe);
        using var untagged = new HttpRequestMessage(HttpMethod.Get, "groups").ForAccount(Account);
        (await http.SendAsync(page, Ct)).Dispose();
        var pageLength = graph.LastLength;
        (await http.SendAsync(probe, Ct)).Dispose();
        var probeLength = graph.LastLength;
        (await http.SendAsync(untagged, Ct)).Dispose();

        Assert.Equal(
            [
                new DiagnosticEntry(0, "request", "GET applications?$select=id%2CdisplayName&$top=999", 200, 40, pageLength),
                new DiagnosticEntry(40, "probe", "GET applications?$select=id&$top=1", 200, 40, probeLength),
            ],
            diagnostics.Entries);
    }

    [Fact]
    public async Task Arm_requests_are_logged_relative_to_arm()
    {
        var diagnostics = new RunDiagnostics(new FakeTimeProvider());
        using var http = new HttpClient(new ArmAuthHandler(new FixedTokens())
        {
            InnerHandler = new DiagnosticsHandler { InnerHandler = new Answering(HttpStatusCode.OK) },
        })
        {
            BaseAddress = ArmHttp.BaseAddress,
        };

        using var request = new HttpRequestMessage(HttpMethod.Post,
            "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01").ForAccount(Account).ForRun(diagnostics);
        (await http.SendAsync(request, Ct)).Dispose();

        var entry = Assert.Single(diagnostics.Entries);
        Assert.Equal("POST providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01", entry.Detail);
        Assert.Equal(200, entry.Status);
    }

    private sealed class Answering(HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent("{}") });
    }

    [Fact]
    public async Task Without_content_length_the_reader_records_the_bytes_it_read()
    {
        var diagnostics = new RunDiagnostics(TimeProvider.System);
        var graph = new Graph(TimeProvider.System) { Chunked = true };
        using var http = Client(graph);
        var reader = new GraphCollectionReader(http, new GraphFetchBudget(), NoGraphObjectCache.Instance, GraphLimits.Default);
        var fetch = new GraphFetch(GraphSchemaCatalog.Beta.Tables.Single(t => t.Name == "applications"), ["id", "displayName"], null);

        await reader.ReadAsync(Account, fetch, new GraphFetchBudget().Lease(), false, diagnostics, Ct);

        var entry = Assert.Single(diagnostics.Entries);
        Assert.Equal(graph.LastLength, entry.Bytes);
        Assert.True(entry.Bytes > 0);
    }

    [Fact]
    public async Task A_request_without_an_answer_is_logged_without_a_status()
    {
        var diagnostics = new RunDiagnostics(TimeProvider.System);
        var graph = new Graph(TimeProvider.System) { Fail = true };
        using var http = Client(graph);
        using var request = new HttpRequestMessage(HttpMethod.Get, "applications").ForAccount(Account).ForRun(diagnostics);

        await Assert.ThrowsAsync<HttpRequestException>(() => http.SendAsync(request, Ct));

        var entry = Assert.Single(diagnostics.Entries);
        Assert.Equal(("request", "GET applications (no answer)", (int?)null, (long?)null), (entry.Kind, entry.Detail, entry.Status, entry.Bytes));
    }

    [Fact]
    public async Task Every_request_is_logged_with_status_duration_and_bytes()
    {
        var graph = new Graph(TimeProvider.System);

        var result = await Runner(graph).RunAsync(Account, "applications | project displayName, passwordCredentials", false, null, Ct);

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        var sent = result.Diagnostics.Where(e => e.Kind is "request" or "probe" or "per-object" && e.Status is not null).ToList();
        Assert.Equal(graph.Seen.Count, sent.Count);
        Assert.Equal(graph.Seen.Order(StringComparer.Ordinal), sent.Select(e => e.Detail).Order(StringComparer.Ordinal));
        Assert.All(sent, e =>
        {
            Assert.NotNull(e.DurationMs);
            Assert.True(e.Bytes > 0, e.Detail);
        });
        // The list page that failed, the probes that found the column, the list without it, and the per-object batch.
        Assert.Equal(404, sent.First(e => e.Kind == "request").Status);
        Assert.Contains(sent, e => e.Kind == "probe");
        Assert.Contains(sent, e => e is { Kind: "per-object", Detail: "POST $batch", Status: 200 });
        Assert.All(result.Diagnostics, e => Assert.DoesNotContain("https://", e.Detail, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Diagnostics_never_contain_authorization_or_token()
    {
        var graph = new Graph(TimeProvider.System);

        var result = await Runner(graph).RunAsync(Account, "applications | project displayName, passwordCredentials", false, null, Ct);

        Assert.Equal(RunOutcome.Ok, result.Outcome);
        // The token did go out, on every request.
        Assert.All(graph.Authorizations, a => Assert.Equal("Bearer " + Token, a));
        Assert.NotEmpty(result.Diagnostics);
        foreach (var entry in result.Diagnostics)
        {
            Assert.DoesNotContain(Token, entry.Detail, StringComparison.Ordinal);
            Assert.DoesNotContain("Bearer", entry.Detail, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("Authorization", entry.Detail, StringComparison.OrdinalIgnoreCase);
        }

        var wire = JsonSerializer.Serialize(result, BridgeJson.Options);
        Assert.Contains("\"diagnostics\":[", wire, StringComparison.Ordinal);
        Assert.DoesNotContain(Token, wire, StringComparison.Ordinal);
        Assert.DoesNotContain(Token.Split('.')[0], wire, StringComparison.Ordinal);
        Assert.DoesNotContain("Bearer", wire, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Authorization", wire, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The token handler over the diagnostics handler over <paramref name="graph"/>, as <see cref="GraphHttp"/> builds
    /// the chain with a socket handler at the bottom.</summary>
    private static HttpClient Client(Graph graph) =>
        new(new GraphAuthHandler(new FixedTokens()) { InnerHandler = new DiagnosticsHandler { InnerHandler = graph } })
        {
            BaseAddress = GraphHttp.BaseAddress,
        };

    private GraphRunner Runner(Graph graph)
    {
        var budget = new GraphFetchBudget();
        return new GraphRunner(GraphSchemaCatalog.Beta, new GraphCollectionReader(Client(graph), budget, NoGraphObjectCache.Instance,
            GraphLimits.Default), budget, _engine, GraphLimits.Default, TimeProvider.System);
    }

    private sealed class FixedTokens : ITokenSource
    {
        public Task<string> GetTokenAsync(string accountKey, Audience audience, CancellationToken ct) => Task.FromResult(Token);
    }

    /// <summary>Three applications. Each answer takes 40 ms on <paramref name="time"/>. A list or probe that selects
    /// <c>passwordCredentials</c> answers a 404 web page, so it is read one object at a time through <c>$batch</c>.
    /// <see cref="Seen"/> holds each request as the log shows it: method and URL relative to the Graph version.</summary>
    private sealed class Graph(TimeProvider time) : HttpMessageHandler
    {
        public ConcurrentQueue<string> Seen { get; } = new();

        public ConcurrentQueue<string?> Authorizations { get; } = new();

        public bool Chunked { get; init; }

        public bool Fail { get; init; }

        public long LastLength { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Seen.Enqueue(request.Method.Method + " " + request.RequestUri!.AbsoluteUri[GraphHttp.BaseAddress.AbsoluteUri.Length..]);
            Authorizations.Enqueue(request.Headers.Authorization?.ToString());
            (time as FakeTimeProvider)?.Advance(TimeSpan.FromMilliseconds(40));
            if (Fail)
            {
                throw new HttpRequestException("The connection was reset.");
            }

            if (request.Method == HttpMethod.Post)
            {
                var batch = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
                var responses = batch["requests"]!.AsArray().Select(r => new
                {
                    id = r!["id"]!.GetValue<string>(),
                    status = 200,
                    body = new { id = r["url"]!.GetValue<string>().Split('/')[2].Split('?')[0], passwordCredentials = Array.Empty<object>() },
                });
                return Json(HttpStatusCode.OK, new { responses });
            }

            var query = Uri.UnescapeDataString(request.RequestUri.Query);
            if (query.Contains("passwordCredentials", StringComparison.Ordinal))
            {
                return Json(HttpStatusCode.NotFound, new { error = new { code = "UnknownError", message = "<!DOCTYPE html><html><title>404</title></html>" } });
            }

            var top = query.Contains("$top=1", StringComparison.Ordinal) && !query.Contains("$top=999", StringComparison.Ordinal) ? 1 : 3;
            return Json(HttpStatusCode.OK, new { value = Enumerable.Range(0, top).Select(i => new { id = i.ToString(), displayName = "App " + i }) });
        }

        private HttpResponseMessage Json(HttpStatusCode status, object body)
        {
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(body));
            LastLength = bytes.Length;
            HttpContent content = Chunked ? new StreamContent(new UnseekableStream(bytes)) : new ByteArrayContent(bytes);
            content.Headers.ContentType = new("application/json");
            return new HttpResponseMessage(status) { Content = content };
        }
    }

    /// <summary>A body whose length isn't known up front, as a chunked response's isn't.</summary>
    private sealed class UnseekableStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
    }
}
