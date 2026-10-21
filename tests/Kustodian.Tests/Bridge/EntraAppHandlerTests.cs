using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Auth;
using Kustodian.Auth.EntraApp;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Messaging;
using Kustodian.Messaging.Handlers;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Bridge;

public class EntraAppHandlerTests
{
    private const string AppId = "11111111-2222-3333-4444-555555555555";
    private const string Tenant = "tenant-from-graph";

    private sealed class FakeBrowser : ISystemBrowser
    {
        public List<Uri> Opened { get; } = [];

        public void Open(Uri url) => Opened.Add(url);
    }

    private sealed class Harness
    {
        public List<(string Method, string Uri)> Graph { get; } = [];

        public List<string> Events { get; } = [];

        public FakeBrowser Browser { get; } = new();

        public Func<HttpRequestMessage, HttpResponseMessage>? Answer { get; set; }

        public Messaging.Bridge Bridge { get; }

        public Harness(AccountInfo? account)
        {
            var stub = new Stub(request =>
            {
                Graph.Add((request.Method.Method, request.RequestUri!.ToString()));
                return Answer?.Invoke(request) ?? Respond(request);
            });
            Bridge = new Messaging.Bridge(Events.Add);
            new EntraAppHandler(new EntraAppClient(new HttpClient(stub), new FakeTimeProvider()),
                () => Task.FromResult(account), Browser, () => "state-1").Register(Bridge);
        }

        private static HttpResponseMessage Respond(HttpRequestMessage request) =>
            request.RequestUri!.AbsolutePath.EndsWith("/organization", StringComparison.Ordinal)
                ? Json(HttpStatusCode.OK, $$"""{"value":[{"id":"{{Tenant}}","displayName":"Contoso"}]}""")
                : Json(HttpStatusCode.NotFound, "{}");

        public async Task<JsonElement> Call(string method, string args = "{}")
        {
            var reply = await Bridge.HandleAsync("{\"id\":\"a\",\"method\":\"" + method + "\",\"params\":" + args + "}");
            Assert.NotNull(reply);
            using var doc = JsonDocument.Parse(reply);
            return doc.RootElement.Clone();
        }
    }

