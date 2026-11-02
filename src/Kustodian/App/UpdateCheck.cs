using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace Kustodian.App;

/// <summary>What <c>app.checkUpdate</c> found: the running version, the latest release's version and whether it is newer.</summary>
public sealed record UpdateInfo(string Current, string Latest, bool Available);

/// <summary>Asks GitHub for Kustodian's latest release. Its page is <see cref="ReleasePage"/>, built from a version Kustodian
/// parsed, never from an address the answer carries.</summary>
public sealed class UpdateCheck(HttpClient github, string current)
{
    private static readonly Uri Latest = new("https://api.github.com/repos/FrodeHus/kustodian/releases/latest");

    /// <summary>A client for the GitHub API, which refuses requests without a User-Agent.</summary>
    public static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"Kustodian/{AppVersion.Text}");
        client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return client;
    }

    /// <summary>The latest release; throws <see cref="HttpRequestException"/> (or a timeout's
    /// <see cref="TaskCanceledException"/>) when GitHub can't be reached, and <see cref="FormatException"/> when its tag isn't a version.</summary>
    public async Task<UpdateInfo> CheckAsync(CancellationToken ct)
    {
        var release = await github.GetFromJsonAsync<Release>(Latest, ct) ?? throw new FormatException("GitHub sent no release.");
        var latest = VersionOf(release.TagName) ?? throw new FormatException("The latest release's tag isn't a version.");
        return new UpdateInfo(current, latest.ToString(), VersionOf(current) is not { } running || latest > running);
    }

    /// <summary>The release page of <paramref name="version"/>, or null when it isn't a version.</summary>
    public static Uri? ReleasePage(string? version) =>
        VersionOf(version) is { } v ? new Uri($"https://github.com/FrodeHus/kustodian/releases/tag/v{v}") : null;

    /// <summary>A tag or version such as <c>v0.93.0</c> as a <see cref="Version"/>; a pre-release suffix (<c>-beta</c>) is dropped.</summary>
    public static Version? VersionOf(string? text)
    {
        var value = text?.Trim().TrimStart('v', 'V') ?? "";
        var dash = value.IndexOf('-', StringComparison.Ordinal);
        return Version.TryParse(dash >= 0 ? value[..dash] : value, out var version) ? version : null;
    }

    private sealed record Release([property: JsonPropertyName("tag_name")] string? TagName);
}
