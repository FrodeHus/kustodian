using System.Net.Http.Headers;
using System.Text.Json;
using Kustodian.Graph.Run;
using Microsoft.Extensions.Logging;

namespace Kustodian.Sources;

/// <summary>Where a source's schema came from, as <c>schema.get</c> names it: read for the account, or bundled.</summary>
public static class SchemaOrigin
{
    public const string Tenant = "tenant";
    public const string BuiltIn = "builtIn";
}

/// <summary>Azure Resource Manager's host: the only one the ARM token handler gives a token, and the only one a list's
/// <c>nextLink</c> is followed to.</summary>
public static class Arm
{
    public const string Host = "management.azure.com";
}

/// <summary>How long a <c>Retry-After</c> asks to wait: its delay, or its date less now on <paramref name="time"/>'s clock, in
/// whole seconds rounded up and never below zero; null when there is no header.</summary>
internal static class RetryAfter
{
    public static TimeSpan? Of(RetryConditionHeaderValue? header, TimeProvider time)
    {
        var wait = header?.Delta ?? (header?.Date is { } date ? date - time.GetUtcNow() : null);
        return wait is { } w ? TimeSpan.FromSeconds(Math.Max(0, Math.Ceiling(w.TotalSeconds))) : null;
    }
}

internal static class JsonText
{
    /// <summary>The string <paramref name="property"/> of an object, or null when it isn't an object or the property isn't a
    /// string.</summary>
    public static string? Text(JsonElement e, string property) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

/// <summary>What the server-side sources (advanced hunting, Resource Graph) make of an exception their client let through: a
/// sign-in to renew is <see cref="RunOutcome.SignInNeeded"/>, anything else is <see cref="RunOutcome.Failed"/> with the reason
/// logged, not shown. <see cref="ConsentRequiredException"/> isn't theirs to answer (<see cref="Handles"/> is false): it goes on
/// to the query handler, as does the caller cancelling.</summary>
internal static class SourceFailure
{
    public static bool Handles(Exception ex, CancellationToken ct) =>
        !(ex is OperationCanceledException && ct.IsCancellationRequested) && ConsentRequiredException.FindIn(ex) is null;

    public static (RunOutcome Outcome, string Message) Of(Exception ex, ILogger log, string source)
    {
        if (SignInRequiredException.IsIn(ex))
        {
            return (RunOutcome.SignInNeeded, GraphRunner.SignInMessage);
        }

        log.LogError(ex, "A {Source} query failed unexpectedly", source);
        return (RunOutcome.Failed, GraphRunner.Unexpected);
    }
}
