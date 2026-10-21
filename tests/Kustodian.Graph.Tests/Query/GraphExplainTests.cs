using Kustodian.Graph.Fetch;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;
using Kustodian.Graph.Schema;
using Kustodian.Graph.Tests.Run;

namespace Kustodian.Graph.Tests;

public sealed class GraphExplainTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 0, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly IReadOnlyList<GraphColumn> Columns =
    [
        new("id", "string", "", ["eq", "in"], false, null),
        new("appId", "string", "", ["eq", "in"], false, null),
        new("displayName", "string", "", ["eq", "ne", "not", "ge", "le", "in", "startsWith"], false, null),
        new("createdDateTime", "datetime", "", ["eq", "ne", "not", "ge", "le", "gt", "lt", "in"], false, null),
        new("keyCount", "long", "", ["eq", "ne", "gt", "ge", "lt", "le", "in"], false, null),
        new("onPremisesPublishing", "dynamic", "", [], false, "microsoft.graph.onPremisesPublishing", Listable: false),
    ];

    private static readonly GraphTable Applications =
        new("applications", "applications", "microsoft.graph.application", "", "https://learn.microsoft.com/graph/api/resources/application",
            Columns, DirectoryObject: true)
        {
            Permissions = ["Application.Read.All"],
        };

    private static readonly GraphTable Incidents =
        new("security_incidents", "security/incidents", "microsoft.graph.security.incident", "", "https://learn.microsoft.com/x", Columns);

    /// <summary>One shared instance: the planner's globals are cached per schema instance.</summary>
    private static readonly GraphSchema Schema = new("test", DateTimeOffset.UnixEpoch, [Applications, Incidents],
        new Dictionary<string, IReadOnlyList<GraphField>>
        {
            ["microsoft.graph.onPremisesPublishing"] = [new("externalAuthenticationType", "string", false, null, "")],
        });

    private static ExplainView Explain(string kql, GraphLimits? limits = null) =>
        GraphExplain.Explain(Schema, kql, Now, limits ?? GraphLimits.Default);

    [Theory]
    [InlineData("applications | where displayName == \"O'Brien\" and createdDateTime > ago(7d) | project displayName, appId")]
    [InlineData("security_incidents | where displayName == 'a b&c' or keyCount >= 3")]
    [InlineData("applications | take 5")]
    public async Task Explain_url_matches_what_reader_sends(string kql)
    {
        var graph = new FakeGraph();
        var plan = GraphQueryPlanner.Plan(Schema, kql, Now);
        var reader = graph.Reader(new GraphFetchBudget());
        var budget = new GraphFetchBudget();

        var read = await reader.ReadAsync("account", Assert.Single(plan.Fetches), budget.Lease(), refresh: false, Ct);
        var table = Assert.Single(Explain(kql).Tables);

        Assert.Equal(read.Requests[0], table.Url);
        Assert.True(graph.Requests.TryPeek(out var sent));
        Assert.Equal("/beta/" + Uri.UnescapeDataString(table.Url), sent);
    }

    [Theory]
    [InlineData("applications | where keyCount > 3 | where displayName has 'x'", "displayName has 'x'", "Graph doesn't allow this operator on displayName")]
    [InlineData("security_incidents | where keyCount > 3 | where displayName =~ 'x'", "displayName =~ 'x'",
        "Case-insensitive comparison only goes to Graph for directory objects")]
    [InlineData("applications | where keyCount > 3 | where keyCount != 3", "keyCount != 3", "Graph needs advanced queries for ne and null checks on directory objects")]
    [InlineData("applications | where keyCount > 3 | where displayName == ''", "displayName == ''", "Graph would drop rows for an empty string")]
    [InlineData("security_incidents | where keyCount > 3 | where isnotnull(displayName)", "isnotnull(displayName)", "isnotnull on text isn't sent to Graph")]
    [InlineData("applications | where keyCount > 3 | where not(appId == 'a')", "not(appId == 'a')", "not() is never sent to Graph")]
    [InlineData("applications | where keyCount > 3 | where appId == 'a' or displayName has 'b'", "appId == 'a' or displayName has 'b'",
        "One side of this or can't be sent to Graph")]
    [InlineData("applications | where keyCount > 3 | project displayName, appId | where appId == 'a'", "appId == 'a'", "Not part of a leading where")]
    public void Explain_lists_pushed_and_local_with_reason(string kql, string condition, string reason)
    {
        var table = Assert.Single(Explain(kql).Tables);

        Assert.Equal("keyCount gt 3", table.Filter);
        Assert.Equal(["keyCount > 3"], table.Pushed);
        Assert.Equal([new LocalCondition(condition, reason)], table.Local);
        Assert.Contains("$filter=" + Uri.EscapeDataString("keyCount gt 3"), table.Url, StringComparison.Ordinal);
    }

    [Fact]
    public void Explain_lists_later_wheres_after_the_leading_ones()
    {
        var table = Assert.Single(Explain("applications | where appId == 'a' | extend n = 1 | where displayName == 'b' | take 3 | where n > 0").Tables);

        Assert.Equal(["appId == 'a'"], table.Pushed);
        Assert.Equal([new LocalCondition("displayName == 'b'", "Not part of a leading where"), new LocalCondition("n > 0", "Not part of a leading where")],
            table.Local);
    }

    [Fact]
    public void Explain_keeps_every_where_of_a_self_join_local()
    {
        var table = Assert.Single(Explain("applications | where appId == 'a' | join (applications | where displayName == 'b') on id").Tables);

        Assert.Null(table.Filter);
        Assert.Empty(table.Pushed);
        Assert.Equal(["appId == 'a'", "displayName == 'b'"], table.Local.Select(l => l.Condition).Order(StringComparer.Ordinal));
        Assert.All(table.Local, l => Assert.Equal("Not part of a leading where", l.Reason));
    }

    [Fact]
    public void Explain_marks_per_object_columns()
    {
        var table = Assert.Single(Explain("applications | project displayName, onPremisesPublishing").Tables);

        Assert.Equal(["onPremisesPublishing"], table.PerObject);
        Assert.DoesNotContain("onPremisesPublishing", table.Select);
        Assert.DoesNotContain("onPremisesPublishing", table.Url, StringComparison.Ordinal);
    }

    [Fact]
    public void Explain_describes_each_table()
    {
        var view = Explain("applications | project displayName | union (security_incidents | project displayName)");

        Assert.Null(view.Error);
        Assert.Null(view.Refusal);
        Assert.Equal(["applications", "security_incidents"], view.Tables.Select(t => t.Table));
        var applications = view.Tables[0];
        Assert.Equal(["displayName", "id"], applications.Select);
        Assert.Equal("applications?$select=" + Uri.EscapeDataString("displayName,id") + "&$top=999", applications.Url);
        Assert.Equal(["Application.Read.All"], applications.Permissions);
        Assert.Equal("https://learn.microsoft.com/graph/api/resources/application", applications.DocsUrl);
        Assert.Empty(applications.PerObject);
        Assert.StartsWith("security/incidents?$select=", view.Tables[1].Url, StringComparison.Ordinal);
    }

    [Fact]
    public void Explain_returns_error_with_position()
    {
        var view = Explain("applications\n| where nope == 1");

        Assert.Equal(2, view.Error?.Line);
        Assert.Equal(9, view.Error?.Column);
        Assert.Null(view.Refusal);
        Assert.Empty(view.Tables);
    }

    [Fact]
    public void Explain_returns_the_refusal()
    {
        var view = Explain("applications | evaluate python(typeof(*), 'x')");

        Assert.Null(view.Error);
        Assert.NotNull(view.Refusal);
        Assert.Empty(view.Tables);
    }

    [Fact]
    public void Explain_names_the_limits()
    {
        var limits = new GraphLimits { ObjectsPerTable = 1234, FetchBudgetBytes = 256L << 20, PerObjectReadsPerTable = 77 };

        Assert.Equal(new ExplainLimits(1234, 256, 77), Explain("applications", limits).Limits);
        Assert.Equal(new ExplainLimits(1234, 256, 77), Explain("nope", limits).Limits);
    }

    [Fact]
    public void Explain_substitutes_parameters()
    {
        var table = Assert.Single(GraphExplain.Explain(Schema, "applications | where appId == {app}",
            [new ParameterValue("app", "text", "a'b", true)], Now, GraphLimits.Default).Tables);

        Assert.Equal("appId eq 'a''b'", table.Filter);
    }

    [Fact]
    public void Explain_maps_an_error_back_to_the_query_as_written()
    {
        var view = GraphExplain.Explain(Schema, "applications | where appId == {app}\n| where nope == 1",
            [new ParameterValue("app", "text", "a long value", true)], Now, GraphLimits.Default);

        Assert.Equal(2, view.Error?.Line);
        Assert.Equal(9, view.Error?.Column);
    }

    [Fact]
    public void Explain_says_which_parameter_is_missing()
    {
        var view = GraphExplain.Explain(Schema, "applications | where appId == {app}", [new ParameterValue("app", "text", " ", true)], Now,
            GraphLimits.Default);

        Assert.Equal(new GraphQueryError(0, 0, "Fill in app to explain this query."), view.Error);
        Assert.Empty(view.Tables);
    }

    [Fact]
    public void Explain_says_which_parameter_is_invalid()
    {
        var view = GraphExplain.Explain(Schema, "applications | where keyCount == {n}", [new ParameterValue("n", "number", "x", true)], Now,
            GraphLimits.Default);

        Assert.Equal(0, view.Error?.Line);
        Assert.Contains("n", view.Error?.Message, StringComparison.Ordinal);
        Assert.Empty(view.Tables);
    }
}
