namespace Kustodian.Graph.Run;

/// <summary>The account has no usable token and has to sign in again. Thrown from inside the HTTP pipeline by the token handler;
/// <see cref="GraphRunner"/> answers it as <see cref="RunOutcome.SignInNeeded"/>, wherever in an exception chain it surfaces.</summary>
public sealed class SignInRequiredException : Exception
{
    public SignInRequiredException()
    {
    }

    public SignInRequiredException(string message) : base(message)
    {
    }

    public SignInRequiredException(string message, Exception inner) : base(message, inner)
    {
    }

    /// <summary>Whether <paramref name="ex"/> is, or wraps (inner exceptions, aggregates), a <see cref="SignInRequiredException"/>.</summary>
    public static bool IsIn(Exception? ex) => ex switch
    {
        null => false,
        SignInRequiredException => true,
        AggregateException aggregate => aggregate.InnerExceptions.Any(IsIn),
        _ => IsIn(ex.InnerException),
    };
}
