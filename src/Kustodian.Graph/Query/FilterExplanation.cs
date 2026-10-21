namespace Kustodian.Graph.Query;

/// <summary>A condition of the query's <c>where</c> that runs locally, after the fetch, and why it isn't sent to Graph.</summary>
public sealed record LocalCondition(string Condition, string Reason);

/// <summary>One top-level <c>and</c> conjunct sent in <c>$filter</c>, as OData. <see cref="Feature"/> names what it uses that a
/// table may refuse (an <c>endswith</c>, a lambda, a nested property, a null check in advanced query mode): when Graph refuses
/// the filter, the clauses with a feature are left out first, and the refusal is remembered per account and table under that
/// name. Null for the forms every table that documents the operator takes. <see cref="Advanced"/>: it needs Graph's advanced
/// query mode on directory objects (the <c>ConsistencyLevel: eventual</c> header and <c>$count=true</c>).</summary>
public sealed record FilterClause(string OData, string? Feature = null, bool Advanced = false);

/// <summary>What <see cref="GraphFilterTranslator.Explain"/> found for a table's leading <c>where</c> predicates:
/// <see cref="Filter"/> is the <c>$filter</c> sent (null when nothing is), <see cref="Pushed"/> the conditions it is made of
/// (as written in the query, one per top-level <c>and</c> conjunct) and <see cref="Local"/> the conditions left to run
/// locally, each with its reason (<see cref="PushdownReasons"/>). <see cref="Clauses"/> are the pushed conjuncts as OData, in
/// the same order as <see cref="Pushed"/>. <see cref="Exact"/>: every condition was pushed and Graph keeps exactly the rows the
/// KQL keeps (no case folding, no widened bound), so a count of Graph's rows is the query's count.</summary>
public sealed record FilterExplanation(string? Filter, IReadOnlyList<string> Pushed, IReadOnlyList<LocalCondition> Local)
{
    public IReadOnlyList<FilterClause> Clauses { get; init; } = [];
    public bool Exact { get; init; }
}

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
    /// <summary><c>has</c>, <c>contains</c> and the like on an array: they match words in the array's JSON text (a GUID inside
    /// another field, part of an address), not whole elements, so no lambda keeps every row they keep.</summary>
    public const string WordsInArray = "has and contains match words in the array's text, not whole elements, so Graph can't filter on them";
    /// <summary><c>tolower()</c> or <c>toupper()</c> compared otherwise than with <c>==</c> or <c>=~</c>, or off directory
    /// objects (where Graph's <c>eq</c> isn't known to ignore case).</summary>
    public const string Folded = "tolower() and toupper() only go to Graph with == or =~, on directory objects";
    /// <summary><c>endswith</c> and lambdas off directory objects: Microsoft documents them only there.</summary>
    public const string DirectoryOnly = "Graph only filters this way on directory objects";

    /// <summary>The operator isn't one Graph's <c>$filter</c> allows on <paramref name="column"/>, or the column's type
    /// can't be filtered on at all.</summary>
    public static string Operator(string column) => $"Graph doesn't allow this operator on {column}";

    /// <summary>Graph filters on <paramref name="column"/> (users' <c>signInActivity</c>) only with no other property in the
    /// same <c>$filter</c>: the conditions on it are sent, the others run locally.</summary>
    public static string Alone(string column) => $"Graph filters on {column} only on its own, so this runs locally";
}
