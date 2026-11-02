using System.Net;
using Kustodian.App;

namespace Kustodian.Tests.App;

public sealed class UpdateCheckTests
{
    [Theory]
    [InlineData("0.92.0", true)]
    [InlineData("0.93.0", false)]
    [InlineData("0.94.0", false)]
    [InlineData("0.0.0-dev", true)]
    public async Task A_newer_release_is_an_update(string current, bool available)
    {
        using var http = new HttpClient(new Answering("""{"tag_name":"v0.93.0","html_url":"https://elsewhere.example"}"""));

        var info = await new UpdateCheck(http, current).CheckAsync(CancellationToken.None);

        Assert.Equal(new UpdateInfo(current, "0.93.0", available), info);
    }

    [Fact]
    public async Task A_tag_that_is_not_a_version_is_a_format_error()
    {
        using var http = new HttpClient(new Answering("""{"tag_name":"nightly"}"""));

        await Assert.ThrowsAsync<FormatException>(() => new UpdateCheck(http, "0.92.0").CheckAsync(CancellationToken.None));
    }

    [Theory]
    [InlineData("v0.93.0", "0.93.0")]
    [InlineData("1.2.3-beta", "1.2.3")]
    [InlineData("https://evil.example", null)]
    [InlineData(null, null)]
    public void Versions_are_read_from_tags(string? text, string? expected) =>
        Assert.Equal(expected, UpdateCheck.VersionOf(text)?.ToString());

    private sealed class Answering(string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
    }
}
