namespace Kustodian.Auth.EntraApp;

/// <summary>A permission a non-table source needs: the resource it is on, its scope name, whether it needs admin consent, what
/// it unlocks, and where the dialog files it (<paramref name="GroupId"/> and <paramref name="SubgroupTitle"/>).</summary>
public sealed record SourcePermission(
    string ResourceAppId,
    string ResourceName,
    string Scope,
    bool AdminConsent,
    string Unlocks,
    string GroupId,
    string SubgroupTitle);

/// <summary>The permissions the two sources that are not Graph tables need, added to the plan as they are.</summary>
public static class SourcePermissions
{
    /// <summary>Microsoft Graph's application ID.</summary>
    public const string GraphAppId = "00000003-0000-0000-c000-000000000000";

    /// <summary>Azure Service Management's application ID.</summary>
    public const string ArmAppId = "797f4846-ba00-4fd7-ba43-dac1f8f63013";

    /// <summary>Advanced hunting needs Graph <c>ThreatHunting.Read.All</c>, which requires admin consent.</summary>
    public static SourcePermission Hunting { get; } = new(
        GraphAppId, "Microsoft Graph", "ThreatHunting.Read.All", true, "Defender advanced hunting tabs", "security", "Advanced hunting");

    /// <summary>Azure Resource Graph needs Azure Service Management <c>user_impersonation</c>, which does not.</summary>
    public static SourcePermission ResourceGraph { get; } = new(
        ArmAppId, "Azure Service Management", "user_impersonation", false,
        "Azure Resource Graph tabs, subscriptions and management groups", "azure", "Resource Graph");
}
