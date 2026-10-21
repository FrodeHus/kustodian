using Kustodian.Graph.Fetch;

namespace Kustodian.Graph.Tests;

public sealed class GraphErrorTextTests
{
    [Fact]
    public void Summarize_html_body_returns_status_and_title()
    {
        var text = GraphErrorText.Summarize(404, "<html><head><title>404 - File or directory not found.</title>");

        Assert.Equal("404 from Graph's backend: 404 - File or directory not found.", text);
    }

    [Fact]
    public void Summarize_html_without_a_title_uses_the_first_heading()
    {
        var text = GraphErrorText.Summarize(502, "<html><body><h2>Bad &amp; gateway</h2><p>x</p></body></html>");

        Assert.Equal("502 from Graph's backend: Bad & gateway", text);
    }

    [Fact]
    public void Summarize_html_is_cut_to_200_characters()
    {
        var text = GraphErrorText.Summarize(500, "<title>" + new string('x', 500) + "</title>");

        Assert.Equal(200, text.Length);
        Assert.StartsWith("500 from Graph's backend: xxx", text);
    }

    [Fact]
    public void Summarize_json_returns_error_message()
    {
        var text = GraphErrorText.Summarize(403, "{\"error\":{\"code\":\"Authorization_RequestDenied\",\"message\":\"Insufficient privileges.\"}}");

        Assert.Equal("Insufficient privileges.", text);
    }

    [Fact]
    public void Summarize_html_inside_a_json_message_is_summarized_too()
    {
        var text = GraphErrorText.Summarize(404, "{\"error\":{\"message\":\"<html><title>404 - Gone</title></html>\"}}");

        Assert.Equal("404 from Graph's backend: 404 - Gone", text);
    }

    [Fact]
    public void Summarize_without_a_message_returns_the_status()
    {
        Assert.Equal("503 from Graph", GraphErrorText.Summarize(503, "oops"));
        Assert.Equal("503 from Graph", GraphErrorText.Summarize(503, null));
    }
}
