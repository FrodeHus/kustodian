using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using static Kustodian.Sources.JsonText;

namespace Kustodian.Sources.Hunting;

/// <summary>What an advanced hunting call answered: the outcome and, when it isn't <see cref="RunOutcome.Ok"/>, the message to
/// show. A <see cref="RunOutcome.QueryError"/> carries the 1-based position Graph's message names, in the query as sent, when it
/// names one. The rows are positional, one value per column.</summary>
public sealed record HuntingAnswer(RunOutcome Outcome, string? Message, IReadOnlyList<EngineColumn> Columns,
    IReadOnlyList<JsonElement[]> Rows, int? Line = null, int? Column = null)
{
    internal static HuntingAnswer Failure(RunOutcome outcome, string message) => new(outcome, message, [], []);
}

/// <summary>
/// Microsoft Graph's advanced hunting (<c>POST https://graph.microsoft.com/v1.0/security/runHuntingQuery</c>, delegated
/// <c>ThreatHunting.Read.All</c>), over the Graph HTTP client (its token handler, run log and no redirects). Ported from the
/// portal's <c>GraphHuntingClient</c>. Every failure is an outcome of the answer, except that a 401 rejecting the token, or the
/// token handler finding no usable sign-in, throws <see cref="SignInRequiredException"/>, and the caller cancelling throws
/// <see cref="OperationCanceledException"/>. The request, its body read included, has <see cref="Timeout"/> on
/// <paramref name="time"/>'s clock, which also dates a <c>Retry-After</c>.
/// </summary>
public sealed partial class HuntingClient(HttpClient graph, TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public static readonly Uri Endpoint = new("https://graph.microsoft.com/v1.0/security/runHuntingQuery");

    /// <summary>Microsoft's own cap on a result; a body over it is not read on.</summary>
    public const long MaxResponseBytes = 50L * 1024 * 1024;

    /// <summary>Advanced hunting stops a request after 3 minutes; the Graph client for hunting waits a little longer than that
    /// (<c>GraphHttp.CreateClient</c>'s timeout).</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromMinutes(4);

    public const string TooLarge = "The result is over Microsoft's 50 MB limit. Add summarize, project or take.";

    public const string NoPermission = "Advanced hunting needs the ThreatHunting.Read.All permission and a Defender role (for example "
        + "Security Reader). With the Azure CLI client this permission may not be available: use your own app registration.";

    private static readonly JsonSerializerOptions RequestJson = new() { PropertyNamingPolicy = null };

    /// <summary>The request body, with Graph's own property names.</summary>
    private sealed record HuntingRequest(string Query, string Timespan);

    /// <summary>Runs <paramref name="kql"/> over <paramref name="timespan"/> (ISO 8601) for <paramref name="accountKey"/>, logging
    /// the request in <paramref name="d"/>.</summary>
    public async Task<HuntingAnswer> RunAsync(string accountKey, string kql, string timespan, RunDiagnostics d, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(new HuntingRequest(kql, timespan), RequestJson);
        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            // Non-ANSI characters in a query need the charset stated (runHuntingQuery's docs).
            Content = new StringContent(json, Encoding.UTF8, new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" }),
        }.ForAccount(accountKey).ForRun(d);
        // The client's own timeout stops at the headers (ResponseHeadersRead): this one covers the body too.
        using var timeout = new CancellationTokenSource(Timeout, _time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        try
        {
            using var response = await graph.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            var body = await BodyReader.ReadAsync(response.Content, MaxResponseBytes, linked.Token);
            if (body is null)
            {
                return HuntingAnswer.Failure(RunOutcome.TooLarge, TooLarge);
            }

            request.RecordBytes(body.Length);
            return response.IsSuccessStatusCode ? Parse(body) : Refused(response, body, d);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException ex) when (timeout.IsCancellationRequested || ex.InnerException is TimeoutException)
        {
            return HuntingAnswer.Failure(RunOutcome.Failed, string.Create(CultureInfo.InvariantCulture,
                $"Microsoft Defender didn't answer within {(long)Timeout.TotalSeconds} s. Narrow the query or the timespan and try again."));
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            return HuntingAnswer.Failure(RunOutcome.Failed, "Graph couldn't be reached. Check the connection and try again.");
        }
    }

    /// <summary>The outcome of a failed answer.</summary>
    private HuntingAnswer Refused(HttpResponseMessage response, byte[] body, RunDiagnostics d)
    {
        if (GraphErrorText.IsTokenRejected(response, body))
        {
            throw new SignInRequiredException(GraphErrorText.SignInMessage);
        }

        var status = (int)response.StatusCode;
        var message = GraphErrorText.Summarize(status, Encoding.UTF8.GetString(body));
        switch (response.StatusCode)
        {
            // A 401 that doesn't reject the token is a refused permission, as a 403 is.
            case HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized:
                return HuntingAnswer.Failure(RunOutcome.NoPermission, NoPermission);
            case HttpStatusCode.TooManyRequests:
                var wait = RetryAfter.Of(response.Headers.RetryAfter, _time) is { } after ? (long)after.TotalSeconds : (long?)null;
                d.Add(new DiagnosticEntry(d.NowMs, DiagnosticKinds.Throttled, "Advanced hunting is throttling; "
                    + (wait is { } w ? string.Create(CultureInfo.InvariantCulture, $"Retry-After {w} s") : "no Retry-After"), status, null, null));
                return HuntingAnswer.Failure(RunOutcome.Throttled,
                    wait is { } seconds ? string.Create(CultureInfo.InvariantCulture, $"{message} Try again in {seconds} s.") : message);
            case HttpStatusCode.BadRequest:
                var position = Position(message);
                return new HuntingAnswer(RunOutcome.QueryError, message, [], [], position?.Line, position?.Column);
            default:
                return HuntingAnswer.Failure(RunOutcome.Failed, message);
        }
    }

    /// <summary>The position a query error names: Kusto's <c>line [L,C]</c>, or <c>line L, column C</c> (also <c>position</c>
    /// or <c>pos</c>). Null when it names none. See <c>Fixtures/hunting-run-400.json</c>: no real body with a position has been
    /// recorded, so these are the forms Kusto writes.</summary>
    internal static (int Line, int Column)? Position(string message)
    {
        var match = BracketPosition().Match(message);
        if (!match.Success)
        {
            match = WordPosition().Match(message);
        }

        return match.Success
            && int.TryParse(match.Groups["line"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var line)
            && int.TryParse(match.Groups["column"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var column)
            && line > 0 && column > 0
            ? (line, column)
            : null;
    }

    [GeneratedRegex(@"\bline\s*\[\s*(?<line>[0-9]{1,6})\s*,\s*(?<column>[0-9]{1,6})\s*\]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BracketPosition();

    [GeneratedRegex(@"\bline\s+(?<line>[0-9]{1,6})\s*,?\s*(?:column|col|position|pos)\s+(?<column>[0-9]{1,6})\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex WordPosition();

    /// <summary>The columns from <c>schema</c> and the rows from <c>results</c>, through <see cref="ServerRows.Shape"/>.</summary>
    private static HuntingAnswer Parse(byte[] body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return HuntingAnswer.Failure(RunOutcome.Failed, "Graph's answer to the hunting query isn't readable.");
            }

            List<EngineColumn> declared = root.TryGetProperty("schema", out var schema) && schema.ValueKind == JsonValueKind.Array
                ? [.. schema.EnumerateArray().Select(Column).OfType<EngineColumn>()]
                : [];
            List<JsonElement> results = root.TryGetProperty("results", out var rows) && rows.ValueKind == JsonValueKind.Array
                ? [.. rows.EnumerateArray()]
                : [];
            var (columns, shaped) = ServerRows.Shape(declared.Count > 0 ? results.Select(r => Align(r, declared)) : results, declared);
            return new HuntingAnswer(RunOutcome.Ok, null, columns, shaped);
        }
        catch (JsonException)
        {
            return HuntingAnswer.Failure(RunOutcome.Failed, "Graph's answer to the hunting query isn't readable.");
        }
    }

    private static EngineColumn? Column(JsonElement column)
    {
        if (column.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return Text(column, "name") is { Length: > 0 } name ? new EngineColumn(name, Text(column, "type") ?? "") : null;
    }

    /// <summary>A row keyed by the declared column names. Graph may write the keys in another case than <c>schema</c> does
    /// (runHuntingQuery's second example camelCases them), so a key that isn't a column's name exactly takes the column of the
    /// same name ignoring case, and failing that the column at its position, when the row has one key per column.</summary>
    private static JsonElement Align(JsonElement row, IReadOnlyList<EngineColumn> declared)
    {
        if (row.ValueKind != JsonValueKind.Object)
        {
            return row;
        }

        var properties = row.EnumerateObject().ToList();
        var exact = declared.Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
        if (properties.TrueForAll(p => exact.Contains(p.Name)))
        {
            return row;
        }

        var ignoringCase = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var column in declared)
        {
            ignoringCase.TryAdd(column.Name, column.Name);
        }

        var positional = properties.Count == declared.Count;
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            var written = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < properties.Count; i++)
            {
                var name = exact.Contains(properties[i].Name) ? properties[i].Name
                    : ignoringCase.TryGetValue(properties[i].Name, out var named) ? named
                    : positional ? declared[i].Name
                    : null;
                if (name is not null && written.Add(name))
                {
                    writer.WritePropertyName(name);
                    properties[i].Value.WriteTo(writer);
                }
            }

            writer.WriteEndObject();
        }

        using var aligned = JsonDocument.Parse(buffer.ToArray());
        return aligned.RootElement.Clone();
    }
}
