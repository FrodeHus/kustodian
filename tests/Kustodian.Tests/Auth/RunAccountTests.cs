using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.App;
using Kustodian.Auth;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Storage;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Tests.Auth;

/// <summary>Spec 6.7: each run uses the account that is active when it starts. The real account service and token handler over
/// a fake Graph that holds the first page until the test has switched or signed out, and the app itself as the engine
/// worker.</summary>
public sealed class RunAccountTests : IAsyncDisposable
{
    private const string Kql = "applications | project displayName";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly GraphEnginePool _engine = new(
        new GraphEngineOptions { Workers = 1, WorkerPath = Path.Combine(AppContext.BaseDirectory, "Kustodian.dll"), WorkerArgs = ["--engine"] },
        NullLogger<GraphEnginePool>.Instance, TimeProvider.System);

    public async ValueTask DisposeAsync()
    {
        await _engine.DisposeAsync();
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    [Fact]
    public async Task A_run_keeps_its_starting_account_when_another_becomes_active_mid_fetch()
    {
        var (service, first, second) = await TwoAccountsAsync();
        var graph = new PagedGraph();
        var runner = Runner(service, graph);

        var run = runner.RunAsync(first.Key, Kql, refresh: false, null, Ct);
        await graph.FirstPageHeld.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        await service.UseAsync(second.Key);
        graph.Release.SetResult();
        var r = await run.WaitAsync(TimeSpan.FromSeconds(60), Ct);

        Assert.Equal(RunOutcome.Ok, r.Outcome);
        Assert.Equal(2, r.Total);
        Assert.Equal(2, graph.Authorizations.Count);
        Assert.All(graph.Authorizations, a => Assert.Equal("Bearer tok-1", a));
    }

    [Fact]
    public async Task A_run_whose_account_signs_out_mid_fetch_ends_as_sign_in_needed()
    {
        var (service, first, _) = await TwoAccountsAsync();
        var graph = new PagedGraph();
        var runner = Runner(service, graph);

        var run = runner.RunAsync(first.Key, Kql, refresh: false, null, Ct);
        await graph.FirstPageHeld.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        await service.SignOutAsync(first.Key);
        graph.Release.SetResult();
        var r = await run.WaitAsync(TimeSpan.FromSeconds(60), Ct);

        Assert.Equal((RunOutcome.SignInNeeded, GraphRunner.SignInMessage), (r.Outcome, r.Message));
        // The second page was never sent, and never with the account that became active.
        Assert.Equal(["Bearer tok-1"], graph.Authorizations);
    }

    /// <summary>Ada (tok-1) then Bob (tok-2) signed in, with Ada active again.</summary>
    private async Task<(AccountService Service, AccountInfo First, AccountInfo Second)> TwoAccountsAsync()
    {
        var msal = new TokenPerAccountMsal();
        var service = new AccountService(_ => msal, new JsonFileStore(_dir));
        var first = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        msal.Next = ("home-2", "bob@fabrikam.com", "tenant-2");
        var second = await service.SignInInteractiveAsync(ClientConfig.AzureCli, Ct);
        await service.UseAsync(first.Key);
        return (service, first, second);
    }

    private GraphRunner Runner(AccountService service, PagedGraph graph)
    {
        var http = new HttpClient(new GraphAuthHandler(service) { InnerHandler = graph }) { BaseAddress = GraphHttp.BaseAddress };
        var budget = new GraphFetchBudget();
        return new GraphRunner(GraphSchemaCatalog.Beta, new GraphCollectionReader(http, budget, NoGraphObjectCache.Instance,
            GraphLimits.Default), budget, _engine, GraphLimits.Default, TimeProvider.System);
    }

    /// <summary>Two pages of applications. The first is held until <see cref="Release"/>; its token was already attached, so
    /// the second page's token is asked for after whatever the test did meanwhile.</summary>
    private sealed class PagedGraph : HttpMessageHandler
    {
        public ConcurrentQueue<string?> Authorizations { get; } = new();

        public TaskCompletionSource FirstPageHeld { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Authorizations.Enqueue(request.Headers.Authorization?.ToString());
            var second = request.RequestUri!.Query.Contains("skiptoken", StringComparison.Ordinal);
            if (!second)
            {
                FirstPageHeld.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }

            var body = second
                ? JsonSerializer.Serialize(new { value = new[] { new { id = "2", displayName = "Wiki" } } })
                : JsonSerializer.Serialize(new Dictionary<string, object>
                {
                    ["value"] = new[] { new { id = "1", displayName = "Payroll" } },
                    ["@odata.nextLink"] = "https://graph.microsoft.com/beta/applications?$skiptoken=2",
                });
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    /// <summary>MSAL with one token per account: home-1 gets tok-1, home-2 tok-2.</summary>
    private sealed class TokenPerAccountMsal : IMsalClient
    {
        private readonly Dictionary<string, MsalAccount> _cached = [];

        public (string Home, string User, string Tenant) Next { get; set; } = ("home-1", "ada@contoso.com", "tenant-1");

        public Task<MsalSignIn> AcquireInteractiveAsync(string scope, CancellationToken ct) => Task.FromResult(SignIn());

        public Task<MsalSignIn> AcquireDeviceCodeAsync(string scope, Action<string> showCode, CancellationToken ct) =>
            Task.FromResult(SignIn());

        public Task<MsalToken> AcquireSilentAsync(string homeAccountId, string scope, CancellationToken ct) =>
            _cached.ContainsKey(homeAccountId)
                ? Task.FromResult(new MsalToken(TokenFor(homeAccountId), DateTimeOffset.UtcNow.AddHours(1)))
                : throw new Microsoft.Identity.Client.MsalUiRequiredException("ui_required", "sign in again");

        public Task<IReadOnlyList<MsalAccount>> GetAccountsAsync() => Task.FromResult<IReadOnlyList<MsalAccount>>([.. _cached.Values]);

        public Task RemoveAsync(string homeAccountId)
        {
            _cached.Remove(homeAccountId);
            return Task.CompletedTask;
        }

        private static string TokenFor(string homeAccountId) => homeAccountId.Replace("home", "tok", StringComparison.Ordinal);

        private MsalSignIn SignIn()
        {
            var account = new MsalAccount(Next.Home, Next.User, Next.Tenant);
            _cached[account.HomeAccountId] = account;
            return new MsalSignIn(account, new MsalToken(TokenFor(account.HomeAccountId), DateTimeOffset.UtcNow.AddHours(1)));
        }
    }
}
