using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Fetch;
using Kustodian.Graph.Run;

namespace Kustodian.Sources.Arg;

/// <summary>What an Azure Resource Graph run answered: the outcome and, when it isn't <see cref="RunOutcome.Ok"/>, the message to
/// show (an <see cref="RunOutcome.Ok"/> answer has one when ARG cut the result short, <see cref="ArgClient.Truncated"/>).
/// <see cref="Total"/> is ARG's <c>totalRecords</c>, which may be more than the rows read; without it, at least the rows ARG
/// sent, and one more than were read when a page token was left. A
/// <see cref="RunOutcome.QueryError"/> carries the 1-based position ARG's error details name, in the query as sent, when they name
/// one. The rows are positional, one value per column.</summary>
public sealed record ArgAnswer(RunOutcome Outcome, string? Message, IReadOnlyList<EngineColumn> Columns,
    IReadOnlyList<JsonElement[]> Rows, int Total, int? Line = null, int? Column = null)
{
    internal static ArgAnswer Failure(RunOutcome outcome, string message) => new(outcome, message, [], [], 0);
}

/// <summary>
/// Azure Resource Graph (<c>POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01</c>),
/// over the ARM HTTP client (its token handler, run log and no redirects). A run asks for pages of <see cref="PageSize"/> rows as
/// <c>objectArray</c> and follows <c>$skipToken</c> until it has the rows asked for or there is no token. Each request, its body
/// read included, has <see cref="RequestTimeout"/>. Every failure is an outcome of the answer, except that a 401 rejecting the
/// token, or the token handler finding no usable sign-in, throws <see cref="SignInRequiredException"/>; the token handler's
/// <see cref="ConsentRequiredException"/> and the caller cancelling (<see cref="OperationCanceledException"/>) are thrown too.
/// </summary>
public sealed class ArgClient(HttpClient arm, TimeProvider? time = null)
{
    public static readonly Uri Endpoint = new("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01");

    public const int PageSize = 1_000;

    public const int MaxPages = 1_000;

    /// <summary>A page of 1,000 rows is far below this; a body over it is not read on.</summary>
    public const long MaxPageBytes = 64L * 1024 * 1024;

    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(60);

    /// <summary>The longest a throttled run waits before its one retry.</summary>
    public static readonly TimeSpan MaxRetryWait = TimeSpan.FromSeconds(30);

    public const string NoPermission = "You don't have access to Azure Resource Graph in this scope.";

    public const string SamePageTwice = "Azure Resource Graph returned the same page twice.";

    public const string TooManyPages = "Azure Resource Graph sent more than 1,000 pages. Narrow the query.";

    public const string TooLarge = "A page from Azure Resource Graph is over 64 MB. Project fewer columns.";

    public const string Unreachable = "Azure Resource Graph couldn't be reached. Check the connection and try again.";

    public const string Unreadable = "Azure Resource Graph's answer isn't readable.";

    /// <summary>An answer's message when ARG says it cut the result short and gave no token to page on with (a query without the
    /// <c>id</c> column can't be paged).</summary>
    public const string Truncated = "Resource Graph cut this result short; include the id column to page through all rows.";

