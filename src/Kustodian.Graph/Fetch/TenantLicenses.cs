using System.Text.Json;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Fetch;

/// <summary>Whether the tenant has a license a table or column needs: <see cref="Unknown"/> when its licenses couldn't be
/// read.</summary>
public enum GraphLicenseState
{
    Available,
    Missing,
    Unknown,
}

/// <summary>The service plans an account's tenant has, from <c>GET /subscribedSkus</c>: the <c>servicePlanName</c> of each plan
/// that provisioned (<c>provisioningStatus</c> <c>Success</c>) in a subscription that is enabled or in its grace period
/// (<c>capabilityStatus</c> <c>Enabled</c> or <c>Warning</c>). <see cref="Plans"/> is null when they couldn't be read, and then
/// <see cref="Reason"/> says why: nothing is then known to be missing.</summary>
public sealed record TenantLicenses(IReadOnlySet<string>? Plans, string? Reason = null)
{
    public bool Known => Plans is not null;

    /// <summary>Licenses that couldn't be read, with why.</summary>
    public static TenantLicenses Unknown(string reason) => new(null, reason);

    /// <summary>Whether the tenant has <paramref name="requirement"/> (any one of its plans); a table or column that needs none is
    /// <see cref="GraphLicenseState.Available"/>.</summary>
    public GraphLicenseState StateOf(GraphLicenseRequirement? requirement) => requirement is null
        ? GraphLicenseState.Available
        : Plans is null
            ? GraphLicenseState.Unknown
            : requirement.Plans.Any(Plans.Contains) ? GraphLicenseState.Available : GraphLicenseState.Missing;

    /// <summary>The plans of <c>subscribedSkus</c>' answer (<c>{"value": [subscribedSku]}</c>).</summary>
    public static TenantLicenses FromSubscribedSkus(JsonElement root)
    {
        var plans = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("value", out var skus) && skus.ValueKind == JsonValueKind.Array)
        {
            foreach (var sku in skus.EnumerateArray())
            {
                if (Text(sku, "capabilityStatus") is not ("Enabled" or "Warning")
                    || !sku.TryGetProperty("servicePlans", out var servicePlans) || servicePlans.ValueKind != JsonValueKind.Array)
                    continue;
                foreach (var plan in servicePlans.EnumerateArray())
                {
                    if (Text(plan, "provisioningStatus") == "Success" && Text(plan, "servicePlanName") is { Length: > 0 } name)
                        plans.Add(name);
                }
            }
        }

        return new TenantLicenses(plans);
    }

    private static string? Text(JsonElement e, string property) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
