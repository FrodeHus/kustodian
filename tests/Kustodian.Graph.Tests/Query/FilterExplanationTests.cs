using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;
using Kusto.Language;

namespace Kustodian.Graph.Tests;

public sealed class FilterExplanationTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 0, 0, 0, TimeSpan.Zero);

    private static readonly IReadOnlyList<GraphColumn> Columns =
    [
        new("id", "string", "", ["eq", "in"], false, null),
        new("appId", "string", "", ["eq", "in"], false, null),
        new("displayName", "string", "", ["eq", "ne", "not", "ge", "le", "in", "startsWith"], false, null),
        new("createdDateTime", "datetime", "", ["eq", "ne", "not", "ge", "le", "gt", "lt", "in"], false, null),
        new("accountEnabled", "bool", "", ["eq", "ne"], false, null),
        new("keyCount", "long", "", ["eq", "ne", "gt", "ge", "lt", "le", "in"], false, null),
        new("weight", "real", "", ["eq", "gt"], false, null),
        new("onPremisesPublishing", "dynamic", "", ["eq"], false, "microsoft.graph.onPremisesPublishing"),
    ];

    private static readonly GraphTable Applications =
        new("applications", "applications", "microsoft.graph.application", "", "", Columns, DirectoryObject: true);

    private static readonly GraphTable Incidents = new("security_incidents", "security/incidents", "microsoft.graph.security.incident", "", "", Columns);

    private static readonly GraphSchema Schema = new("test", DateTimeOffset.UnixEpoch, [Applications, Incidents],
        new Dictionary<string, IReadOnlyList<GraphField>>
        {
            ["microsoft.graph.onPremisesPublishing"] = [new("externalAuthenticationType", "string", false, null, "")],
        });

    private static (GraphTable Table, IReadOnlyList<Kusto.Language.Syntax.Expression> Predicates) Leading(string kql)
    {
        var code = KustoCode.ParseAndAnalyze(kql, GraphGlobals.Plain(Schema));
        Assert.DoesNotContain(code.GetDiagnostics(), d => d.Severity == DiagnosticSeverity.Error);
        var table = kql.StartsWith("security_incidents", StringComparison.Ordinal) ? Incidents : Applications;
        var symbol = code.Globals.Database.Tables.Single(t => t.Name == table.Name);
        var predicates = GraphQueryPlanner.LeadingPredicates(code, symbol);
        Assert.NotNull(predicates);
        return (table, predicates);
    }

    private static FilterExplanation Explain(string kql)
    {
        var (table, predicates) = Leading(kql);
        return GraphFilterTranslator.Explain(table, predicates, Now);
    }

    [Theory]
    [InlineData("applications | where displayName has 'x'", "displayName has 'x'", "Graph doesn't allow this operator on displayName")]
    [InlineData("applications | where weight < 2", "weight < 2", "Graph doesn't allow this operator on weight")]
    [InlineData("applications | where tolower(displayName) == 'x'", "tolower(displayName) == 'x'",
        "Graph can only compare a column with a fixed value")]
    [InlineData("applications | where onPremisesPublishing.externalAuthenticationType == 'passthru'",
        "onPremisesPublishing.externalAuthenticationType == 'passthru'", "Graph can only compare a column with a fixed value")]
    [InlineData("applications | where appId == displayName", "appId == displayName", "Graph can only compare a column with a fixed value")]
    [InlineData("applications | where appId in (displayName)", "appId in (displayName)", "Graph can only compare a column with a fixed value")]
    [InlineData("security_incidents | where isnull(tolower(displayName))", "isnull(tolower(displayName))",
        "Graph can only compare a column with a fixed value")]
    [InlineData("applications | where createdDateTime == datetime(2026-01-01 10:00:00.5)", "createdDateTime == datetime(2026-01-01 10:00:00.5)",
        "Graph can't compare this value exactly")]
    [InlineData("applications | where createdDateTime in (datetime(2026-01-01 10:00:00.5))", "createdDateTime in (datetime(2026-01-01 10:00:00.5))",
        "Graph can't compare this value exactly")]    [InlineData("security_incidents | where displayName =~ 'x'", "displayName =~ 'x'",
        "Case-insensitive comparison only goes to Graph for directory objects")]
    [InlineData("security_incidents | where appId in~ ('a')", "appId in~ ('a')",
        "Case-insensitive comparison only goes to Graph for directory objects")]
    [InlineData("security_incidents | where displayName startswith 'x'", "displayName startswith 'x'",
        "Case-insensitive comparison only goes to Graph for directory objects")]
    [InlineData("applications | where keyCount != 3", "keyCount != 3", "Graph needs advanced queries for ne and null checks on directory objects")]
    [InlineData("applications | where isnull(displayName)", "isnull(displayName)",
        "Graph needs advanced queries for ne and null checks on directory objects")]
    [InlineData("applications | where displayName == ''", "displayName == ''", "Graph would drop rows for an empty string")]
    [InlineData("applications | where appId in ('a', '')", "appId in ('a', '')", "Graph would drop rows for an empty string")]
    [InlineData("security_incidents | where isnotnull(displayName)", "isnotnull(displayName)", "isnotnull on text isn't sent to Graph")]
    [InlineData("applications | where not(appId == 'a')", "not(appId == 'a')", "not() is never sent to Graph")]
    [InlineData("applications | where appId == 'a' or displayName has 'b'", "appId == 'a' or displayName has 'b'",
        "One side of this or can't be sent to Graph")]
    public void Keeps_a_condition_local_with_its_reason(string kql, string condition, string reason)
    {
        var explanation = Explain(kql);

        Assert.Null(explanation.Filter);
        Assert.Empty(explanation.Pushed);
        Assert.Equal(new LocalCondition(condition, reason), Assert.Single(explanation.Local));
    }

    [Fact]
    public void Splits_conjuncts_into_pushed_and_local()
    {
        var explanation = Explain("applications | where appId == 'a' and displayName has 'b'\n| where keyCount  >   3");

        Assert.Equal("appId eq 'a' and keyCount gt 3", explanation.Filter);
        Assert.Equal(["appId == 'a'", "keyCount > 3"], explanation.Pushed);
        Assert.Equal([new LocalCondition("displayName has 'b'", "Graph doesn't allow this operator on displayName")], explanation.Local);
    }

    [Fact]
    public void Explains_nothing_without_a_leading_where()
    {
        var explanation = Explain("applications | take 10 | where appId == 'a'");

        Assert.Null(explanation.Filter);
        Assert.Empty(explanation.Pushed);
        Assert.Empty(explanation.Local);
    }

    /// <summary><see cref="GraphFilterTranslator.Translate"/> is <see cref="GraphFilterTranslator.Explain"/>'s filter, and
    /// every conjunct is either pushed or kept with a reason. GraphFilterTranslatorTests covers what Translate returns.</summary>
    [Theory]
    [InlineData("applications | where displayName == 'Payroll'")]
    [InlineData("applications | where createdDateTime > datetime(2026-01-01)")]
    [InlineData("applications | where appId in~ ('a', \"b\")")]
    [InlineData("applications | where appId == 'a' or displayName startswith 'b'")]
    [InlineData("applications | where (appId == 'a' or keyCount > 3) and displayName has 'b'")]
    [InlineData("applications | where createdDateTime == datetime(2026-01-01 10:00:00.5)")]
    [InlineData("applications | where appId == displayName")]
    [InlineData("applications | where accountEnabled in (true)")]
    [InlineData("applications | where appId !in ('a')")]
    [InlineData("applications | where displayName !startswith 'a'")]
    [InlineData("security_incidents | where keyCount != 3 and isnull(displayName) and isnotnull(keyCount)")]
    [InlineData("security_incidents | where displayName != 'x'")]
    [InlineData("applications")]
    public void Translate_unchanged_by_explain_refactor(string kql)
    {
        var (table, predicates) = Leading(kql);

        var explanation = GraphFilterTranslator.Explain(table, predicates, Now);

        Assert.Equal(GraphFilterTranslator.Translate(table, predicates, Now), explanation.Filter);
        Assert.All(explanation.Local, l => Assert.False(string.IsNullOrEmpty(l.Reason)));
        Assert.Equal(explanation.Filter is null, explanation.Pushed.Count == 0);
    }
}
