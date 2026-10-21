namespace Kustodian.Graph.Fetch;

/// <summary>Why a collection couldn't be read.</summary>
public enum GraphReadFailure { NoPermission, Throttled, TooLarge, NotFound, Busy, Failed, SignInNeeded }

/// <summary>A collection read that failed, with a message fit to show the user. <see cref="GraphReadFailure.SignInNeeded"/> means
/// Graph rejected the account's token: the user has to sign in again. <see cref="Requests"/> are the relative URLs sent before it
/// failed, so the page can show what was asked.</summary>
public sealed class GraphReadException(GraphReadFailure failure, string message, int? retryAfterSeconds = null, Exception? inner = null)
    : Exception(message, inner)
{
    public GraphReadFailure Failure { get; } = failure;
    public int? RetryAfterSeconds { get; } = retryAfterSeconds;
    public IReadOnlyList<string> Requests { get; init; } = [];

    /// <summary>The same failure, with the requests that led to it.</summary>
    public GraphReadException WithRequests(IReadOnlyList<string> requests)
        => new(Failure, Message, RetryAfterSeconds, InnerException) { Requests = requests };
}
