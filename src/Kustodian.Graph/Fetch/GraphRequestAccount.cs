namespace Kustodian.Graph.Fetch;

/// <summary>The account a Graph request is for, carried on <see cref="HttpRequestMessage.Options"/>. The readers set it on every
/// request from the run's account key, so a run keeps the account it started with even if another becomes active mid-run; the
/// token handler reads it and never falls back to whichever account is active.</summary>
public static class GraphRequestAccount
{
    public static readonly HttpRequestOptionsKey<string> Key = new("Kustodian.AccountKey");

    /// <summary>Marks <paramref name="request"/> as made for <paramref name="accountKey"/>, and returns it.</summary>
    public static HttpRequestMessage ForAccount(this HttpRequestMessage request, string accountKey)
    {
        request.Options.Set(Key, accountKey);
        return request;
    }

    /// <summary>The account <paramref name="request"/> was made for, or null when it carries none.</summary>
    public static string? AccountOf(HttpRequestMessage request)
        => request.Options.TryGetValue(Key, out var key) && !string.IsNullOrEmpty(key) ? key : null;
}
