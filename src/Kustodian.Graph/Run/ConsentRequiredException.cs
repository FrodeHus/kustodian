namespace Kustodian.Graph.Run;

/// <summary>The account is signed in, but a token for another audience (<see cref="Audience"/>, <c>arm</c>) needs the user: to
/// consent, or to satisfy a policy. Unlike <see cref="SignInRequiredException"/> it never means the sign-in has expired. A run
/// that meets it, wherever in an exception chain, ends as <see cref="RunOutcome.ConsentNeeded"/>, and the UI offers to grant
/// access (<c>account.consent</c>).</summary>
public sealed class ConsentRequiredException : Exception
{
    public const string ArmMessage = "Kustodian needs your permission to read Azure resources for this account.";

    public ConsentRequiredException()
        : this("arm")
    {
    }

    public ConsentRequiredException(string audience)
        : base(ArmMessage)
    {
        Audience = audience;
    }

    public ConsentRequiredException(string audience, Exception inner)
        : base(ArmMessage, inner)
    {
        Audience = audience;
    }

    /// <summary>The audience whose token needs the user, as the bridge names it (<c>arm</c>).</summary>
    public string Audience { get; }

    /// <summary>The <see cref="ConsentRequiredException"/> that <paramref name="ex"/> is or wraps (inner exceptions, aggregates),
    /// or null.</summary>
    public static ConsentRequiredException? FindIn(Exception? ex) => ex switch
    {
        null => null,
        ConsentRequiredException consent => consent,
        AggregateException aggregate => aggregate.InnerExceptions.Select(FindIn).FirstOrDefault(c => c is not null),
        _ => FindIn(ex.InnerException),
    };
}
