using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Kustodian.Graph.Fetch;

/// <summary>Turns what Graph answered with into a message fit to show: its <c>error.message</c>, or a short line for a web page
/// a backend behind Graph passed through (an IIS 404 when a selected property can't be read in a list).</summary>
public static partial class GraphErrorText
{
    private const int MaxLength = 200;

    /// <summary>What a sign-in failure says.</summary>
    public const string SignInMessage = "Graph rejected the sign-in. Sign in again to continue.";

    [GeneratedRegex("<title[^>]*>(?<text>.*?)(?:</title>|$)", RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex Title();

    [GeneratedRegex("<h[1-6][^>]*>(?<text>.*?)(?:</h[1-6]>|$)", RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex Heading();

    [GeneratedRegex("<[^>]*>", RegexOptions.CultureInvariant)]
    private static partial Regex Tags();

    /// <summary>What answered, as <see cref="Summarize"/> names it: Graph, or Azure (Resource Manager, Resource Graph).</summary>
    public const string Graph = "Graph";

    /// <inheritdoc cref="Graph"/>
    public const string Azure = "Azure";

    /// <summary>A message for a failed answer from <paramref name="service"/>. A web page gives <c>"{status} from {service}'s
    /// backend: {title or first heading}"</c>, cut to 200 characters; JSON gives its <c>error.message</c>; anything else gives
    /// <c>"{status} from {service}"</c>.</summary>
    public static string Summarize(int status, string? body, string service = Graph)
    {
        var raw = Extract(body);
        return raw is null ? $"{status.ToString(CultureInfo.InvariantCulture)} from {service}" : Describe(status, raw, service);
    }

    /// <summary>The message for a raw one (see <see cref="Extract(string?)"/>): itself, or the short line for a web page.</summary>
    internal static string Describe(int status, string raw, string service = Graph)
    {
        if (!IsHtml(raw))
            return raw;
        var code = status.ToString(CultureInfo.InvariantCulture);
        var text = Plain(Title().Match(raw)) ?? Plain(Heading().Match(raw));
        var summary = $"{code} from {service}'s backend" + (text is null ? "" : ": " + text);
        return summary.Length <= MaxLength ? summary : summary[..MaxLength];
    }

    /// <summary>Whether <paramref name="text"/> is a web page, not a message.</summary>
    public static bool IsHtml(string? text) => text is not null && text.TrimStart().StartsWith('<');

    /// <summary>The message in a response body: the <c>error.message</c> of JSON, else the body itself when it is a web page
    /// (a web page inside the JSON message is returned as it is), else null.</summary>
    internal static string? Extract(byte[] body) => Extract(Encoding.UTF8.GetString(body));

    /// <inheritdoc cref="Extract(byte[])"/>
    internal static string? Extract(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
            return null;
        if (IsHtml(body))
            return body;
        try
        {
            return JsonNode.Parse(body)?["error"]?["message"]?.GetValue<string>();
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>Whether Graph's message for a 400 is about <c>$top</c>: it names <c>$top</c> or OData's query option <c>'Top'</c>,
    /// or it refuses a custom page size (<c>directoryRoles</c> and its <c>members</c>).</summary>
    internal static bool NamesTop(string? message) => message is not null
        && (message.Contains("$top", StringComparison.OrdinalIgnoreCase) || message.Contains("'Top'", StringComparison.OrdinalIgnoreCase)
            || message.Contains("page size", StringComparison.OrdinalIgnoreCase));

    /// <summary>Whether Graph's message for a 400 refuses <c>$select</c> itself, not a property in it: "Query option 'Select' is
    /// not allowed" (<c>reports/appCredentialSignInActivities</c> and other report collections).</summary>
    internal static bool RefusesSelect(string? message) => message is not null
        && message.Contains("'Select'", StringComparison.OrdinalIgnoreCase) && message.Contains("not allowed", StringComparison.OrdinalIgnoreCase);

    /// <summary>Whether the answer is a 401 that rejects the token itself (expired, revoked), not a missing permission:
    /// <c>WWW-Authenticate</c> says <c>error="invalid_token"</c>, or Graph's error code is <c>InvalidAuthenticationToken</c>, or
    /// there is no Graph error body. A 401 with another code (<c>Authorization_RequestDenied</c>) is a permission refusal.</summary>
    public static bool IsTokenRejected(HttpResponseMessage response, byte[] body)
    {
        if (response.StatusCode != HttpStatusCode.Unauthorized)
            return false;
        if (response.Headers.TryGetValues("WWW-Authenticate", out var values)
            && values.Any(v => v.Contains("error=\"invalid_token\"", StringComparison.OrdinalIgnoreCase)))
            return true;
        var code = ErrorCode(body);
        return code is null || string.Equals(code, "InvalidAuthenticationToken", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Whether Graph refused for a license or feature the tenant lacks, which a property in the <c>$select</c> brings in:
    /// "Tenant does not have a SPO license", or <c>Authentication_RequestFromNonPremiumTenantOrB2CTenant</c> ("... doesn't have
    /// premium license").</summary>
    internal static bool IsLicenseRefusal(byte[] body)
        => string.Equals(ErrorCode(body), "Authentication_RequestFromNonPremiumTenantOrB2CTenant", StringComparison.OrdinalIgnoreCase)
           || Extract(body) is { } message && !IsHtml(message) && message.Contains("license", StringComparison.OrdinalIgnoreCase);

    private static string? ErrorCode(byte[] body)
    {
        try
        {
            return JsonNode.Parse(body)?["error"]?["code"]?.GetValue<string>();
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    private static string? Plain(Match match)
    {
        if (!match.Success)
            return null;
        var text = WebUtility.HtmlDecode(Tags().Replace(match.Groups["text"].Value, "")).Trim();
        return text.Length == 0 ? null : text;
    }
}