    private const string QuotaRemainingHeader = "x-ms-user-quota-remaining";
    private const string QuotaResetsHeader = "x-ms-user-quota-resets-after";

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// <summary>Runs <paramref name="kql"/> at <paramref name="scope"/> for <paramref name="accountKey"/>, reading at most
    /// <paramref name="maxRows"/> rows, logging each request in <paramref name="d"/>. <paramref name="following"/> hears the
    /// number of pages read each time the run follows a <c>$skipToken</c> to the next.</summary>
    public async Task<ArgAnswer> RunAsync(string accountKey, string kql, ArgScope scope, int maxRows, RunDiagnostics d, CancellationToken ct,
        Action<int>? following = null)
    {
        var rows = new List<JsonElement>();
        var seenTokens = new HashSet<string>(StringComparer.Ordinal);
        string? token = null;
        int? reported = null;
        long sent = 0;
        Page? last = null;
        var retried = false;
        var pages = 0;
        while (true)
        {
            if (pages == MaxPages)
            {
                return ArgAnswer.Failure(RunOutcome.Failed, TooManyPages);
            }

            var page = await SendAsync(accountKey, kql, scope, token, d, ct);
            if (page.Throttled is { } throttled)
            {
                if (retried)
                {
                    return ArgAnswer.Failure(RunOutcome.Throttled, throttled.Message);
                }

                retried = true;
                var asked = throttled.RetryAfter ?? throttled.QuotaResets ?? TimeSpan.Zero;
                var wait = asked < MaxRetryWait ? asked : MaxRetryWait;
                d.Add(new DiagnosticEntry(d.NowMs, DiagnosticKinds.Retry,
                    string.Create(CultureInfo.InvariantCulture, $"Sending the page again after {(long)wait.TotalSeconds} s"), null, null, null));
                await Task.Delay(wait, _time, ct);
                continue;
            }

            if (page.Answer is { } final)
            {
                return final;
            }

            pages++;
            last = page;
            reported = page.Total ?? reported;
            sent += page.Rows.Count;
            foreach (var row in page.Rows)
            {
                if (rows.Count == maxRows)
                {
                    break;
                }

                rows.Add(row);
            }

            if (rows.Count >= maxRows || page.SkipToken is null)
            {
                break;
            }

            if (!seenTokens.Add(page.SkipToken))
            {
                return ArgAnswer.Failure(RunOutcome.Failed, SamePageTwice);
            }

            token = page.SkipToken;
            following?.Invoke(pages);
        }

        // ARG's totalRecords when the last page has it; else at least every row sent, or the last total a page reported; and a
        // token left to follow means at least one row more than were read.
        var total = last?.Total ?? (int)Math.Min(int.MaxValue, Math.Max(sent, reported ?? 0));
        if (last?.SkipToken is not null)
        {
            total = Math.Max(total, rows.Count + 1);
        }

        var (columns, shaped) = ServerRows.Shape(rows, null);
        return new ArgAnswer(RunOutcome.Ok, last is { Truncated: true, SkipToken: null } ? Truncated : null, columns, shaped, total);
    }

    /// <summary>One page (its <c>totalRecords</c>, null when it has none, and whether ARG says it cut the result short), or the
    /// answer that ends the run, or a 429 to wait out.</summary>
    private sealed record Page(IReadOnlyList<JsonElement> Rows, int? Total, string? SkipToken, bool Truncated = false, ArgAnswer? Answer = null,
        Throttle? Throttled = null)
    {
        public static Page Ending(ArgAnswer answer) => new([], null, null, Answer: answer);
    }

    /// <summary>A 429: its <c>Retry-After</c>, when ARG's quota resets (<c>x-ms-user-quota-resets-after</c>, the wait when
    /// there is no <c>Retry-After</c>), and the message for the user.</summary>
    private sealed record Throttle(TimeSpan? RetryAfter, TimeSpan? QuotaResets, string Message);

    private async Task<Page> SendAsync(string accountKey, string kql, ArgScope scope, string? skipToken, RunDiagnostics d,
        CancellationToken ct)
    {
        using var timeout = new CancellationTokenSource(RequestTimeout, _time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            Content = new StringContent(RequestBody(kql, scope, skipToken), Encoding.UTF8, "application/json"),
        }.ForAccount(accountKey).ForRun(d);
        try
        {
            using var response = await arm.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            var body = await BodyReader.ReadAsync(response.Content, MaxPageBytes, linked.Token);
            if (body is null)
            {
                return Page.Ending(ArgAnswer.Failure(RunOutcome.TooLarge, TooLarge));
            }

            request.RecordBytes(body.Length);
            return response.IsSuccessStatusCode ? Parse(body) : Refused(response, body, d);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            return Page.Ending(ArgAnswer.Failure(RunOutcome.Failed, string.Create(CultureInfo.InvariantCulture,
                $"Azure Resource Graph didn't answer within {(long)RequestTimeout.TotalSeconds} s. Narrow the query and try again.")));
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            return Page.Ending(ArgAnswer.Failure(RunOutcome.Failed, Unreachable));
        }
    }

