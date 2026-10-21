using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Kustodian.Auth.EntraApp;
using Kustodian.Graph.Fetch;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Auth.EntraApp;

public sealed class EntraAppClientTests
{
    private const string Account = "acct-1";
    private const string Graph = SourcePermissions.GraphAppId;
    private const string Arm = SourcePermissions.ArmAppId;

    private sealed record Seen(HttpMethod Method, string Uri, string? Body, string? AccountKey);

    private sealed class StubHandler(Func<Seen, (HttpStatusCode Status, string Json)> answer) : HttpMessageHandler
    {
        public List<Seen> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            var seen = new Seen(request.Method, Uri.UnescapeDataString(request.RequestUri!.ToString()), body,
                request.Options.TryGetValue(GraphRequestAccount.Key, out var key) ? key : null);
            Requests.Add(seen);
            var (status, json) = answer(seen);
            return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }

    private static PlannedPermission Perm(string name, string appId = Graph, bool admin = true)
        => new(appId == Graph ? "Microsoft Graph" : "Azure Service Management", appId, name, admin, "d", [], null, true);

    private static string SpWithScopes(string spId, params (string Name, string Id, string Type)[] scopes)
        => new JsonObject
        {
            ["id"] = spId,
            ["oauth2PermissionScopes"] = new JsonArray(scopes.Select(s => (JsonNode)new JsonObject
            {
                ["value"] = s.Name,
                ["id"] = s.Id,
                ["type"] = s.Type,
            }).ToArray()),
        }.ToJsonString();

    private static string Error(string code, string message)
        => new JsonObject { ["error"] = new JsonObject { ["code"] = code, ["message"] = message } }.ToJsonString();

    private static readonly EntraTenant Tenant = new("tenant-1", "Contoso");

    private static (HttpStatusCode, string) Happy(Seen s) => s.Uri switch
    {
        var u when u.Contains($"servicePrincipals(appId='{Graph}')") => (HttpStatusCode.OK, SpWithScopes("sp-graph",
            ("User.Read.All", "id-user", "Admin"), ("Mail.Read", "id-mail", "User"))),
        var u when u.Contains($"servicePrincipals(appId='{Arm}')") => (HttpStatusCode.OK, SpWithScopes("sp-arm",
            ("user_impersonation", "id-arm", "User"))),
        var u when u.EndsWith("/applications") => (HttpStatusCode.Created, """{"id":"obj-1","appId":"app-1"}"""),
        var u when u.Contains("/me?") => (HttpStatusCode.OK, """{"id":"me-1"}"""),
        var u when u.EndsWith("/owners/$ref") => (HttpStatusCode.NoContent, ""),
        var u when u.EndsWith("/servicePrincipals") => (HttpStatusCode.Created, """{"id":"sp-new"}"""),
        _ => (HttpStatusCode.NotFound, Error("Request_ResourceNotFound", "nope")),
    };

    /// <summary>A fake clock that counts the timers asked of it, so a test advances only once the client is waiting.</summary>
    private sealed class CountingTime : FakeTimeProvider
    {
        private int _timers;

