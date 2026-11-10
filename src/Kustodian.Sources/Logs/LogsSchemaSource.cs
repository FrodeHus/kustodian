using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using Kustodian.Sources.Hunting;
using static Kustodian.Sources.JsonText;

namespace Kustodian.Sources.Logs;

/// <summary>
/// A Log Analytics workspace's tables and functions, from <c>GET /v1/workspaces/{customerId}/metadata</c> over the Logs HTTP
/// client, kept per account and workspace for 24 hours and shaped as <see cref="HuntingSchemaView"/>. Modelled on
/// <see cref="HuntingSchemaSource"/>, but there is no bundled schema: when the read fails the one read before stays, with why it
/// couldn't be renewed, else the view has no tables and says why; either way the read isn't tried again for 10 minutes. The
/// caller cancelling is not a failed read, and a missing consent propagates.
/// </summary>
public sealed class LogsSchemaSource(HttpClient logs, TimeProvider time)
{
    public static readonly TimeSpan CacheFor = TimeSpan.FromHours(24);
    public static readonly TimeSpan RetryAfter = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(30);

    /// <summary>A workspace has some hundred tables; a body over this is not read on.</summary>
    public const long MaxResponseBytes = 20L * 1024 * 1024;

    private readonly ConcurrentDictionary<string, (HuntingSchemaView View, DateTimeOffset Until)> _cache = new(StringComparer.Ordinal);

    private static string Key(string accountKey, string customerId) => $"{accountKey}|{customerId.ToLowerInvariant()}";

    /// <summary>Forgets every workspace schema read for <paramref name="accountKey"/> (it signed out).</summary>
    public void RemoveAccount(string accountKey)
    {
        foreach (var key in _cache.Keys.Where(k => k.StartsWith(accountKey + "|", StringComparison.Ordinal)))
        {
            _cache.TryRemove(key, out _);
        }
    }

    /// <summary>A view with no tables, stamped now, with <paramref name="reason"/>.</summary>
    public HuntingSchemaView Empty(string reason) => new(SchemaOrigin.Tenant, reason, time.GetUtcNow(), [], []);

    /// <summary>The schema of the workspace <paramref name="customerId"/> (a GUID) for the account, from the cache unless
    /// <paramref name="refresh"/>, else from the Logs API.</summary>
    public async Task<HuntingSchemaView> GetAsync(string accountKey, string customerId, bool refresh, CancellationToken ct)
    {
        // The id goes into the path: only a GUID, never a "/" or "..".
        if (!Guid.TryParseExact(customerId, "D", out var workspace))
        {
            throw new ArgumentException($"{customerId} is not a workspace id.", nameof(customerId));
        }

        var key = Key(accountKey, workspace.ToString("D"));
        var now = time.GetUtcNow();
        var cached = _cache.TryGetValue(key, out var hit);
        if (!refresh && cached && now < hit.Until)
        {
            return hit.View;
        }

        ct.ThrowIfCancellationRequested();
        using var timeout = new CancellationTokenSource(CallTimeout, time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        try
        {
            var (tables, functions) = await ReadAsync(accountKey, workspace, linked.Token);
            var view = new HuntingSchemaView(SchemaOrigin.Tenant, null, now, tables, functions);
            _cache[key] = (view, now + CacheFor);
            return view;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested && ConsentRequiredException.FindIn(ex) is null)
        {
            var reason = Reason(ex);
            if (cached && hit.View.Tables.Count > 0)
            {
                // The schema read before stays, and the answer says why it wasn't renewed.
                var kept = hit.View with { FallbackReason = reason };
                if (now >= hit.Until)
                {
                    _cache[key] = (kept, now + RetryAfter);
                }

                return kept;
            }

            var empty = Empty(reason);
            _cache[key] = (empty, now + RetryAfter);
            return empty;
        }
    }

    private static string Reason(Exception ex) => ex switch
    {
        _ when SignInRequiredException.IsIn(ex) => "Sign in again to read the workspace's tables.",
        SchemaReadException read => $"The workspace's tables couldn't be read ({read.Message}).",
        OperationCanceledException => "Log Analytics didn't send the workspace's tables in time.",
        _ => "The workspace's tables couldn't be read.",
    };

    /// <summary>A refused or unreadable answer; the message is Log Analytics', cleaned (<see cref="GraphErrorText.Summarize"/>).</summary>
    private sealed class SchemaReadException(string message) : Exception(message);

    private async Task<(IReadOnlyList<HuntingTable> Tables, IReadOnlyList<HuntingFunction> Functions)> ReadAsync(string accountKey,
        Guid workspace, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"v1/workspaces/{workspace:D}/metadata").ForAccount(accountKey);
        using var response = await logs.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var body = await BodyReader.ReadAsync(response.Content, MaxResponseBytes, ct)
            ?? throw new SchemaReadException("it is too large");
        if (!response.IsSuccessStatusCode)
        {
            if (GraphErrorText.IsTokenRejected(response, body))
            {
                throw new SignInRequiredException(GraphErrorText.SignInMessage);
            }

            throw new SchemaReadException(GraphErrorText.Summarize((int)response.StatusCode, Encoding.UTF8.GetString(body), "Log Analytics"));
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new SchemaReadException("the answer isn't readable");
            }

            return ([.. Array(root, "tables").Select(Table).OfType<HuntingTable>()],
                [.. Array(root, "functions").Select(Function).OfType<HuntingFunction>()]);
        }
        catch (JsonException)
        {
            throw new SchemaReadException("the answer isn't readable");
        }
    }

    private static IEnumerable<JsonElement> Array(JsonElement e, string property) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray()
            : [];

    private static HuntingTable? Table(JsonElement e) =>
        Text(e, "name") is { Length: > 0 } name
            ? new HuntingTable(name, Text(e, "description") ?? "", [.. Array(e, "columns").Select(Column).OfType<HuntingColumn>()])
            : null;

    private static HuntingColumn? Column(JsonElement e) =>
        Text(e, "name") is { Length: > 0 } name
            ? new HuntingColumn(name, ServerRows.NormalizeType(Text(e, "type") ?? ""), Text(e, "description") ?? "")
            : null;

    private static HuntingFunction? Function(JsonElement e) =>
        Text(e, "name") is { Length: > 0 } name
            ? new HuntingFunction(name, Text(e, "description") ?? "", Parameters(Text(e, "parameters") ?? ""))
            : null;

    /// <summary>The parameters of <c>"x:string, n:long=5"</c>: a name and a type each (a default value is dropped).</summary>
    // shortcut: splits on commas, so a parameter type with a comma inside (a typed table) is cut; fine for scalar parameters.
    private static List<HuntingParameter> Parameters(string text) =>
    [
        .. text.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=')[0].Split(':', 2, StringSplitOptions.TrimEntries))
            .Where(p => p[0].Length > 0)
            .Select(p => new HuntingParameter(p[0], ServerRows.NormalizeType(p.Length > 1 ? p[1] : ""))),
    ];
}
