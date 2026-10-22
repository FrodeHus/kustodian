using System.Text.Json;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Query;

namespace Kustodian.Graph.Run;

/// <summary>How a run ended.</summary>
public enum RunOutcome
{
    Ok,
    QueryError,
    Refused,
    NoPermission,
    Throttled,
    TooLarge,
    EngineTimeout,
    EngineMemory,
    SignInNeeded,
    ConsentNeeded,
    /// <summary>A table the query reads needs a license the tenant doesn't have: nothing was read.</summary>
    Unlicensed,
    Failed,
}

/// <summary>A column left out of the read because the tenant lacks <paramref name="License"/>, which the Learn page
/// <paramref name="Source"/> says it needs.</summary>
public sealed record LicenseLeftOut(string Column, string License, string Source);

/// <summary>What reading one relationship column did: the objects it was read for, those whose entries were cut off at
/// <paramref name="EntryCap"/>, those Graph refused (<paramref name="Refused"/>), the delegated <paramref name="Permissions"/>
/// the read needs, whether the table had too many objects for it (<paramref name="Capped"/>: nothing was read), and whether
/// a <c>where</c> ran locally, so every object was read. Failed and cached objects are in <see cref="TableFetch.PerObjectFailed"/>
/// and <see cref="TableFetch.PerObjectCached"/>.</summary>
public sealed record RelationshipFetch(string Column, int Objects, int Truncated, int EntryCap, int Refused,
    IReadOnlyList<string> Permissions, bool Capped, bool FilteredLocally);

/// <summary>What was fetched for one table, for the result's details: the requests sent (relative URLs), whether the table was
/// read without its filter after Graph refused it, the columns Graph won't list (<paramref name="Unreadable"/>) or refused for
/// permission (<paramref name="Denied"/>; their values are empty), the columns read one object at a time
/// (<paramref name="PerObject"/>), the objects whose such read failed, whether the table had too many objects for it, and how
/// many objects' values came from the cache.</summary>
public sealed record TableFetch(string Table, IReadOnlyList<string> Requests, bool Unfiltered, IReadOnlyList<string> Unreadable,
    IReadOnlyList<string> Denied, IReadOnlyList<string> PerObject, int PerObjectFailed, bool PerObjectCapped, int PerObjectCached)
{
    /// <summary>The columns left out after Graph refused the list for a license or feature the tenant lacks (their values are
    /// empty), and Graph's message.</summary>
    public IReadOnlyList<string> Unlicensed { get; init; } = [];
    public string? UnlicensedReason { get; init; }

    /// <summary>The relationship columns the query names, as read.</summary>
    public IReadOnlyList<RelationshipFetch> Relationships { get; init; } = [];

    /// <summary>The columns the query touches that weren't read because the tenant is known to lack their license (their values
    /// are empty).</summary>
    public IReadOnlyList<LicenseLeftOut> LicenseLeftOut { get; init; } = [];
}

/// <summary>A run's answer. <see cref="Message"/> is the text to show when the outcome isn't <see cref="RunOutcome.Ok"/>;
/// <see cref="Error"/> carries the position of a <see cref="RunOutcome.QueryError"/>. <see cref="RunId"/> names the run (its
/// progress events carry it too), and <see cref="Diagnostics"/> is its log (<see cref="RunDiagnostics"/>).</summary>
public sealed record RunResult(RunOutcome Outcome, string? Message, GraphQueryError? Error, IReadOnlyList<EngineColumn> Columns,
    IReadOnlyList<JsonElement[]> Rows, int Total, IReadOnlyList<TableFetch> Tables, TimeSpan Duration, int DroppedValues = 0)
{
    public string RunId { get; init; } = "";

    public IReadOnlyList<DiagnosticEntry> Diagnostics { get; init; } = [];
}
