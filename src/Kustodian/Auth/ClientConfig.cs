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

/// <summary>Which sign-in client an account uses: one of the built-in ones, or the user's own app registration.</summary>
public enum ClientKind
{
    AzureCli,
    GraphCli,
    Own,
}

/// <summary>The public client to sign in with: its application (client) ID and the tenant, or <c>organizations</c>.</summary>
public sealed record ClientConfig(string ClientId, string Tenant)
{
    public const string AzureCliClientId = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

    public const string GraphCliClientId = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

    public static ClientConfig AzureCli => new(AzureCliClientId, "organizations");

    public static ClientConfig GraphCli => new(GraphCliClientId, "organizations");

    /// <summary>Names the client behind <paramref name="clientId"/>, ignoring case.</summary>
    public static ClientKind KindOf(string clientId) =>
        string.Equals(clientId, AzureCliClientId, StringComparison.OrdinalIgnoreCase) ? ClientKind.AzureCli
        : string.Equals(clientId, GraphCliClientId, StringComparison.OrdinalIgnoreCase) ? ClientKind.GraphCli
        : ClientKind.Own;

    public ClientKind Kind => KindOf(ClientId);

    public bool IsAzureCli => Kind == ClientKind.AzureCli;

    public bool IsGraphCli => Kind == ClientKind.GraphCli;
}