    /// <summary>The request: the query, the scope (<c>subscriptions</c>, <c>managementGroups</c>, or neither for "all I can
    /// see") and the options. The first page sends <c>$skip: 0</c>; a later one sends the token instead, since <c>$skip</c>
    /// overrides the offset a token carries (QueryRequestOptions).</summary>
    internal static string RequestBody(string kql, ArgScope scope, string? skipToken)
    {
        var body = new JsonObject { ["query"] = kql };
        switch (scope.Kind)
        {
            case ArgScope.Subscriptions:
                body["subscriptions"] = new JsonArray([.. scope.Ids.Select(id => (JsonNode)JsonValue.Create(id))]);
                break;
            case ArgScope.ManagementGroup:
                body["managementGroups"] = new JsonArray([.. scope.Ids.Select(id => (JsonNode)JsonValue.Create(id))]);
                break;
        }

        var options = new JsonObject { ["$top"] = PageSize };
        if (skipToken is null)
        {
            options["$skip"] = 0;
        }

        options["resultFormat"] = "objectArray";
        if (skipToken is not null)
        {
            options["$skipToken"] = skipToken;
        }

        body["options"] = options;
        return body.ToJsonString();
    }

    private static Page Parse(byte[] body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return Page.Ending(ArgAnswer.Failure(RunOutcome.Failed, Unreadable));
            }

            List<JsonElement> rows = root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array
                ? [.. data.EnumerateArray().Select(r => r.Clone())]
                : [];
            int? total = root.TryGetProperty("totalRecords", out var t) && t.ValueKind == JsonValueKind.Number && t.TryGetInt64(out var n)
                ? (int)Math.Clamp(n, 0, int.MaxValue)
                : null;
            var token = root.TryGetProperty("$skipToken", out var s) && s.ValueKind == JsonValueKind.String && s.GetString() is { Length: > 0 } text
                ? text
                : null;
            // resultTruncated is "true" or "false" (ResultTruncated); a boolean is taken too.
            var truncated = root.TryGetProperty("resultTruncated", out var r)
                && (r.ValueKind == JsonValueKind.True
                    || (r.ValueKind == JsonValueKind.String && string.Equals(r.GetString(), "true", StringComparison.OrdinalIgnoreCase)));
            return new Page(rows, total, token, truncated);
        }
        catch (JsonException)
        {
            return Page.Ending(ArgAnswer.Failure(RunOutcome.Failed, Unreadable));
        }
    }

    /// <summary>What a refused page means for the run.</summary>
    private Page Refused(HttpResponseMessage response, byte[] body, RunDiagnostics d)
    {
        if (IsTokenRejected(response, body))
        {
            throw new SignInRequiredException(GraphErrorText.SignInMessage);
        }

        var status = (int)response.StatusCode;
        var error = ArgError.From(status, body);
        switch (response.StatusCode)
        {
            // A 401 that doesn't reject the token is a refused permission, as a 403 is.
            case HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized:
                return Page.Ending(ArgAnswer.Failure(RunOutcome.NoPermission, NoPermission));
            case HttpStatusCode.TooManyRequests:
                return new Page([], null, null, Throttled: ThrottleOf(response, error.Message, d));
            case HttpStatusCode.BadRequest:
                return Page.Ending(new ArgAnswer(RunOutcome.QueryError, error.Message, [], [], 0, error.Line, error.Column));
            default:
                return Page.Ending(ArgAnswer.Failure(RunOutcome.Failed, error.Message));
        }
    }

    /// <summary>ARM rejects an expired token with <c>ExpiredAuthenticationToken</c>, which Graph's check doesn't know.</summary>
    internal static bool IsTokenRejected(HttpResponseMessage response, byte[] body) =>
        GraphErrorText.IsTokenRejected(response, body)
        || (response.StatusCode == HttpStatusCode.Unauthorized && ArgError.Code(body) is "ExpiredAuthenticationToken");

    /// <summary>A 429: logs it with ARG's quota headers, and says how long to wait and what to tell the user.</summary>
    private Throttle ThrottleOf(HttpResponseMessage response, string explanation, RunDiagnostics d)
    {
        var wait = RetryAfter.Of(response.Headers.RetryAfter, _time);
        var remaining = Header(response, QuotaRemainingHeader);
        var resets = Header(response, QuotaResetsHeader);
        var detail = "Azure Resource Graph is throttling; "
            + (wait is { } w ? string.Create(CultureInfo.InvariantCulture, $"Retry-After {(long)w.TotalSeconds} s") : "no Retry-After")
            + (remaining is null ? "" : $", quota left {remaining}")
            + (resets is null ? "" : $", resets after {resets}");
        d.Add(new DiagnosticEntry(d.NowMs, DiagnosticKinds.Throttled, detail, (int)response.StatusCode, null, null));

        var message = new StringBuilder(explanation);
        if (wait is { } seconds)
        {
            message.Append(CultureInfo.InvariantCulture, $" Try again in {(long)seconds.TotalSeconds} s.");
        }

        if (remaining is not null || resets is not null)
        {
            message.Append(" Resource Graph quota")
                .Append(remaining is null ? "" : $" left: {remaining}")
                .Append(remaining is not null && resets is not null ? "," : "")
                .Append(resets is null ? "" : $" resets after {resets}")
                .Append('.');
        }

        TimeSpan? quotaResets = TimeSpan.TryParseExact(resets, @"hh\:mm\:ss", CultureInfo.InvariantCulture, out var span) ? span : null;
        return new Throttle(wait, quotaResets, message.ToString());
    }

    /// <summary>A short header value, or null; only the quota headers are read, never any other.</summary>
    private static string? Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) && values.FirstOrDefault() is { Length: > 0 and <= 32 } value ? value.Trim() : null;
}