        public int Timers => Volatile.Read(ref _timers);

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = base.CreateTimer(callback, state, dueTime, period);
            Interlocked.Increment(ref _timers);
            return timer;
        }
    }

    private static async Task WaitForTimersAsync(CountingTime time, int atLeast)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (time.Timers < atLeast)
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail($"Timed out waiting for timer {atLeast}; saw {time.Timers}.");
            }

            await Task.Delay(1, TestContext.Current.CancellationToken);
        }
    }

    private static (EntraAppClient Client, StubHandler Handler, CountingTime Time) New(
        Func<Seen, (HttpStatusCode, string)> answer)
    {
        var handler = new StubHandler(answer);
        var time = new CountingTime();
        return (new EntraAppClient(new HttpClient(handler), time), handler, time);
    }

    private static CreateRequest Request(params PlannedPermission[] permissions) => new("Kustodian", permissions);

    [Fact]
    public async Task Plan_reads_tenant_from_organization()
    {
        var (client, handler, _) = New(_ => (HttpStatusCode.OK, """{"value":[{"id":"t-9","displayName":"Fabrikam"}]}"""));

        var tenant = await client.TenantAsync(Account, TestContext.Current.CancellationToken);

        Assert.Equal(new EntraTenant("t-9", "Fabrikam"), tenant);
        Assert.Equal("https://graph.microsoft.com/v1.0/organization?$select=id,displayName", handler.Requests.Single().Uri);
    }

    [Fact]
    public async Task Create_sends_the_application_body()
    {
        var (client, handler, _) = New(Happy);

        await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All"), Perm("Mail.Read"), Perm("user_impersonation", Arm, false)),
            _ => { }, TestContext.Current.CancellationToken);

        var post = handler.Requests.Single(r => r.Method == HttpMethod.Post && r.Uri == "https://graph.microsoft.com/v1.0/applications");
        var body = JsonNode.Parse(post.Body!)!;
        Assert.Equal("Kustodian", (string?)body["displayName"]);
        Assert.Equal("AzureADMyOrg", (string?)body["signInAudience"]);
        Assert.True((bool?)body["isFallbackPublicClient"]);
        Assert.Equal(["http://localhost", "https://login.microsoftonline.com/common/oauth2/nativeclient"],
            body["publicClient"]!["redirectUris"]!.AsArray().Select(n => (string?)n).ToArray());
        var access = body["requiredResourceAccess"]!.AsArray();
        Assert.Equal(2, access.Count);
        var graph = access.Single(a => (string?)a!["resourceAppId"] == Graph)!["resourceAccess"]!.AsArray();
        Assert.Equal([("id-user", "Scope"), ("id-mail", "Scope")], graph.Select(a => ((string?)a!["id"], (string?)a["type"])).ToArray());
        var arm = access.Single(a => (string?)a!["resourceAppId"] == Arm)!["resourceAccess"]!.AsArray();
        Assert.Equal([("id-arm", "Scope")], arm.Select(a => ((string?)a!["id"], (string?)a["type"])).ToArray());
    }

    [Fact]
    public async Task Create_skips_Azure_lookup_when_user_impersonation_unticked()
    {
        var (client, handler, _) = New(Happy);

        await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);

        Assert.DoesNotContain(handler.Requests, r => r.Uri.Contains(Arm));
        var body = JsonNode.Parse(handler.Requests.Single(r => r.Uri.EndsWith("/applications")).Body!)!;
        Assert.Single(body["requiredResourceAccess"]!.AsArray());
    }

    [Fact]
    public async Task Unknown_scope_is_dropped_and_named()
    {
        var (client, handler, _) = New(Happy);

        var result = await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All"), Perm("Nope.Read.All")),
            _ => { }, TestContext.Current.CancellationToken);

        Assert.Equal(["Nope.Read.All"], result.Dropped);
        var body = JsonNode.Parse(handler.Requests.Single(r => r.Uri.EndsWith("/applications")).Body!)!;
        var ids = body["requiredResourceAccess"]![0]!["resourceAccess"]!.AsArray().Select(a => (string?)a!["id"]).ToArray();
        Assert.Equal(["id-user"], ids);
        Assert.Equal(("app-1", "obj-1", "tenant-1"), (result.AppId, result.ObjectId, result.TenantId));
    }

    [Fact]
    public async Task Owner_is_added_from_me()
    {
        var (client, handler, _) = New(Happy);

        var result = await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);

        Assert.True(result.OwnerAdded);
        Assert.Contains(handler.Requests, r => r.Method == HttpMethod.Get && r.Uri == "https://graph.microsoft.com/v1.0/me?$select=id");
        var owner = handler.Requests.Single(r => r.Uri.EndsWith("/owners/$ref"));
        Assert.Equal("https://graph.microsoft.com/v1.0/applications/obj-1/owners/$ref", owner.Uri);
        Assert.Equal("https://graph.microsoft.com/v1.0/directoryObjects/me-1", (string?)JsonNode.Parse(owner.Body!)!["@odata.id"]);
    }

    [Fact]
    public async Task Owner_already_present_counts_as_added_and_other_failures_do_not_stop_the_create()
    {
        var (client, _, _) = New(s => s.Uri.EndsWith("/owners/$ref")
            ? (HttpStatusCode.BadRequest, Error("Request_BadRequest", "One or more added object references already exist for the following modified properties: 'owners'."))
            : Happy(s));
        var result = await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);
        Assert.True(result.OwnerAdded);
        Assert.Null(result.OwnerMessage);

        var (client2, _, _) = New(s => s.Uri.EndsWith("/owners/$ref")
            ? (HttpStatusCode.Forbidden, Error("Authorization_RequestDenied", "Insufficient privileges"))
            : Happy(s));
        var result2 = await client2.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);
        Assert.False(result2.OwnerAdded);
        Assert.Contains("You were not added as owner", result2.OwnerMessage);
        Assert.Contains("Insufficient privileges", result2.OwnerMessage);
        Assert.Equal("app-1", result2.AppId);
    }

    [Fact]
    public async Task Service_principal_is_retried_on_404_and_400_with_backoff()
    {
        var spPosts = 0;
        var (client, _, time) = New(s =>
        {
            if (s.Method == HttpMethod.Post && s.Uri.EndsWith("/servicePrincipals"))
            {
                spPosts++;
                return spPosts switch
                {
                    1 => (HttpStatusCode.NotFound, Error("Request_ResourceNotFound", "app not found")),
                    2 => (HttpStatusCode.BadRequest, Error("Request_BadRequest", "app not found")),
                    _ => (HttpStatusCode.Created, """{"id":"sp-late"}"""),
                };
            }

            return Happy(s);
        });

        var task = client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);
        await WaitForTimersAsync(time, 1);
        Assert.Equal(1, spPosts);
        time.Advance(TimeSpan.FromMilliseconds(999));
        await Task.Delay(20, TestContext.Current.CancellationToken);
        Assert.Equal(1, spPosts);
        time.Advance(TimeSpan.FromMilliseconds(1));
        await WaitForTimersAsync(time, 2);
        Assert.Equal(2, spPosts);
        time.Advance(TimeSpan.FromSeconds(1));
        await Task.Delay(20, TestContext.Current.CancellationToken);
        Assert.Equal(2, spPosts);
        time.Advance(TimeSpan.FromSeconds(1));

        var result = await task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.Equal("sp-late", result.ServicePrincipalId);
        Assert.Equal(3, spPosts);
    }

    [Fact]
    public async Task Service_principal_gives_up_after_five_retries_at_1_2_4_8_8_seconds()
    {
        var spPosts = 0;
        var (client, _, time) = New(s =>
        {
            if (s.Method == HttpMethod.Post && s.Uri.EndsWith("/servicePrincipals"))
            {
                spPosts++;
                return (HttpStatusCode.NotFound, Error("Request_ResourceNotFound", "app not found"));
            }

            return Happy(s);
        });

        var task = client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);
        var expected = new[] { 1, 2, 4, 8, 8 };
        for (var i = 0; i < expected.Length; i++)
        {
            await WaitForTimersAsync(time, i + 1);
            Assert.Equal(i + 1, spPosts);
            // One tick short of the delay: no new attempt yet.
            time.Advance(TimeSpan.FromSeconds(expected[i]) - TimeSpan.FromMilliseconds(1));
            await Task.Delay(20, TestContext.Current.CancellationToken);
            Assert.Equal(i + 1, spPosts);
            time.Advance(TimeSpan.FromMilliseconds(1));
        }

        var result = await task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.Equal(6, spPosts);
        Assert.Null(result.ServicePrincipalId);
        Assert.False(string.IsNullOrEmpty(result.ServicePrincipalMessage));
        Assert.Equal("app-1", result.AppId);
    }

    [Fact]
    public async Task Service_principal_403_returns_app_without_principal()
    {
        var spPosts = 0;
        var (client, _, _) = New(s =>
        {
            if (s.Method == HttpMethod.Post && s.Uri.EndsWith("/servicePrincipals"))
            {
                spPosts++;
                return (HttpStatusCode.Forbidden, Error("Authorization_RequestDenied", "Insufficient privileges"));
            }

            return Happy(s);
        });

        var result = await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);

        Assert.Equal(1, spPosts);
        Assert.Null(result.ServicePrincipalId);
        Assert.Equal("app-1", result.AppId);
        Assert.Contains("You can't create its enterprise application; an admin's consent (next step) creates it.", result.ServicePrincipalMessage);
    }

    [Fact]
    public async Task Retrying_the_service_principal_only_repeats_that_step()
    {
        var (client, handler, _) = New(Happy);
        var partial = new CreateResult("app-1", "obj-1", null, "tenant-1", true, null, ["X"], "gone", ["A.Read"]);

        var result = await client.RetryServicePrincipalAsync(Account, partial, TestContext.Current.CancellationToken);

        Assert.Equal("sp-new", result.ServicePrincipalId);
        Assert.Null(result.ServicePrincipalMessage);
        Assert.Equal(["X"], result.Dropped);
        Assert.Equal(["A.Read"], result.AdminScopes);
        var only = handler.Requests.Single();
        Assert.Equal("https://graph.microsoft.com/v1.0/servicePrincipals", only.Uri);
        Assert.Equal("app-1", (string?)JsonNode.Parse(only.Body!)!["appId"]);
    }

    [Fact]
    public async Task Service_principal_400_already_exists_reads_the_existing_principal_without_retry()
    {
        var spPosts = 0;
        var (client, handler, _) = New(s =>
        {
            if (s.Method == HttpMethod.Post && s.Uri.EndsWith("/servicePrincipals"))
            {
                spPosts++;
                return (HttpStatusCode.BadRequest, Error("Request_MultipleObjectsWithSameKeyValue", "A service principal with that appId already exists."));
            }

            return s.Uri.Contains("servicePrincipals(appId='app-1')") ? (HttpStatusCode.OK, """{"id":"sp-there"}""") : Happy(s);
        });

        var result = await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken)
            .WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        Assert.Equal("sp-there", result.ServicePrincipalId);
        Assert.Null(result.ServicePrincipalMessage);
        Assert.Equal(1, spPosts);
        Assert.Contains(handler.Requests, r => r.Uri == "https://graph.microsoft.com/v1.0/servicePrincipals(appId='app-1')?$select=id");
    }

    public static TheoryData<string> Transport => ["http", "timeout"];

    private static Exception Failure(string kind) => kind == "http"
        ? new HttpRequestException("connection reset")
        : new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout");

    [Theory]
    [MemberData(nameof(Transport))]
    public async Task Owner_step_transport_failure_keeps_the_created_app(string kind)
    {
        var (client, _, _) = New(s => s.Uri.EndsWith("/owners/$ref") ? throw Failure(kind) : Happy(s));

        var result = await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);

        Assert.False(result.OwnerAdded);
        Assert.Contains("You were not added as owner", result.OwnerMessage);
        Assert.Equal(("app-1", "obj-1", "sp-new"), (result.AppId, result.ObjectId, result.ServicePrincipalId));
    }

    [Theory]
    [MemberData(nameof(Transport))]
    public async Task Service_principal_step_transport_failure_keeps_the_created_app(string kind)
    {
        var (client, _, _) = New(s => s.Method == HttpMethod.Post && s.Uri.EndsWith("/servicePrincipals") ? throw Failure(kind) : Happy(s));

        var result = await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken);

        Assert.Equal(("app-1", "obj-1"), (result.AppId, result.ObjectId));
        Assert.Null(result.ServicePrincipalId);
        Assert.False(string.IsNullOrEmpty(result.ServicePrincipalMessage));
    }

    [Fact]
    public async Task Caller_cancellation_still_propagates_from_the_service_principal_step()
    {
        using var cts = new CancellationTokenSource();
        var (client, _, _) = New(s =>
        {
            if (s.Uri.EndsWith("/servicePrincipals") && s.Method == HttpMethod.Post)
            {
                cts.Cancel();
                throw new OperationCanceledException(cts.Token);
            }

            return Happy(s);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, cts.Token));
    }

    [Fact]
    public async Task Create_403_means_nothing_created()
    {
        var (client, _, _) = New(s => s.Uri.EndsWith("/applications")
            ? (HttpStatusCode.Forbidden, Error("Authorization_RequestDenied", "Insufficient privileges"))
            : Happy(s));

        var ex = await Assert.ThrowsAsync<EntraAppException>(() =>
            client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken));

        Assert.True(ex.NothingCreated);
        Assert.Equal("Your tenant doesn't let you register applications. An admin can turn on 'Users can register applications', "
            + "give you the Application Developer role, or create the app for you.", ex.Message);
    }

    [Fact]
    public async Task Lookup_failure_means_nothing_created()
    {
        var (client, handler, _) = New(_ => (HttpStatusCode.Forbidden, Error("Authorization_RequestDenied", "No read for you")));

        var ex = await Assert.ThrowsAsync<EntraAppException>(() =>
            client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken));

        Assert.True(ex.NothingCreated);
        Assert.StartsWith("Kustodian couldn't read Microsoft Graph's permission list in your tenant.", ex.Message);
        Assert.Contains("No read for you", ex.Message);
        Assert.DoesNotContain(handler.Requests, r => r.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task Steps_are_reported_in_order()
    {
        var (client, _, _) = New(Happy);
        var steps = new List<CreateStep>();

        await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), steps.Add, TestContext.Current.CancellationToken);

        Assert.Equal([CreateStep.LookUp, CreateStep.CreateApp, CreateStep.AddOwner, CreateStep.CreateServicePrincipal], steps);
    }

    [Fact]
    public async Task Sign_in_problems_propagate_unchanged()
    {
        var handler = new ThrowingHandler(new Kustodian.Graph.Run.SignInRequiredException("sign in"));
        var client = new EntraAppClient(new HttpClient(handler), new FakeTimeProvider());

        await Assert.ThrowsAsync<Kustodian.Graph.Run.SignInRequiredException>(() =>
            client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All")), _ => { }, TestContext.Current.CancellationToken));
    }

    private sealed class ThrowingHandler(Exception ex) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => throw ex;
    }

    [Fact]
    public async Task ConsentStatus_finds_principal_by_appId_and_reads_AllPrincipals_grants()
    {
        var (client, handler, _) = New(s => s.Uri switch
        {
            var u when u.Contains("servicePrincipals(appId='app-1')") => (HttpStatusCode.OK, """{"id":"sp-7"}"""),
            var u when u.Contains("oauth2PermissionGrants") => (HttpStatusCode.OK,
                """{"value":[{"scope":" User.Read.All Mail.Read"},{"scope":"user_impersonation User.Read.All"}]}"""),
            _ => (HttpStatusCode.NotFound, ""),
        });

        var status = await client.ConsentStatusAsync(Account, "app-1", ["User.Read.All", "Policy.Read.All", "Audit.Read.All"],
            TestContext.Current.CancellationToken);

        Assert.Equal(["Mail.Read", "User.Read.All", "user_impersonation"], status.Granted);
        Assert.Equal(["Policy.Read.All", "Audit.Read.All"], status.Missing);
        Assert.Equal("https://graph.microsoft.com/v1.0/servicePrincipals(appId='app-1')?$select=id", handler.Requests[0].Uri);
        Assert.Equal("https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=clientId eq 'sp-7' and consentType eq 'AllPrincipals'",
            handler.Requests[1].Uri);
    }

    [Fact]
    public async Task ConsentStatus_with_no_principal_means_everything_is_missing()
    {
        var (client, handler, _) = New(_ => (HttpStatusCode.NotFound, Error("Request_ResourceNotFound", "none")));

        var status = await client.ConsentStatusAsync(Account, "app-1", ["A.Read", "B.Read"], TestContext.Current.CancellationToken);

        Assert.Empty(status.Granted);
        Assert.Equal(["A.Read", "B.Read"], status.Missing);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task CanGrant_true_for_listed_roles_false_otherwise_null_on_failure()
    {
        const string Gets = "https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.directoryRole?$select=roleTemplateId";

        var (yes, handler, _) = New(_ => (HttpStatusCode.OK,
            """{"value":[{"roleTemplateId":"fe930be7-5e62-47db-91af-98c3a49a38b1"},{"roleTemplateId":"9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3"}]}"""));
        Assert.True(await yes.CanGrantAsync(Account, TestContext.Current.CancellationToken));
        Assert.Equal(Gets, handler.Requests.Single().Uri);

        var (no, _, _) = New(_ => (HttpStatusCode.OK, """{"value":[{"roleTemplateId":"fe930be7-5e62-47db-91af-98c3a49a38b1"}]}"""));
        Assert.False(await no.CanGrantAsync(Account, TestContext.Current.CancellationToken));

        var (failed, _, _) = New(_ => (HttpStatusCode.Forbidden, Error("Authorization_RequestDenied", "x")));
        Assert.Null(await failed.CanGrantAsync(Account, TestContext.Current.CancellationToken));

        var (timedOut, _, _) = New(_ => throw new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout"));
        Assert.Null(await timedOut.CanGrantAsync(Account, TestContext.Current.CancellationToken));

        var (reset, _, _) = New(_ => throw new HttpRequestException("reset"));
        Assert.Null(await reset.CanGrantAsync(Account, TestContext.Current.CancellationToken));
    }

    [Fact]
    public void ConsentUrl_is_exact()
    {
        static string E(string v) => Uri.EscapeDataString(v);
        var baseUrl = "https://login.microsoftonline.com/t-1/v2.0/adminconsent?client_id=a-1"
            + $"&scope={E("https://graph.microsoft.com/.default")}"
            + $"&redirect_uri={E("https://login.microsoftonline.com/common/oauth2/nativeclient")}";

        Assert.Equal(baseUrl, EntraAppClient.ConsentUrl("t-1", "a-1", null).AbsoluteUri);
        Assert.Equal(baseUrl + "&state=s%201", EntraAppClient.ConsentUrl("t-1", "a-1", "s 1").AbsoluteUri);

        var query = System.Web.HttpUtility.ParseQueryString(EntraAppClient.ConsentUrl("t-1", "a-1", null).Query);
        Assert.Equal("https://graph.microsoft.com/.default", query["scope"]);
        Assert.Equal("https://login.microsoftonline.com/common/oauth2/nativeclient", query["redirect_uri"]);
        Assert.Equal("a-1", query["client_id"]);
    }

    [Fact]
    public async Task Admin_scopes_follow_the_tenant_type_and_fall_back_to_the_bundled_flag()
    {
        var (client, _, _) = New(s => s.Uri.Contains($"appId='{Graph}'")
            ? (HttpStatusCode.OK, SpWithScopes("sp-graph",
                ("Bundled.Admin.TenantUser", "i1", "User"), ("Bundled.User.TenantAdmin", "i2", "Admin"), ("Both.Admin", "i3", "Admin")))
            : Happy(s));

        var result = await client.CreateAsync(Account, Tenant,
            Request(Perm("Bundled.Admin.TenantUser", admin: true), Perm("Bundled.User.TenantAdmin", admin: false), Perm("Both.Admin"), Perm("Gone.Read")),
            _ => { }, TestContext.Current.CancellationToken);

        Assert.Equal(["Bundled.User.TenantAdmin", "Both.Admin"], result.AdminScopes);
        Assert.Equal(["Gone.Read"], result.Dropped);
    }

    [Fact]
    public async Task Requests_name_the_account()
    {
        var (client, handler, _) = New(s => s.Uri switch
        {
            var u when u.Contains("organization") => (HttpStatusCode.OK, """{"value":[{"id":"t","displayName":"d"}]}"""),
            var u when u.Contains("memberOf") => (HttpStatusCode.OK, """{"value":[]}"""),
            var u when u.Contains("oauth2PermissionGrants") => (HttpStatusCode.OK, """{"value":[]}"""),
            var u when u.Contains("appId='x'") => (HttpStatusCode.OK, """{"id":"sp"}"""),
            _ => Happy(s),
        });
        var ct = TestContext.Current.CancellationToken;

        await client.TenantAsync(Account, ct);
        await client.CreateAsync(Account, Tenant, Request(Perm("User.Read.All"), Perm("user_impersonation", Arm, false)), _ => { }, ct);
        await client.ConsentStatusAsync(Account, "x", ["A"], ct);
        await client.CanGrantAsync(Account, ct);

        Assert.True(handler.Requests.Count >= 10);
        Assert.All(handler.Requests, r => Assert.Equal(Account, r.AccountKey));
    }
}
