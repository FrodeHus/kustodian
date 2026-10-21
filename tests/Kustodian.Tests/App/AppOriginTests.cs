using Kustodian.App;

namespace Kustodian.Tests.App;

public sealed class AppOriginTests
{
    [Fact]
    public void Windows_serves_on_https_from_a_host_that_never_resolves()
    {
        var origin = AppOrigin.For(windows: true, "dark");

        Assert.Equal("https", origin.Scheme);
        Assert.Equal(new Uri("https://kustodian.invalid/index.html?theme=dark"), origin.StartUrl);
    }

    [Fact]
    public void Other_platforms_serve_on_the_app_scheme()
    {
        var origin = AppOrigin.For(windows: false, "dark");

        Assert.Equal("app", origin.Scheme);
        Assert.Equal(new Uri("app://localhost/index.html?theme=dark"), origin.StartUrl);
    }

    [Theory]
    [InlineData(true, "dark", "https://kustodian.invalid/index.html?theme=dark")]
    [InlineData(true, "light", "https://kustodian.invalid/index.html?theme=light")]
    [InlineData(false, "system", "app://localhost/index.html?theme=system")]
    [InlineData(false, "light", "app://localhost/index.html?theme=light")]
    [InlineData(false, "<script>", "app://localhost/index.html?theme=dark")]
    public void Start_url_carries_theme(bool windows, string theme, string expected)
    {
        Assert.Equal(new Uri(expected), AppOrigin.For(windows, theme).StartUrl);
    }

    [Theory]
    [InlineData(true, "https://kustodian.invalid/index.html", true)]
    [InlineData(true, "HTTPS://Kustodian.Invalid/assets/index.js", true)]
    [InlineData(true, "https://learn.microsoft.com/graph/api/resources/user", false)]
    [InlineData(true, "https://kustodian.invalid:8443/index.html", false)]
    [InlineData(true, "http://kustodian.invalid/index.html", false)]
    [InlineData(true, "https://kustodian.invalid.evil.com/", false)]
    [InlineData(true, "https://kustodian.invalid@evil.com/", false)]
    [InlineData(false, "app://localhost/", true)]
    [InlineData(false, "app://other/index.html", false)]
    [InlineData(false, "not a url", false)]
    public void Serves_only_its_own_scheme_and_host(bool windows, string url, bool expected)
    {
        Assert.Equal(expected, AppOrigin.For(windows, "dark").Serves(url));
    }

    [Fact]
    public void Embedded_assets_leave_requests_for_other_hosts_to_the_web_view()
    {
        var assets = new EmbeddedAssets(typeof(EmbeddedAssets).Assembly, AppOrigin.For(windows: true, "dark"));

        using var own = assets.Open("https://kustodian.invalid/", out var ownType);
        using var other = assets.Open("https://learn.microsoft.com/graph/api/resources/user", out _);

        Assert.NotNull(own);
        Assert.StartsWith("text/html", ownType, StringComparison.Ordinal);
        Assert.Null(other);
    }
}
