using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Messaging;

/// <summary>The message channel between the UI and the host. Requests come in as JSON text through <see cref="HandleAsync"/>,
/// which answers with the response text; events go out through the <c>send</c> callback. A handler's exception becomes an
/// error response with its message only: never a stack trace or an exception type.</summary>
public sealed class Bridge(Action<string> send, ILogger<Bridge>? logger = null)
{
    private readonly Dictionary<string, Func<JsonElement, CancellationToken, Task<object?>>> _handlers = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _closing = new();
    private readonly ILogger<Bridge> _log = logger ?? NullLogger<Bridge>.Instance;

    /// <summary>Adds the handler for <paramref name="method"/>. Register every method before the first message arrives.</summary>
    public void Register(string method, Func<JsonElement, CancellationToken, Task<object?>> handler)
    {
        ArgumentException.ThrowIfNullOrEmpty(method);
        ArgumentNullException.ThrowIfNull(handler);
        _handlers.Add(method, handler);
    }

    /// <summary>Handles one request and returns the response text, or null when the message has no id to answer to.</summary>
    public async Task<string?> HandleAsync(string message)
    {
        BridgeRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<BridgeRequest>(message, BridgeJson.Options);
        }
        catch (JsonException)
        {
            _log.LogWarning("Ignored a message from the UI that is not a request");
            return null;
        }

        if (string.IsNullOrEmpty(request?.Id))
        {
            _log.LogWarning("Ignored a message from the UI without an id");
            return null;
        }

        if (string.IsNullOrEmpty(request.Method))
        {
            return Error(request.Id, BridgeErrorCodes.BadRequest, "The request has no method.");
        }

        if (!_handlers.TryGetValue(request.Method, out var handler))
        {
            return Error(request.Id, BridgeErrorCodes.UnknownMethod, $"Unknown method {request.Method}.");
        }

        try
        {
            var result = await handler(request.Params, _closing.Token);
            return JsonSerializer.Serialize(new BridgeResponse(request.Id, result ?? new { }), BridgeJson.Options);
        }
        catch (BridgeException ex)
        {
            return Error(request.Id, ex.Code, ex.Message);
        }
        catch (OperationCanceledException)
        {
            return Error(request.Id, BridgeErrorCodes.Cancelled, "Cancelled.");
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "The bridge method {Method} failed", request.Method);
            return Error(request.Id, BridgeErrorCodes.Failed, ex.Message);
        }
    }

    /// <summary>Sends an event to the UI.</summary>
    public void Emit(string evt, object data) =>
        send(JsonSerializer.Serialize(new BridgeEvent(evt, data), BridgeJson.Options));

    /// <summary>Cancels every handler still running; the window is closing.</summary>
    public void Close() => _closing.Cancel();

    private static string Error(string id, string code, string message) =>
        JsonSerializer.Serialize(new BridgeErrorResponse(id, new BridgeError(code, message)), BridgeJson.Options);
}