    private sealed class Stub(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(answer(request));
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static AccountInfo Account(
        string clientId = ClientConfig.AzureCliClientId, bool expired = false, params string[] scopes) =>
        new("acct-1", "ada@contoso.com", "Contoso", "home-tenant", clientId, true, expired,
            scopes.Length == 0 ? ["Application.ReadWrite.All"] : scopes);

    /// <summary>A Graph permission the real plan offers, so the tests don't depend on which one the cover picks.</summary>
    private static readonly string Offered = PermissionPlanner.Plan(
            GraphPermissionCatalog.Bundled, GraphSchemaCatalog.Beta.Tables, GraphAreas.Bundled)
        .Groups.First(g => g.Id == "graph").Subgroups.SelectMany(x => x.Permissions).First().Name;

    private static string OfferedRef => $$"""{"resource":"Microsoft Graph","name":"{{Offered}}"}""";

    private static string ErrorCode(JsonElement reply) => reply.GetProperty("error").GetProperty("code").GetString()!;

    [Fact]
    public async Task Plan_can_create_reads_tenant_and_names_the_default()
    {
        var h = new Harness(Account());

        var reply = await h.Call("entraApp.plan");

        var result = reply.GetProperty("result");
        Assert.True(result.GetProperty("canCreate").GetBoolean());
        Assert.False(result.TryGetProperty("reason", out _));
        Assert.Equal("Kustodian (ada@contoso.com)", result.GetProperty("defaultName").GetString());
        Assert.Equal(Tenant, result.GetProperty("tenantId").GetString());
        Assert.Equal("Contoso", result.GetProperty("tenantName").GetString());
        Assert.Equal(["graph", "security", "azure"], result.GetProperty("groups").EnumerateArray().Select(g => g.GetProperty("id").GetString()));
        Assert.True(result.GetProperty("tablesWithData").GetInt32() > 0);
        Assert.Single(h.Graph);
    }

    [Fact]
    public async Task Plan_cannot_create_without_scope()
    {
        var h = new Harness(Account(scopes: "User.Read"));

        var result = (await h.Call("entraApp.plan")).GetProperty("result");

        Assert.False(result.GetProperty("canCreate").GetBoolean());
        Assert.Equal("This sign-in can't create app registrations (it needs Application.ReadWrite.All).", result.GetProperty("reason").GetString());
        Assert.NotEqual(0, result.GetProperty("groups").GetArrayLength());
        Assert.Empty(h.Graph);
    }

    [Fact]
    public async Task Plan_cannot_create_for_own_client_or_expired_account()
    {
        var own = new Harness(Account(clientId: "00000000-0000-0000-0000-00000000c1ie"));
        var expired = new Harness(Account(expired: true));

        Assert.False((await own.Call("entraApp.plan")).GetProperty("result").GetProperty("canCreate").GetBoolean());
        Assert.False((await expired.Call("entraApp.plan")).GetProperty("result").GetProperty("canCreate").GetBoolean());
        Assert.Empty(own.Graph);
        Assert.Empty(expired.Graph);
    }

    [Fact]
    public async Task Plan_accepts_directory_access_as_user_scope()
    {
        var h = new Harness(Account(scopes: "Directory.AccessAsUser.All"));

        Assert.True((await h.Call("entraApp.plan")).GetProperty("result").GetProperty("canCreate").GetBoolean());
    }

    [Fact]
    public async Task Create_rejects_write_or_unknown_permission()
    {
        var h = new Harness(Account());

        var write = await h.Call("entraApp.create",
            """{"name":"App","permissions":[{"resource":"Microsoft Graph","name":"User.ReadWrite.All"}]}""");
        var unknown = await h.Call("entraApp.create",
            """{"name":"App","permissions":[{"resource":"Microsoft Graph","name":"Nope.Read.All"}]}""");

        Assert.Equal("bad_request", ErrorCode(write));
        Assert.Equal("bad_request", ErrorCode(unknown));
        Assert.Empty(h.Graph);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Create_rejects_empty_name(string name)
    {
        var h = new Harness(Account());

        var reply = await h.Call("entraApp.create", $$"""{"name":"{{name}}","permissions":[]}""");

        Assert.Equal("bad_request", ErrorCode(reply));
    }

    [Fact]
    public async Task Create_rejects_long_name()
    {
        var h = new Harness(Account());

        var reply = await h.Call("entraApp.create", $$"""{"name":"{{new string('a', 121)}}","permissions":[]}""");

        Assert.Equal("bad_request", ErrorCode(reply));
    }

    [Fact]
    public async Task Create_runs_the_steps_and_answers_the_result()
    {
        var h = new Harness(Account())
        {
            Answer = request =>
            {
                var path = request.RequestUri!.AbsolutePath;
                return path switch
                {
                    _ when path.EndsWith("/organization", StringComparison.Ordinal) =>
                        Json(HttpStatusCode.OK, $$"""{"value":[{"id":"{{Tenant}}","displayName":"Contoso"}]}"""),
                    _ when path.StartsWith("/v1.0/servicePrincipals(appId=", StringComparison.Ordinal) =>
                        Json(HttpStatusCode.OK, $$"""{"id":"sp","oauth2PermissionScopes":[{"value":"{{Offered}}","id":"u1","type":"Admin"}]}"""),
                    _ when path.EndsWith("/applications", StringComparison.Ordinal) =>
                        Json(HttpStatusCode.Created, $$"""{"id":"obj-1","appId":"{{AppId}}"}"""),
                    _ when path.EndsWith("/me", StringComparison.Ordinal) => Json(HttpStatusCode.OK, """{"id":"me-1"}"""),
                    _ when path.EndsWith("/owners/$ref", StringComparison.Ordinal) => Json(HttpStatusCode.NoContent, ""),
                    _ when path.EndsWith("/servicePrincipals", StringComparison.Ordinal) =>
                        Json(HttpStatusCode.Created, """{"id":"sp-new"}"""),
                    _ => Json(HttpStatusCode.NotFound, "{}"),
                };
            },
        };

        var reply = await h.Call("entraApp.create",
            $$"""{"name":" My app ","permissions":[{{OfferedRef}}]}""");

        var result = reply.GetProperty("result");
        Assert.Equal(AppId, result.GetProperty("appId").GetString());
        Assert.Equal("sp-new", result.GetProperty("servicePrincipalId").GetString());
        Assert.Equal(Tenant, result.GetProperty("tenantId").GetString());
        Assert.Equal([Offered], result.GetProperty("adminScopes").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(
            [
                """{"event":"entraApp.step","data":{"step":"lookUp"}}""",
                """{"event":"entraApp.step","data":{"step":"createApp"}}""",
                """{"event":"entraApp.step","data":{"step":"addOwner"}}""",
                """{"event":"entraApp.step","data":{"step":"createServicePrincipal"}}""",
            ],
            h.Events);
    }

    [Fact]
    public async Task Create_is_bad_request_when_the_sign_in_cannot_create()
    {
        var own = new Harness(Account(clientId: "00000000-0000-0000-0000-00000000c1ie"));
        var expired = new Harness(Account(expired: true));
        var noScope = new Harness(Account(scopes: "User.Read"));

        foreach (var h in new[] { own, expired, noScope })
        {
            var reply = await h.Call("entraApp.create", $$"""{"name":"App","permissions":[{{OfferedRef}}]}""");

            Assert.Equal("bad_request", ErrorCode(reply));
            Assert.Equal(EntraAppHandler.CannotCreateReason, reply.GetProperty("error").GetProperty("message").GetString());
            Assert.Empty(h.Graph);
            Assert.Empty(h.Events);
        }
    }

    [Fact]
    public async Task Create_server_error_answers_may_have_created()
    {
        var h = new Harness(Account())
        {
            Answer = request =>
            {
                var path = request.RequestUri!.AbsolutePath;
                return path switch
                {
                    _ when path.EndsWith("/organization", StringComparison.Ordinal) =>
                        Json(HttpStatusCode.OK, $$"""{"value":[{"id":"{{Tenant}}","displayName":"Contoso"}]}"""),
                    _ when path.StartsWith("/v1.0/servicePrincipals(appId=", StringComparison.Ordinal) =>
                        Json(HttpStatusCode.OK, $$"""{"id":"sp","oauth2PermissionScopes":[{"value":"{{Offered}}","id":"u1","type":"Admin"}]}"""),
                    _ when path.EndsWith("/applications", StringComparison.Ordinal) => Json(HttpStatusCode.BadGateway, "{}"),
                    _ => Json(HttpStatusCode.NotFound, "{}"),
                };
            },
        };

        var reply = await h.Call("entraApp.create", $$"""{"name":"App","permissions":[{{OfferedRef}}]}""");

        Assert.Equal("mayHaveCreated", ErrorCode(reply));
    }

    [Fact]
    public async Task Create_failure_before_the_app_exists_is_failed_with_the_message()
    {
        var h = new Harness(Account())
        {
            Answer = request => request.RequestUri!.AbsolutePath.EndsWith("/organization", StringComparison.Ordinal)
                ? Json(HttpStatusCode.OK, $$"""{"value":[{"id":"{{Tenant}}","displayName":"C"}]}""")
                : Json(HttpStatusCode.Forbidden, """{"error":{"message":"x"}}"""),
        };

        var reply = await h.Call("entraApp.create", $$"""{"name":"App","permissions":[{{OfferedRef}}]}""");

        Assert.Equal("failed", ErrorCode(reply));
        Assert.NotEmpty(reply.GetProperty("error").GetProperty("message").GetString()!);
    }

    [Fact]
    public async Task OpenConsent_builds_url_from_active_tenant()
    {
        var h = new Harness(Account());

        var reply = await h.Call("entraApp.openConsent", $$"""{"appId":"{{AppId}}","tenantId":"evil"}""");

        Assert.Equal("{}", reply.GetProperty("result").GetRawText());
        var url = Assert.Single(h.Browser.Opened);
        Assert.Equal($"login.microsoftonline.com", url.Host);
        Assert.Contains($"/{Tenant}/v2.0/adminconsent", url.AbsolutePath, StringComparison.Ordinal);
        Assert.Contains($"client_id={AppId}", url.Query, StringComparison.Ordinal);
        Assert.Contains("&state=state-1", url.Query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ConsentLink_has_no_state()
    {
        var h = new Harness(Account());

        var reply = await h.Call("entraApp.consentLink", $$"""{"appId":"{{AppId}}"}""");

        var url = reply.GetProperty("result").GetProperty("url").GetString()!;
        Assert.StartsWith($"https://login.microsoftonline.com/{Tenant}/v2.0/adminconsent?client_id={AppId}", url, StringComparison.Ordinal);
        Assert.DoesNotContain("state", url, StringComparison.Ordinal);
        Assert.Empty(h.Browser.Opened);
    }

    [Fact]
    public async Task OpenPortal_opens_the_entra_overview()
    {
        var h = new Harness(Account());

        await h.Call("entraApp.openPortal", $$"""{"appId":"{{AppId}}"}""");

        Assert.Equal(
            $"https://entra.microsoft.com/{Tenant}/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/{AppId}",
            Assert.Single(h.Browser.Opened).AbsoluteUri);
        Assert.True(SystemBrowser.IsAllowed(h.Browser.Opened[0]));
        Assert.DoesNotContain("home-tenant", h.Browser.Opened[0].AbsoluteUri, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("entraApp.openConsent")]
    [InlineData("entraApp.consentLink")]
    [InlineData("entraApp.openPortal")]
    [InlineData("entraApp.consentStatus")]
    [InlineData("entraApp.retryServicePrincipal")]
    public async Task Non_guid_app_id_is_bad_request(string method)
    {
        var h = new Harness(Account());

        var reply = await h.Call(method, """{"appId":"x/../y","objectId":"x"}""");

        Assert.Equal("bad_request", ErrorCode(reply));
        Assert.Empty(h.Browser.Opened);
        Assert.Empty(h.Graph);
    }

    [Fact]
    public async Task ConsentStatus_keeps_only_planned_scope_names()
    {
        var h = new Harness(Account())
        {
            Answer = request =>
            {
                var uri = request.RequestUri!.ToString();
                return uri.Contains("oauth2PermissionGrants", StringComparison.Ordinal)
                    ? Json(HttpStatusCode.OK, $$"""{"value":[{"scope":"{{Offered}}"}]}""")
                    : Json(HttpStatusCode.OK, """{"id":"sp"}""");
            },
        };

        var reply = await h.Call("entraApp.consentStatus",
            $$"""{"appId":"{{AppId}}","adminScopes":["{{Offered.ToLowerInvariant()}}","Evil.ReadWrite.All","Mail.Send"]}""");

        var result = reply.GetProperty("result");
        Assert.Equal([Offered], result.GetProperty("granted").EnumerateArray().Select(e => e.GetString()));
        Assert.Empty(result.GetProperty("missing").EnumerateArray());
    }

    [Fact]
    public async Task CanGrant_answers_the_clients_verdict()
    {
        var h = new Harness(Account())
        {
            Answer = _ => Json(HttpStatusCode.OK, """{"value":[{"roleTemplateId":"62e90394-69f5-4237-9190-012177145e10"}]}"""),
        };

        var reply = await h.Call("entraApp.canGrant");

        Assert.Equal("""{"canGrant":true}""", reply.GetProperty("result").GetRawText());
    }

    [Fact]
    public async Task No_active_account_is_sign_in_needed()
    {
        var h = new Harness(null);

        Assert.Equal("signInNeeded", ErrorCode(await h.Call("entraApp.plan")));
        Assert.Equal("signInNeeded", ErrorCode(await h.Call("entraApp.canGrant")));
    }

    [Fact]
    public async Task SignIn_needed_maps_to_signInNeeded()
    {
        var h = new Harness(Account()) { Answer = _ => throw new SignInRequiredException("expired") };

        Assert.Equal("signInNeeded", ErrorCode(await h.Call("entraApp.plan")));
    }

    [Fact]
    public void SystemBrowser_refuses_other_hosts()
    {
        var launched = new List<Uri>();
        var browser = new SystemBrowser(launched.Add);

        browser.Open(new Uri("https://login.microsoftonline.com/t/v2.0/adminconsent?client_id=a"));
        browser.Open(new Uri("https://entra.microsoft.com/#view/x"));

        Assert.Equal(2, launched.Count);
        foreach (var bad in new[]
        {
            "http://login.microsoftonline.com/x", "https://evil.example/x", "https://login.microsoftonline.com.evil.example/x",
            "https://login.microsoftonline.com:8443/x", "https://user@login.microsoftonline.com/x", "file:///etc/passwd",
            "https://portal.azure.com/",
        })
        {
            Assert.Throws<ArgumentException>(() => browser.Open(new Uri(bad)));
        }

        Assert.Equal(2, launched.Count);
    }
}
