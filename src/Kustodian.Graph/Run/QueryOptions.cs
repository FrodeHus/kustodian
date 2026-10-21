using System.Globalization;
using System.Text.RegularExpressions;

namespace Kustodian.Graph.Run;

/// <summary>Where an Azure Resource Graph query looks. <see cref="Kind"/> is <c>subscriptions</c> (<see cref="Ids"/> are
/// subscription GUIDs), <c>managementGroup</c> (<see cref="Ids"/> is one management group's name) or <c>all</c> (every
/// subscription the account can see; no ids).</summary>
public sealed record ArgScope(string Kind, IReadOnlyList<string> Ids)
{
    public const string Subscriptions = "subscriptions";
    public const string ManagementGroup = "managementGroup";
    public const string All = "all";

    /// <summary>What a scope's missing fields take: "all I can see".</summary>
    public static ArgScope Default { get; } = new(All, []);
}

/// <summary>A run's options beyond its text, for the server-side sources. <see cref="Timespan"/> is advanced hunting's: an
/// ISO 8601 duration (<c>P1D</c>, <c>P7D</c>, <c>P30D</c>) or an interval <c>start/end</c>. <see cref="Scope"/> is Azure Resource
/// Graph's. Null parts take the source's defaults (P30D; "all I can see"); Graph ignores both.</summary>
public sealed partial record QueryOptions(string? Timespan, ArgScope? Scope)
{
    /// <summary>Advanced hunting keeps 30 days of data.</summary>
    public static readonly TimeSpan MaxTimespan = TimeSpan.FromDays(30);

    public const int MaxSubscriptions = 100;

    /// <summary>What options with no parts set look like, for filling a partial one.</summary>
    public static QueryOptions Default { get; } = new(null, null);

    /// <summary>What is wrong with <paramref name="options"/>, as the user is told it, or null when nothing is (null options
    /// included). A timespan must parse and cover more than nothing and at most <see cref="MaxTimespan"/>; a scope must be one of
    /// the three kinds with its ids: 1 to <see cref="MaxSubscriptions"/> subscription GUIDs, one management group name, or none
    /// for <c>all</c>. Parts missing from the JSON arrive as null, whatever the types say.</summary>
    public static string? Problem(QueryOptions? options)
    {
        if (options is null)
        {
            return null;
        }

        if (options.Timespan is { } timespan)
        {
            if (Length(timespan) is not { } length || length <= TimeSpan.Zero)
            {
                return "The timespan must be an ISO 8601 duration such as P7D, or an interval start/end.";
            }

            if (length > MaxTimespan)
            {
                return "The timespan can cover at most 30 days.";
            }
        }

        return options.Scope is { } scope ? ScopeProblem(scope) : null;
    }

    /// <summary>How long <paramref name="timespan"/> is: a duration's length, or an interval's end minus its start. Null when it
    /// doesn't parse. Durations take weeks, days, hours, minutes and seconds; years and months have no fixed length and don't
    /// parse.</summary>
    public static TimeSpan? Length(string timespan)
    {
        var parts = timespan.Split('/');
        if (parts.Length == 2)
        {
            return Instant(parts[0]) is { } start && Instant(parts[1]) is { } end ? end - start : null;
        }

        var match = parts.Length == 1 ? Duration().Match(timespan) : Match.Empty;
        if (!match.Success || timespan == "P" || timespan.EndsWith('T'))
        {
            return null;
        }

        double Part(string name) => match.Groups[name].Success ? double.Parse(match.Groups[name].Value, CultureInfo.InvariantCulture) : 0;
        return TimeSpan.FromDays((Part("w") * 7) + Part("d")) + TimeSpan.FromHours(Part("h")) + TimeSpan.FromMinutes(Part("m"))
            + TimeSpan.FromSeconds(Part("s"));
    }

    private static DateTimeOffset? Instant(string value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var instant) ? instant : null;

    private static string? ScopeProblem(ArgScope scope)
    {
        if (scope.Ids is null || scope.Ids.Any(id => id is null))
        {
            return "The scope's ids are missing.";
        }

        switch (scope.Kind)
        {
            case ArgScope.Subscriptions:
                if (scope.Ids.Count is 0 or > MaxSubscriptions)
                {
                    return $"Pick 1 to {MaxSubscriptions} subscriptions.";
                }

                return scope.Ids.FirstOrDefault(id => !Guid.TryParseExact(id, "D", out _)) is { } bad
                    ? $"{bad} is not a subscription id."
                    : null;
            case ArgScope.ManagementGroup:
                if (scope.Ids.Count != 1)
                {
                    return "Pick one management group.";
                }

                return ManagementGroupName().IsMatch(scope.Ids[0]) ? null : $"{scope.Ids[0]} is not a management group name.";
            case ArgScope.All:
                return scope.Ids.Count == 0 ? null : "The scope \"all I can see\" names no subscriptions or management groups.";
            default:
                return "The scope must be subscriptions, a management group or all I can see.";
        }
    }

    [GeneratedRegex(@"^P(?:(?<w>[0-9]{1,6})W|(?:(?<d>[0-9]{1,6})D)?(?:T(?:(?<h>[0-9]{1,6})H)?(?:(?<m>[0-9]{1,6})M)?(?:(?<s>[0-9]{1,6}(?:\.[0-9]{1,7})?)S)?)?)\z", RegexOptions.CultureInvariant)]
    private static partial Regex Duration();

    [GeneratedRegex(@"^[A-Za-z0-9_.()-]{1,90}\z", RegexOptions.CultureInvariant)]
    private static partial Regex ManagementGroupName();
}
