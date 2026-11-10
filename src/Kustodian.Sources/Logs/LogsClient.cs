using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;
using static Kustodian.Sources.JsonText;

namespace Kustodian.Sources.Logs;

/// <summary>What a Log Analytics query answered: the outcome and, when it isn't <see cref="RunOutcome.Ok"/>, the message to
/// show. A <see cref="RunOutcome.QueryError"/> carries the 1-based position the error names, when it names one. A 200 that also
/// carries an <c>error</c> is <see cref="RunOutcome.Ok"/> with the rows and that error's message as <paramref name="PartialError"/>.
/// The rows are positional, one value per column.</summary>
public sealed record LogsAnswer(RunOutcome Outcome, string? Message, IReadOnlyList<EngineColumn> Columns, IReadOnlyList<JsonElement[]> Rows,
    int? Line = null, int? Column = null, string? PartialError = null)
{
    internal static LogsAnswer Failure(RunOutcome outcome, string message) => new(outcome, message, [], []);
}

/// <summary>
/// The Azure Monitor Logs query API (<c>POST /v1/workspaces/{customerId}/query</c>, delegated <c>Data.Read</c>), over the Logs
/// HTTP client (base address <c>https://api.loganalytics.azure.com/</c>, its token handler and no redirects). Modelled on
/// <c>HuntingClient</c>: every failure is an outcome of the answer, except that a rejected token, or the token handler finding no
/// usable sign-in, throws <see cref="SignInRequiredException"/> (and a missing consent <see cref="ConsentRequiredException"/>),
/// and the caller cancelling throws <see cref="OperationCanceledException"/>.
/// </summary>
public sealed class LogsClient(HttpClient logs, TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// <summary>The Logs API's own cap on a result; a body over it is not read on.</summary>
    public const long MaxResponseBytes = 64L * 1024 * 1024;

    /// <summary>The server waits up to 10 minutes (<c>Prefer: wait=600</c>); the client waits a minute longer.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromMinutes(11);

    public const string TooLarge = "The result is over Log Analytics' 64 MB limit. Add summarize, project or take.";

    /// <summary>The delegated permission the query needs.</summary>
    public const string Permission = "Data.Read";

    public const string NoPermission = "Log Analytics refused the query. You need Reader or Log Analytics Reader on the workspace, and the Data.Read permission.";

    public const string TookTooLong = "Log Analytics stopped the query after 10 minutes. Narrow the query or the timespan and try again.";

    private static readonly JsonSerializerOptions RequestJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private sealed record QueryRequest(string Query, string Timespan);

    /// <summary>Runs <paramref name="kql"/> over <paramref name="timespan"/> (ISO 8601) on the workspace
    /// <paramref name="customerId"/> (a GUID) for <paramref name="accountKey"/>, logging the request in <paramref name="d"/>.</summary>
    public async Task<LogsAnswer> RunAsync(string accountKey, string customerId, string kql, string timespan, RunDiagnostics d,
        CancellationToken ct)
    {
        // The id goes into the path: only a GUID, never a "/" or "..".
        if (!Guid.TryParseExact(customerId, "D", out var workspace))
        {
            return LogsAnswer.Failure(RunOutcome.Failed, $"{customerId} is not a workspace id.");
        }

        var json = JsonSerializer.Serialize(new QueryRequest(kql, timespan), RequestJson);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"v1/workspaces/{workspace:D}/query")
        {
            Content = new StringContent(json, Encoding.UTF8, new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" }),
        }.ForAccount(accountKey).ForRun(d);
        request.Headers.TryAddWithoutValidation("Prefer", "wait=600");
        // The client's own timeout stops at the headers (ResponseHeadersRead): this one covers the body too.
        using var timeout = new CancellationTokenSource(Timeout, _time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        try
        {
            using var response = await logs.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            var body = await BodyReader.ReadAsync(response.Content, MaxResponseBytes, linked.Token);
            if (body is null)
            {
                return LogsAnswer.Failure(RunOutcome.TooLarge, TooLarge);
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
            return LogsAnswer.Failure(RunOutcome.Failed, string.Create(CultureInfo.InvariantCulture,
                $"Log Analytics didn't answer within {(long)Timeout.TotalSeconds} s. Narrow the query or the timespan and try again."));
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            return LogsAnswer.Failure(RunOutcome.Failed, "Log Analytics couldn't be reached. Check the connection and try again.");
        }
    }

    /// <summary>The outcome of a failed answer.</summary>
    private LogsAnswer Refused(HttpResponseMessage response, byte[] body, RunDiagnostics d)
    {
        var status = (int)response.StatusCode;
        var error = ErrorOf(body);
        if (response.StatusCode == HttpStatusCode.Unauthorized
            || (response.StatusCode == HttpStatusCode.Forbidden
                && string.Equals(Text(error, "code"), "InvalidAuthenticationToken", StringComparison.OrdinalIgnoreCase)))
        {
            throw new SignInRequiredException(GraphErrorText.SignInMessage);
        }

        var message = GraphErrorText.Summarize(status, Encoding.UTF8.GetString(body), "Log Analytics");
        switch (response.StatusCode)
        {
            case HttpStatusCode.Forbidden:
                return LogsAnswer.Failure(RunOutcome.NoPermission, NoPermission);
            case HttpStatusCode.TooManyRequests:
                var wait = RetryAfter.Of(response.Headers.RetryAfter, _time) is { } after ? (long)after.TotalSeconds : (long?)null;
                d.Add(new DiagnosticEntry(d.NowMs, DiagnosticKinds.Throttled, "Log Analytics is throttling; "
                    + (wait is { } w ? string.Create(CultureInfo.InvariantCulture, $"Retry-After {w} s") : "no Retry-After"), status, null, null));
                return LogsAnswer.Failure(RunOutcome.Throttled,
                    wait is { } seconds ? string.Create(CultureInfo.InvariantCulture, $"{message} Try again in {seconds} s.") : message);
            case HttpStatusCode.GatewayTimeout:
                return LogsAnswer.Failure(RunOutcome.Failed, TookTooLong);
            case HttpStatusCode.BadRequest:
                return QueryError(error, message);
            default:
                return LogsAnswer.Failure(RunOutcome.Failed, message);
        }
    }

    /// <summary>The <c>error</c> object of a body, or a default element when it has none.</summary>
    private static JsonElement ErrorOf(byte[] body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            return document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("error", out var error)
                ? error.Clone()
                : default;
        }
        catch (JsonException)
        {
            return default;
        }
    }

    /// <summary>A 400 as a query error: the deepest <c>innererror</c>'s message, and the numeric <c>line</c> and 0-based
    /// <c>pos</c> of the innermost one that has them, else the position the message names.</summary>
    private static LogsAnswer QueryError(JsonElement error, string fallback)
    {
        var message = fallback;
        (int Line, int Column)? position = null;
        for (var node = error; node.ValueKind == JsonValueKind.Object; node = node.TryGetProperty("innererror", out var inner) ? inner : default)
        {
            message = Text(node, "message") ?? message;
            if (node.TryGetProperty("line", out var line) && line.TryGetInt32(out var l) && l > 0
                && node.TryGetProperty("pos", out var pos) && pos.TryGetInt32(out var p) && p >= 0)
            {
                position = (l, p + 1);
            }
        }

        position ??= KustoPosition.Of(message);
        return new LogsAnswer(RunOutcome.QueryError, message, [], [], position?.Line, position?.Column);
    }

    /// <summary>The rows of the <c>PrimaryResult</c> table, else the first; each row padded or cut to the column count.</summary>
    private static LogsAnswer Parse(byte[] body)
    {
        if (body.Length == 0)
        {
            return new LogsAnswer(RunOutcome.Ok, null, [], []);
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return LogsAnswer.Failure(RunOutcome.Failed, Unreadable);
            }

            var partial = root.TryGetProperty("error", out var error) ? Text(error, "message") ?? Text(error, "code") : null;
            var tables = root.TryGetProperty("tables", out var t) && t.ValueKind == JsonValueKind.Array ? t.EnumerateArray().ToList() : [];
            if (tables.Count == 0)
            {
                return new LogsAnswer(RunOutcome.Ok, null, [], [], PartialError: partial);
            }

            var table = tables.FirstOrDefault(x => Text(x, "name") == "PrimaryResult");
            if (table.ValueKind != JsonValueKind.Object)
            {
                table = tables[0];
            }

            var columns = table.TryGetProperty("columns", out var c) && c.ValueKind == JsonValueKind.Array
                ? c.EnumerateArray().Select(x => new EngineColumn(Text(x, "name") ?? "", ServerRows.NormalizeType(Text(x, "type") ?? ""))).ToList()
                : [];
            var nullValue = JsonDocument.Parse("null").RootElement;
            var rows = new List<JsonElement[]>();
            if (table.TryGetProperty("rows", out var r) && r.ValueKind == JsonValueKind.Array)
            {
                foreach (var row in r.EnumerateArray())
                {
                    var values = new JsonElement[columns.Count];
                    Array.Fill(values, nullValue);
                    if (row.ValueKind == JsonValueKind.Array)
                    {
                        var i = 0;
                        foreach (var value in row.EnumerateArray().Take(columns.Count))
                        {
                            values[i++] = value.Clone();
                        }
                    }

                    rows.Add(values);
                }
            }

            return new LogsAnswer(RunOutcome.Ok, null, columns, rows, PartialError: partial);
        }
        catch (JsonException)
        {
            return LogsAnswer.Failure(RunOutcome.Failed, Unreadable);
        }
    }

    private const string Unreadable = "Log Analytics' answer to the query isn't readable.";
}
