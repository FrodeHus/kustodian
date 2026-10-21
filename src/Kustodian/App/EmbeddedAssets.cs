using System.Reflection;

namespace Kustodian.App;

/// <summary>The web UI, embedded in the app at build time under <c>wwwroot/</c> and served on the <c>app://</c> scheme. Only
/// embedded files are served; nothing is read from disk.</summary>
public sealed class EmbeddedAssets
{
    public const string Scheme = "app";
    public static readonly Uri StartUrl = new("app://localhost/index.html");

    private const string Prefix = "wwwroot/";
    private const string Index = "index.html";

    private readonly Assembly _assembly;
    private readonly Dictionary<string, string> _resources;

    public EmbeddedAssets(Assembly assembly)
    {
        _assembly = assembly;
        // Resources are named after their path below web/dist, with backslashes when built on Windows.
        _resources = assembly.GetManifestResourceNames()
            .Select(name => (Name: name, Path: name.Replace('\\', '/')))
            .Where(r => r.Path.StartsWith(Prefix, StringComparison.Ordinal))
            .ToDictionary(r => r.Path[Prefix.Length..], r => r.Name, StringComparer.Ordinal);
    }

    /// <summary>The file for <paramref name="url"/>, or null when there is none. A path without an extension is a route of the
    /// single-page app and gets <c>index.html</c>.</summary>
    public Stream? Open(string url, out string contentType)
    {
        var path = PathOf(url);
        if (path.Length == 0 || !Path.HasExtension(path))
        {
            path = Index;
        }

        contentType = ContentTypeFor(path);
        return _resources.TryGetValue(path, out var name) ? _assembly.GetManifestResourceStream(name) : null;
    }

    public static string ContentTypeFor(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" or ".mjs" => "text/javascript",
        ".css" => "text/css",
        ".json" or ".map" => "application/json",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        ".woff" => "font/woff",
        ".ttf" => "font/ttf",
        ".wasm" => "application/wasm",
        ".txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };

    private static string PathOf(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/') : "";
}
