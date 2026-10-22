using System.Net;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Schema;
using Kustodian.Graph.Tests.Run;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Graph.Tests.Fetch;

public sealed class TenantLicensesTests
{
    private static readonly GraphLicenseRequirement P2 = new("Microsoft Entra ID P2", ["AAD_PREMIUM_P2"], "https://learn.microsoft.com/x");
    private static readonly GraphLicenseRequirement P1OrP2 =
        new("Microsoft Entra ID P1 or P2", ["AAD_PREMIUM", "AAD_PREMIUM_P2"], "https://learn.microsoft.com/x");

    private static object Sku(string capability, params (string Plan, string Status)[] plans) => new
    {
        capabilityStatus = capability,
        skuPartNumber = "SKU",
        servicePlans = plans.Select(p => new { servicePlanName = p.Plan, provisioningStatus = p.Status, appliesTo = "User" }),
    };

    private static TenantLicenses Parse(params object[] skus) =>
        TenantLicenses.FromSubscribedSkus(JsonSerializer.SerializeToElement(new { value = skus }));

    [Fact]
    public void A_plan_of_an_enabled_sku_that_provisioned_is_available()
    {
        var tenant = Parse(Sku("Enabled", ("AAD_PREMIUM", "Success"), ("EXCHANGE_S_STANDARD", "Success")));

        Assert.True(tenant.Known);
        Assert.Equal(GraphLicenseState.Available, tenant.StateOf(P1OrP2));
        Assert.Equal(GraphLicenseState.Missing, tenant.StateOf(P2));
    }

    [Fact]
    public void A_sku_in_its_grace_period_still_counts()
    {
        Assert.Equal(GraphLicenseState.Available, Parse(Sku("Warning", ("AAD_PREMIUM_P2", "Success"))).StateOf(P2));
    }

    [Theory]
    [InlineData("Suspended")]
    [InlineData("Deleted")]
    [InlineData("LockedOut")]
    [InlineData("Disabled")]
    public void A_sku_that_is_not_enabled_provides_nothing(string capability)
    {
        Assert.Equal(GraphLicenseState.Missing, Parse(Sku(capability, ("AAD_PREMIUM_P2", "Success"))).StateOf(P2));
    }

    [Theory]
    [InlineData("Disabled")]
    [InlineData("PendingActivation")]
    [InlineData("PendingProvisioning")]
    [InlineData("ErrorStatus")]
    public void A_plan_that_did_not_provision_is_missing(string status)
    {
        Assert.Equal(GraphLicenseState.Missing, Parse(Sku("Enabled", ("AAD_PREMIUM_P2", status))).StateOf(P2));
    }

    [Fact]
    public void A_plan_provisioned_in_any_enabled_sku_counts()
    {
        var tenant = Parse(Sku("Suspended", ("AAD_PREMIUM_P2", "Success")), Sku("Enabled", ("AAD_PREMIUM_P2", "Success")));

        Assert.Equal(GraphLicenseState.Available, tenant.StateOf(P2));
    }

    [Fact]
    public void Plan_names_ignore_case()
    {
        Assert.Equal(GraphLicenseState.Available, Parse(Sku("Enabled", ("aad_premium_p2", "Success"))).StateOf(P2));
    }

    [Fact]
    public void Unknown_licenses_are_unknown_for_every_requirement_and_nothing_is_needed_without_one()
    {
        var unknown = TenantLicenses.Unknown("no permission");

        Assert.False(unknown.Known);
        Assert.Equal(GraphLicenseState.Unknown, unknown.StateOf(P2));
        Assert.Equal(GraphLicenseState.Available, Parse().StateOf(null));
        Assert.Equal(GraphLicenseState.Available, unknown.StateOf(null));
    }

    private sealed class Graph : HttpMessageHandler
    {
        public int Requests { get; private set; }

        public List<string> Paths { get; } = [];

        public Func<HttpResponseMessage> Answer { get; set; } = () => Ok(new { value = Array.Empty<object>() });

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++;
            Paths.Add(request.RequestUri!.PathAndQuery);
            return Task.FromResult(Answer());
        }

        public static HttpResponseMessage Ok(object body) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), System.Text.Encoding.UTF8, "application/json"),
        };
    }

    private static (GraphTenantLicenses Licenses, Graph Graph, FakeTimeProvider Time) Reader()
    {
        var graph = new Graph();
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-10-22T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var client = new HttpClient(graph) { BaseAddress = new Uri("https://graph.microsoft.com/beta/") };
        return (new GraphTenantLicenses(client, time), graph, time);
    }

    [Fact]
    public async Task Reads_subscribed_skus_once_per_account_until_refreshed()
    {
        var (licenses, graph, _) = Reader();
        graph.Answer = () => Graph.Ok(new { value = new[] { Sku("Enabled", ("AAD_PREMIUM_P2", "Success")) } });

        var first = await licenses.GetAsync("a", false, CancellationToken.None);
        var second = await licenses.GetAsync("a", false, CancellationToken.None);
        await licenses.GetAsync("a", true, CancellationToken.None);

        Assert.Equal(GraphLicenseState.Available, first.StateOf(P2));
        Assert.Same(first, second);
        Assert.Equal(2, graph.Requests);
        Assert.StartsWith("/beta/subscribedSkus", graph.Paths[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task Forgetting_an_account_reads_again()
    {
        var (licenses, graph, _) = Reader();

        await licenses.GetAsync("a", false, CancellationToken.None);
        licenses.RemoveAccount("a");
        await licenses.GetAsync("a", false, CancellationToken.None);

        Assert.Equal(2, graph.Requests);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task A_refused_or_failed_read_is_unknown(HttpStatusCode status)
    {
        var (licenses, graph, _) = Reader();
        graph.Answer = () => FakeGraph.Error(status, "Authorization_RequestDenied", "Insufficient privileges to complete the operation.");

        var tenant = await licenses.GetAsync("a", false, CancellationToken.None);

        Assert.False(tenant.Known);
        Assert.Equal(GraphLicenseState.Unknown, tenant.StateOf(P2));
        Assert.NotNull(tenant.Reason);
    }

    [Fact]
    public async Task An_unknown_answer_is_tried_again_after_a_while()
    {
        var (licenses, graph, time) = Reader();
        graph.Answer = () => FakeGraph.Error(HttpStatusCode.Forbidden, "Authorization_RequestDenied", "Insufficient privileges.");

        await licenses.GetAsync("a", false, CancellationToken.None);
        await licenses.GetAsync("a", false, CancellationToken.None);
        time.Advance(GraphTenantLicenses.RetryAfter);
        await licenses.GetAsync("a", false, CancellationToken.None);

        Assert.Equal(2, graph.Requests);
    }

    [Fact]
    public async Task A_network_failure_is_unknown()
    {
        var (licenses, graph, _) = Reader();
        graph.Answer = () => throw new HttpRequestException("offline");

        var tenant = await licenses.GetAsync("a", false, CancellationToken.None);

        Assert.False(tenant.Known);
    }
}