/// <summary>ARG's error answer (<c>ResourceGraphCommon.ErrorResponse</c>): the message to show, and the position a parser
/// detail names. <c>error.message</c> is mostly "Please provide below info when asking for support…", so the details' messages
/// are shown when there are any, verbatim and in order; a detail's <c>token</c> is added to its message. A detail's
/// <c>line</c> is 1-based and its <c>characterPositionInLine</c> 0-based (the ANTLR convention Kusto's parser reports), so the
/// column is one more.</summary>
internal sealed record ArgError(string Message, int? Line, int? Column)
{
    public static ArgError From(int status, byte[] body)
    {
        var text = Encoding.UTF8.GetString(body);
        if (GraphErrorText.IsHtml(text))
        {
            return new ArgError(GraphErrorText.Summarize(status, text, GraphErrorText.Azure), null, null);
        }

        JsonNode? error;
        try
        {
            error = JsonNode.Parse(text)?["error"];
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            error = null;
        }

        var details = error is JsonObject && error["details"] is JsonArray array ? array.OfType<JsonObject>().ToList() : [];
        var messages = details.Select(Describe).OfType<string>().ToList();
        var message = messages.Count > 0 ? string.Join(" ", messages) : GraphErrorText.Summarize(status, text, GraphErrorText.Azure);
        var positioned = details.FirstOrDefault(d => Number(d["line"]) is > 0 && Number(d["characterPositionInLine"]) is >= 0);
        return positioned is null
            ? new ArgError(message, null, null)
            : new ArgError(message, Number(positioned["line"]), Number(positioned["characterPositionInLine"]) + 1);
    }

    /// <summary>The <c>error.code</c> of an error answer, or null.</summary>
    public static string? Code(byte[] body)
    {
        try
        {
            return JsonNode.Parse(body)?["error"]?["code"] is JsonValue code && code.TryGetValue<string>(out var text) ? text : null;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    private static string? Describe(JsonObject detail)
    {
        if (Text(detail["message"]) is not { Length: > 0 } message)
        {
            return null;
        }

        message = message.Trim();
        if (Text(detail["token"]) is { Length: > 0 } token)
        {
            message = $"{message.TrimEnd('.')} at '{token}'.";
        }

        return message;
    }

    private static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static int? Number(JsonNode? node) => node is JsonValue value && value.TryGetValue<int>(out var n) ? n : null;
}
