namespace Kustodian.Auth;

public enum Audience
{
    Graph,
    Arm,
}

public static class AudienceScopes
{
    public static string ScopeFor(this Audience audience) => audience switch
    {
        Audience.Graph => "https://graph.microsoft.com/.default",
        Audience.Arm => "https://management.azure.com/.default",
        _ => throw new ArgumentOutOfRangeException(nameof(audience), audience, null),
    };
}

/// <summary>The public client to sign in with: its application (client) ID and the tenant, or <c>organizations</c>.</summary>
public sealed record ClientConfig(string ClientId, string Tenant)
{
    public const string AzureCliClientId = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

    public static ClientConfig AzureCli => new(AzureCliClientId, "organizations");

    public bool IsAzureCli => string.Equals(ClientId, AzureCliClientId, StringComparison.OrdinalIgnoreCase);
}
