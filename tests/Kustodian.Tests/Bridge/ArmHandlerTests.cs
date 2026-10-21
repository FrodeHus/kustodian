using System.Net;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Run;
using Kustodian.Messaging;
using Kustodian.Messaging.Handlers;
using Kustodian.Sources.Arg;
using Microsoft.Extensions.Time.Testing;
using static Kustodian.Tests.Bridge.SchemaHandlerTests;

namespace Kustodian.Tests.Bridge;

public class ArmHandlerTests
{
    private const string Subscriptions = """
        {"value":[{"id":"/subscriptions/00000000-0000-0000-0000-000000000001","subscriptionId":"00000000-0000-0000-0000-000000000001",
          "tenantId":"00000000-0000-0000-0000-0000000000aa","displayName":"Production","state":"Enabled"}]}
        """;

    private static Messaging.Bridge Bridge(Stub arm, string? account = "account-1")
    {
        var bridge = new Messaging.Bridge(_ => { });
        new ArmHandler(new ArmDirectory(new HttpClient(arm), new FakeTimeProvider()), () => Task.FromResult(account)).Register(bridge);
        return bridge;
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static async Task<JsonElement> Call(Messaging.Bridge bridge, string method)
    {
        var reply = await bridge.HandleAsync("{\"id\":\"a\",\"method\":\"" + method + "\",\"params\":{}}");
        Assert.NotNull(reply);
        using var doc = JsonDocument.Parse(reply);
        return doc.RootElement.Clone();
    }

    [Fact]
    public async Task Arm_subscriptions_answers_the_active_accounts_subscriptions()
    {
        var arm = new Stub(_ => Json(HttpStatusCode.OK, Subscriptions));

        var reply = await Call(Bridge(arm), "arm.subscriptions");

        Assert.Equal(["account-1"], arm.Requests);
        Assert.Equal("""{"subscriptions":[{"id":"00000000-0000-0000-0000-000000000001","name":"Production","tenantId":"00000000-0000-0000-0000-0000000000aa","state":"Enabled"}]}""",
            reply.GetProperty("result").GetRawText());
    }

    [Fact]
    public async Task Arm_management_groups_answers_groups_and_a_note_when_refused()
    {
        var listed = new Stub(_ => Json(HttpStatusCode.OK,
            """{"value":[{"name":"contoso-platform","properties":{"displayName":"Platform"}}]}"""));
        var refused = new Stub(_ => Json(HttpStatusCode.Forbidden, """{"error":{"code":"AuthorizationFailed","message":"No."}}"""));

        var groups = await Call(Bridge(listed), "arm.managementGroups");
        var none = await Call(Bridge(refused), "arm.managementGroups");

        Assert.Equal("""{"groups":[{"name":"contoso-platform","displayName":"Platform"}]}""", groups.GetProperty("result").GetRawText());
        Assert.Equal(["groups", "note"], none.GetProperty("result").EnumerateObject().Select(p => p.Name));
        Assert.Equal(0, none.GetProperty("result").GetProperty("groups").GetArrayLength());
        Assert.Equal("You can't list management groups.", none.GetProperty("result").GetProperty("note").GetString());
    }

    [Fact]
    public async Task Arm_resource_types_answers_the_types()
    {
        var arm = new Stub(_ => Json(HttpStatusCode.OK, """{"totalRecords":1,"data":[{"type":"microsoft.keyvault/vaults"}]}"""));

        var reply = await Call(Bridge(arm), "arm.resourceTypes");

        Assert.Equal("""{"types":["microsoft.keyvault/vaults"]}""", reply.GetProperty("result").GetRawText());
    }

    [Theory]
    [InlineData("arm.subscriptions")]
    [InlineData("arm.managementGroups")]
    [InlineData("arm.resourceTypes")]
    public async Task Arm_consent_needed_is_its_own_error_code(string method)
    {
        var arm = new Stub(_ => throw new ConsentRequiredException("arm"));

        var reply = await Call(Bridge(arm), method);

        Assert.Equal("consentNeeded", BridgeErrorCodes.ConsentNeeded);
        Assert.Equal("consentNeeded", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(ConsentRequiredException.ArmMessage, reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Theory]
    [InlineData("arm.subscriptions")]
    [InlineData("arm.resourceTypes")]
    public async Task Arm_sign_in_needed_and_no_account_are_sign_in_needed(string method)
    {
        var signIn = new Stub(_ => throw new SignInRequiredException("The Azure request names no account."));
        var never = new Stub(_ => throw new InvalidOperationException("No request is expected."));

        var expired = await Call(Bridge(signIn), method);
        var nobody = await Call(Bridge(never, account: null), method);

        Assert.Equal("signInNeeded", expired.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("signInNeeded", nobody.GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(never.Requests);
    }

    [Fact]
    public async Task Arm_failure_is_failed_with_azures_message()
    {
        var arm = new Stub(_ => Json(HttpStatusCode.InternalServerError, """{"error":{"code":"InternalServerError","message":"Something went wrong."}}"""));

        var reply = await Call(Bridge(arm), "arm.subscriptions");

        Assert.Equal("failed", reply.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("Something went wrong.", reply.GetProperty("error").GetProperty("message").GetString());
    }
}
