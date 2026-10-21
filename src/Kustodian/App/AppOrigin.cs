namespace Kustodian.App;

/// <summary>The origin the embedded UI is served from: the scheme Photino hands to the asset handler and the URL the window
/// opens. It differs per platform because Photino's native layers handle custom schemes differently.</summary>
/// <remarks>
/// <para>macOS (WKWebView <c>setURLSchemeHandler</c>) and Linux (WebKitGTK <c>webkit_web_context_register_uri_scheme</c>)
/// register each custom scheme with the engine, so <c>app://localhost/</c> works. WebKit refuses a handler for
/// <c>http</c>/<c>https</c>, so those platforms must use a scheme of their own.</para>
/// <para>Windows: Photino.Native 4.0.22 never registers custom schemes with WebView2 (no
/// <c>CoreWebView2CustomSchemeRegistration</c>); it only adds a <c>WebResourceRequested</c> filter for <c>*</c> and calls the
/// handler when the request's scheme matches a registered name. WebView2 treats an unregistered scheme such as <c>app:</c> as
/// an external protocol, so the navigation never happens and the page stays <c>about:blank</c>. Requests on <c>https</c> do
/// raise <c>WebResourceRequested</c>, so on Windows the handler is registered for <c>https</c> and the UI is served from a
/// host under the reserved <c>.invalid</c> TLD: it never resolves, so nothing is ever fetched from a network or a local
/// port, and <c>https</c> keeps the page a secure context.</para>
/// </remarks>
public sealed record AppOrigin(string Scheme, Uri StartUrl)
{
    public static readonly AppOrigin Custom = new("app", new Uri("app://localhost/index.html"));
    public static readonly AppOrigin Windows = new("https", new Uri("https://kustodian.invalid/index.html"));

    /// <summary>The origin for the platform this process runs on.</summary>
    public static AppOrigin Current => For(OperatingSystem.IsWindows());

    public static AppOrigin For(bool windows) => windows ? Windows : Custom;

    /// <summary>Whether <paramref name="url"/> belongs to this origin. On Windows the handler sees every <c>https</c>
    /// request, so anything for another host must be left to the web view.</summary>
    public bool Serves(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && string.Equals(uri.Scheme, StartUrl.Scheme, StringComparison.OrdinalIgnoreCase)
        && string.Equals(uri.Authority, StartUrl.Authority, StringComparison.OrdinalIgnoreCase);
}
