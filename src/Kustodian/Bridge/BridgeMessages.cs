using System.Text.Json;
using System.Text.Json.Serialization;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;

namespace Kustodian.Messaging;

/// <summary>A call from the UI: <c>{ "id", "method", "params" }</c>.</summary>
public sealed record BridgeRequest(string? Id, string? Method, JsonElement Params);

/// <summary>A successful answer: <c>{ "id", "result" }</c>.</summary>
public sealed record BridgeResponse(string Id, object? Result);

/// <summary>What a handler returns to answer <c>null</c> on the wire: a handler that returns nothing answers <c>{}</c>.</summary>
public sealed class BridgeNull
{
    public static BridgeNull Value { get; } = new();

    private BridgeNull()
    {
    }
}

/// <summary>A failed answer: <c>{ "id", "error": { "code", "message" } }</c>.</summary>
public sealed record BridgeErrorResponse(string Id, BridgeError Error);

public sealed record BridgeError(string Code, string Message);

/// <summary>A message the host sends unasked: <c>{ "event", "data" }</c>.</summary>
public sealed record BridgeEvent(string Event, object Data);

/// <summary>The error codes on the wire.</summary>
public static class BridgeErrorCodes
{
    public const string UnknownMethod = "unknown_method";
    public const string BadRequest = "bad_request";
    public const string Cancelled = "cancelled";
    public const string Failed = "failed";
    public const string SignInNeeded = "signInNeeded";

    /// <summary>An ARM token needs the user (<c>account.consent {key, audience: "arm"}</c>); the account stays signed in.</summary>
    public const string ConsentNeeded = "consentNeeded";
}

/// <summary>Thrown by a handler to answer with a specific error code; its message is shown to the user.</summary>
public sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>How the bridge reads and writes JSON: camelCase names, enums as camelCase strings.</summary>
public static class BridgeJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase), new RunResultConverter() },
    };

    /// <summary>Reads a request's params as <typeparamref name="T"/>; missing or malformed params are a
    /// <see cref="BridgeErrorCodes.BadRequest"/>.</summary>
    public static T Params<T>(JsonElement element)
        where T : class
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no params.");
        }

        try
        {
            return element.Deserialize<T>(Options)
                ?? throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no params.");
        }
        catch (JsonException)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request's params are not valid.");
        }
    }
}

/// <summary>Writes a <see cref="RunResult"/> as the UI reads it: its duration as <c>durationMs</c>, a number of milliseconds,
/// rather than a TimeSpan string, then its <c>runId</c> and <c>diagnostics</c>. Results only go out, so reading is not
/// supported.</summary>
public sealed class RunResultConverter : JsonConverter<RunResult>
{
    public override RunResult Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        throw new NotSupportedException("Run results are only written.");

    public override void Write(Utf8JsonWriter writer, RunResult value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, new RunResultWire(value.Outcome, value.Message, value.Error, value.Columns, value.Rows,
            value.Total, value.Tables, (long)Math.Round(value.Duration.TotalMilliseconds), value.DroppedValues, value.RunId,
            value.Diagnostics), options);

    private sealed record RunResultWire(RunOutcome Outcome, string? Message, GraphQueryError? Error,
        IReadOnlyList<EngineColumn> Columns, IReadOnlyList<JsonElement[]> Rows, int Total, IReadOnlyList<TableFetch> Tables,
        long DurationMs, int DroppedValues, string RunId, IReadOnlyList<DiagnosticEntry> Diagnostics);
}
