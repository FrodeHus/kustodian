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
}
