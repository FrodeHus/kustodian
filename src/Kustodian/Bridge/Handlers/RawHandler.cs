using Kustodian.Graph.Run;
using Kustodian.Raw;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>raw.send {version, path, headers}</c> and <c>raw.next {nextLink}</c>: raw Graph GETs for the active account,
/// answered with a <see cref="RawResponse"/> (<see cref="RawRequestService"/> has the guards). A refused request is a
/// <c>bad_request</c>; no account, or one that has to sign in again, is <c>signInNeeded</c>; a request Graph didn't answer is
/// <c>failed</c>. Graph's error statuses are answers, not errors. Error messages never repeat the page's headers.</summary>
public sealed class RawHandler(RawRequestService raw, Func<Task<string?>> activeAccount)
{
    public void Register(Bridge bridge)
    {
        bridge.Register("raw.send", async (p, ct) =>
        {
            var request = BridgeJson.Params<SendParams>(p);
            if (request.Version is null || request.Path is null)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "A raw request needs a version and a path.");
            }

            var headers = request.Headers ?? new Dictionary<string, string>();
            return await SendAsync(account => raw.SendAsync(account, request.Version, request.Path, headers, ct), ct);
        });
        bridge.Register("raw.next", async (p, ct) =>
        {
            var request = BridgeJson.Params<NextParams>(p);
            if (request.NextLink is null)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "A next request needs a nextLink.");
            }

            return await SendAsync(account => raw.NextAsync(account, request.NextLink, ct), ct);
        });
    }

    private async Task<object?> SendAsync(Func<string, Task<RawResponse>> send, CancellationToken ct)
    {
        if (await activeAccount() is not { } account)
        {
            throw new BridgeException(BridgeErrorCodes.SignInNeeded, GraphRunner.SignInMessage);
        }

        try
        {
            return await send(account);
        }
        catch (RawRequestRefusedException ex)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, ex.Message);
        }
        catch (Exception ex) when (IsSignIn(ex))
        {
            throw new BridgeException(BridgeErrorCodes.SignInNeeded, GraphRunner.SignInMessage);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new BridgeException(BridgeErrorCodes.Failed, "Graph didn't answer in time.");
        }
        catch (HttpRequestException ex)
        {
            throw new BridgeException(BridgeErrorCodes.Failed, $"Graph couldn't be reached: {ex.Message}");
        }
    }

    private static bool IsSignIn(Exception? ex) => ex switch
    {
        null => false,
        SignInRequiredException => true,
        AggregateException aggregate => aggregate.InnerExceptions.Any(IsSignIn),
        _ => IsSignIn(ex.InnerException),
    };

    private sealed record SendParams(string? Version, string? Path, Dictionary<string, string>? Headers);

    private sealed record NextParams(string? NextLink);
}
