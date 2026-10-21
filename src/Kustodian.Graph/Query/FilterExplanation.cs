namespace Kustodian.Graph.Query;

/// <summary>A condition of the query's <c>where</c> that runs locally, after the fetch, and why it isn't sent to Graph.</summary>
public sealed record LocalCondition(string Condition, string Reason);

/// <summary>What <see cref="GraphFilterTranslator.Explain"/> found for a table's leading <c>where</c> predicates:
/// <see cref="Filter"/> is the <c>$filter</c> sent (null when nothing is), <see cref="Pushed"/> the conditions it is made of
/// (as written in the query, one per top-level <c>and</c> conjunct) and <see cref="Local"/> the conditions left to run
/// locally, each with its reason (<see cref="PushdownReasons"/>).</summary>
public sealed record FilterExplanation(string? Filter, IReadOnlyList<string> Pushed, IReadOnlyList<LocalCondition> Local);

/// <summary>Why a condition isn't sent to Graph: one reason per pushdown rule (spec 7.4), shown as written.</summary>
public static class PushdownReasons
{
    public const string CaseInsensitive = "Case-insensitive comparison only goes to Graph for directory objects";
    public const string AdvancedQuery = "Graph needs advanced queries for ne and null checks on directory objects";
    /// <summary><c>!=</c> or <c>!~</c> on text off directory objects: Graph's <c>ne</c> may ignore case there, so it could
    /// drop rows that differ from the value only in case.</summary>
    public const string CaseFolded = "Graph would compare this ignoring case, which could drop rows";
    public const string EmptyString = "Graph would drop rows for an empty string";
    public const string IsNotNullOnText = "isnotnull on text isn't sent to Graph";
    public const string Not = "not() is never sent to Graph";
    public const string OrSide = "One side of this or can't be sent to Graph";
    public const string NotLeading = "Not part of a leading where";
    /// <summary>The right side isn't a literal (a column, a function), the left side isn't a plain column, or the condition
    /// isn't one the translator knows.</summary>
    public const string FixedValue = "Graph can only compare a column with a fixed value";
    /// <summary>A value Graph can't represent faithfully: an empty <c>in</c> list, a datetime <c>==</c> with sub-second
    /// precision.</summary>
    public const string Inexact = "Graph can't compare this value exactly";

    /// <summary>The operator isn't one Graph's <c>$filter</c> allows on <paramref name="column"/>, or the column's type
    /// can't be filtered on at all.</summary>
    public static string Operator(string column) => $"Graph doesn't allow this operator on {column}";
}
