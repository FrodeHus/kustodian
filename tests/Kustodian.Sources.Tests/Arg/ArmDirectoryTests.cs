using System.Net;
using System.Text.Json.Nodes;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;
using Kustodian.Sources.Tests.Hunting;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Sources.Tests.Arg;

public class ArmDirectoryTests
{
    private const string Account = "account-1";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero));

    private ArmDirectory Directory(StubGraph arm) => new(arm.Client(), _time);

    private static StubGraph Subscriptions(string nextLink) => new(request =>
        StubGraph.Json(HttpStatusCode.OK, request.RequestUri!.AbsoluteUri.Contains("skiptoken", StringComparison.Ordinal)
            ? StubGraph.Fixture("arm-subscriptions-2.json")
            : StubGraph.Fixture("arm-subscriptions-1.json").Replace("{nextLink}", nextLink, StringComparison.Ordinal)));

    [Fact]
    public async Task Subscriptions_page_only_within_arm()
    {
        var within = Subscriptions("https://management.azure.com/subscriptions?api-version=2022-12-01&%24skiptoken=page2");
        var elsewhere = Subscriptions("https://attacker.example/subscriptions?api-version=2022-12-01&%24skiptoken=page2");
        var plainHttp = Subscriptions("http://management.azure.com/subscriptions?api-version=2022-12-01&%24skiptoken=page2");

        var all = await Directory(within).SubscriptionsAsync(Account, Ct);
        var firstOnly = await Directory(elsewhere).SubscriptionsAsync(Account, Ct);
        var notHttps = await Directory(plainHttp).SubscriptionsAsync(Account, Ct);

        Assert.Equal("https://management.azure.com/subscriptions?api-version=2022-12-01", within.Seen[0].Uri!.AbsoluteUri);
        Assert.Equal(2, within.Seen.Count);
        Assert.Equal(
            [
                new ArmSubscription("00000000-0000-0000-0000-000000000001", "Production", "00000000-0000-0000-0000-0000000000aa", "Enabled"),
                new ArmSubscription("00000000-0000-0000-0000-000000000002", "Development", "00000000-0000-0000-0000-0000000000aa", "Disabled"),
            ],
            all);
        Assert.Single(elsewhere.Seen);
        Assert.Equal(["Production"], firstOnly.Select(s => s.Name));
        Assert.Single(plainHttp.Seen);
        Assert.Equal(["Production"], notHttps.Select(s => s.Name));
        Assert.All(within.Seen, s => Assert.Equal(Account, s.Options.TryGetValue(GraphRequestAccount.Key, out var a) ? a : null));
    }

    [Fact]
    public async Task Subscriptions_are_cached_for_10_minutes_per_account()
    {
        var arm = Subscriptions("https://management.azure.com/subscriptions?api-version=2022-12-01&%24skiptoken=page2");
        var directory = Directory(arm);

        await directory.SubscriptionsAsync(Account, Ct);
        await directory.SubscriptionsAsync(Account, Ct);
        _time.Advance(TimeSpan.FromMinutes(9));
        await directory.SubscriptionsAsync(Account, Ct);
        Assert.Equal(2, arm.Seen.Count);

        await directory.SubscriptionsAsync("account-2", Ct);
        Assert.Equal(4, arm.Seen.Count);

        _time.Advance(TimeSpan.FromMinutes(2));
        await directory.SubscriptionsAsync(Account, Ct);
        Assert.Equal(6, arm.Seen.Count);
    }

    [Fact]
    public async Task Subscriptions_refused_is_an_error_and_not_cached()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.InternalServerError,
            """{"error":{"code":"InternalServerError","message":"Something went wrong."}}"""));
        var directory = Directory(arm);

        var ex = await Assert.ThrowsAsync<ArmDirectoryException>(() => directory.SubscriptionsAsync(Account, Ct));
        await Assert.ThrowsAsync<ArmDirectoryException>(() => directory.SubscriptionsAsync(Account, Ct));

        Assert.Equal("Something went wrong.", ex.Message);
        Assert.Equal(2, arm.Seen.Count);
    }

    [Fact]
    public async Task A_web_page_error_is_azures_backend()
    {
        var arm = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.BadGateway)
        {
            Content = new StringContent("<html><head><title>502 Bad Gateway</title></head></html>"),
        });
        var empty = new StubGraph(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));

        var html = await Assert.ThrowsAsync<ArmDirectoryException>(() => Directory(arm).SubscriptionsAsync(Account, Ct));
        var bare = await Assert.ThrowsAsync<ArmDirectoryException>(() => Directory(empty).SubscriptionsAsync(Account, Ct));

        Assert.Equal("502 from Azure's backend: 502 Bad Gateway", html.Message);
        Assert.Equal("503 from Azure", bare.Message);
    }

    [Fact]
    public async Task Removing_an_account_drops_its_cached_lists_only()
    {
        var arm = new StubGraph(request => StubGraph.Json(HttpStatusCode.OK, request.Method == HttpMethod.Post
            ? """{"totalRecords":1,"data":[{"type":"microsoft.compute/disks"}]}"""
            : StubGraph.Fixture("arm-subscriptions-2.json")));
        var directory = Directory(arm);
        await directory.SubscriptionsAsync(Account, Ct);
        await directory.ResourceTypesAsync(Account, Ct);
        await directory.SubscriptionsAsync("account-2", Ct);
        Assert.Equal(3, arm.Seen.Count);

        directory.RemoveAccount(Account);
        await directory.SubscriptionsAsync(Account, Ct);
        await directory.ResourceTypesAsync(Account, Ct);
        await directory.SubscriptionsAsync("account-2", Ct);

        Assert.Equal(5, arm.Seen.Count);
    }

    [Fact]
    public async Task Management_groups_are_listed_with_their_display_names()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK, StubGraph.Fixture("arm-managementgroups-200.json")));

        var groups = await Directory(arm).ManagementGroupsAsync(Account, Ct);

        Assert.Equal("https://management.azure.com/providers/Microsoft.Management/managementGroups?api-version=2023-04-01",
            Assert.Single(arm.Seen).Uri!.AbsoluteUri);
        Assert.Equal([new ArmManagementGroup("contoso-platform", "Platform")], groups.Groups);
        Assert.Null(groups.Note);
    }

    [Fact]
    public async Task Management_groups_403_is_empty_with_note()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.Forbidden, StubGraph.Fixture("arm-managementgroups-403.json")));

        var groups = await Directory(arm).ManagementGroupsAsync(Account, Ct);

        Assert.Empty(groups.Groups);
        Assert.Equal("You can't list management groups.", groups.Note);
    }

    [Fact]
    public async Task Resource_types_cached_24h()
    {
        var arm = new StubGraph(_ => StubGraph.Json(HttpStatusCode.OK,
            """{"totalRecords":2,"count":2,"data":[{"type":"microsoft.compute/disks"},{"type":"microsoft.keyvault/vaults"}]}"""));
        var directory = Directory(arm);

        var types = await directory.ResourceTypesAsync(Account, Ct);
        await directory.ResourceTypesAsync(Account, Ct);
        _time.Advance(TimeSpan.FromHours(23));
        await directory.ResourceTypesAsync(Account, Ct);

        Assert.Equal(["microsoft.compute/disks", "microsoft.keyvault/vaults"], types);
        var seen = Assert.Single(arm.Seen);
        Assert.Equal("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01", seen.Uri!.AbsoluteUri);
        var body = JsonNode.Parse(seen.Body!)!.AsObject();
        Assert.Equal("Resources | distinct type | order by type asc", body["query"]!.GetValue<string>());
        // Scope "all": neither subscriptions nor management groups.
        Assert.Equal(["query", "options"], body.Select(p => p.Key));

        await directory.ResourceTypesAsync("account-2", Ct);
        Assert.Equal(2, arm.Seen.Count);
        _time.Advance(TimeSpan.FromHours(2));
        await directory.ResourceTypesAsync(Account, Ct);
        Assert.Equal(3, arm.Seen.Count);
    }

    [Fact]
    public async Task Directory_lets_consent_and_sign_in_through()
    {
        var consent = new StubGraph(_ => throw new ConsentRequiredException("arm"));
        var signIn = new StubGraph(_ => throw new SignInRequiredException("The Azure request names no account."));

        await Assert.ThrowsAsync<ConsentRequiredException>(() => Directory(consent).SubscriptionsAsync(Account, Ct));
        await Assert.ThrowsAsync<ConsentRequiredException>(() => Directory(consent).ManagementGroupsAsync(Account, Ct));
        await Assert.ThrowsAsync<ConsentRequiredException>(() => Directory(consent).ResourceTypesAsync(Account, Ct));
        await Assert.ThrowsAsync<SignInRequiredException>(() => Directory(signIn).SubscriptionsAsync(Account, Ct));
        await Assert.ThrowsAsync<SignInRequiredException>(() => Directory(signIn).ResourceTypesAsync(Account, Ct));
    }
}
