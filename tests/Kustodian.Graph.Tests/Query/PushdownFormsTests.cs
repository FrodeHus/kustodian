using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

/// <summary>The second round of pushdown forms (count, sort and take, nested properties, lambdas, endswith, between,
/// isnotempty, tolower), planned against the bundled beta schema.</summary>
public sealed class PushdownFormsTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 0, 0, 0, TimeSpan.Zero);

    /// <summary>A table that isn't a directory object, with columns that allow every operator.</summary>
    private static readonly GraphTable Alerts = new("testAlerts", "test/alerts", "microsoft.graph.test.alert", "", "",
    [
        new("id", "string", "", ["eq"], false, null),
        new("summary", "string", "", ["eq", "ne", "startsWith", "endsWith"], false, null),
        new("createdDateTime", "datetime", "", ["eq", "ne", "ge", "le", "gt", "lt"], false, null),
        new("tags", "dynamic", "", ["eq"], false, null, Collection: true),
    ]);

    private static readonly GraphSchema Schema = GraphSchemaCatalog.Beta with { Tables = [.. GraphSchemaCatalog.Beta.Tables, Alerts] };

    private static GraphFetch Fetch(string kql)
    {
        var plan = GraphQueryPlanner.Plan(Schema, kql, Now);
        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        return Assert.Single(plan.Fetches);
    }

    private static FilterExplanation Explained(string kql)
    {
        var explained = GraphQueryPlanner.PlanExplained(Schema, kql, Now);
        Assert.True(explained.Plan.CanRun, explained.Plan.Error?.Message ?? explained.Plan.Refusal);
        return Assert.Single(explained.Filters);
    }

    private static string Reason(string kql) => Assert.Single(Explained(kql).Local).Reason;

    // between: both bounds, inclusive; datetimes widen to the second.
    [Theory]
    [InlineData("users | where createdDateTime between (datetime(2026-01-01) .. datetime(2026-02-01))",
        "createdDateTime ge 2026-01-01T00:00:00Z and createdDateTime le 2026-02-01T00:00:00Z")]
    [InlineData("users | where createdDateTime between (datetime(2026-01-01 00:00:00.5) .. ago(1d))",
        "createdDateTime ge 2026-01-01T00:00:00Z and createdDateTime le 2026-10-19T00:00:00Z")]
    [InlineData("testAlerts | where createdDateTime between (ago(7d) .. now())",
        "createdDateTime ge 2026-10-13T00:00:00Z and createdDateTime le 2026-10-20T00:00:00Z")]
    public void Between_is_sent_as_ge_and_le(string kql, string filter)
    {
        var fetch = Fetch(kql);

        Assert.Equal(filter, fetch.Filter);
        Assert.Null(Assert.Single(fetch.Clauses).Feature);
    }

    [Theory]
    [InlineData("users | where createdDateTime !between (datetime(2026-01-01) .. datetime(2026-02-01))")]
    [InlineData("users | where createdDateTime between (datetime(2026-01-01) .. 1d)")]
    public void Between_is_not_sent_otherwise(string kql) => Assert.Null(Fetch(kql).Filter);

    // endswith: directory objects only, on the four properties Microsoft documents, in advanced query mode.
    [Theory]
    [InlineData("users | where mail endswith '@contoso.com'", "endswith(mail,'@contoso.com')", "endswith(mail)")]
    [InlineData("users | where userPrincipalName endswith_cs '@contoso.com'", "endswith(userPrincipalName,'@contoso.com')",
        "endswith(userPrincipalName)")]
    public void Endswith_is_sent_on_directory_objects_in_advanced_mode(string kql, string filter, string feature)
    {
        var clause = Assert.Single(Fetch(kql).Clauses);

        Assert.Equal(new FilterClause(filter, feature, Advanced: true), clause);
    }

    [Fact]
    public void Endswith_is_not_sent_where_it_is_not_documented()
    {
        Assert.Equal(PushdownReasons.Operator("displayName"), Reason("users | where displayName endswith 'x'"));
        Assert.Equal(PushdownReasons.DirectoryOnly, Reason("testAlerts | where summary endswith 'x'"));
        Assert.Equal(PushdownReasons.EmptyString, Reason("users | where mail endswith ''"));
    }

    // isnotempty: ne null keeps every row with a value. On directory objects ne needs advanced query mode.
    [Fact]
    public void Isnotempty_is_sent_as_ne_null()
    {
        Assert.Equal(new FilterClause("mail ne null", "mail ne null", Advanced: true), Assert.Single(Fetch("users | where isnotempty(mail)").Clauses));
        Assert.Equal(new FilterClause("summary ne null"), Assert.Single(Fetch("testAlerts | where isnotempty(summary)").Clauses));
    }

    [Fact]
    public void Isnotempty_is_not_sent_without_ne_or_on_an_array()
    {
        Assert.Equal(PushdownReasons.Operator("tags"), Reason("testAlerts | where isnotempty(tags)"));
        Assert.Equal(PushdownReasons.Operator("id"), Reason("testAlerts | where isnotempty(id)"));
    }

    // tolower/toupper ==: Graph's eq ignores case on directory objects.
    [Theory]
    [InlineData("users | where tolower(displayName) == 'adele'", "displayName eq 'adele'")]
    [InlineData("users | where toupper(mail) == 'ADELE@CONTOSO.COM'", "mail eq 'ADELE@CONTOSO.COM'")]
    [InlineData("users | where tolower(displayName) =~ 'Adele'", "displayName eq 'Adele'")]
    public void Folded_equality_is_sent_as_eq_on_directory_objects(string kql, string filter) => Assert.Equal(filter, Fetch(kql).Filter);

    [Theory]
    [InlineData("users | where tolower(displayName) startswith 'a'")]
    [InlineData("users | where tolower(displayName) != 'a'")]
    [InlineData("testAlerts | where tolower(summary) == 'a'")]
    [InlineData("users | where tolower(displayName) in ('a', 'b')")]
    public void Folded_comparisons_are_not_sent_otherwise(string kql) => Assert.Equal(PushdownReasons.Folded, Reason(kql));

    // Nested properties: Graph documents $filter on signInActivity, and only alone.
    [Theory]
    [InlineData("users | where todatetime(signInActivity.lastSignInDateTime) < ago(90d)", "signInActivity/lastSignInDateTime le 2026-07-22T00:00:00Z")]
    [InlineData("users | where signInActivity.lastSignInRequestId == 'r1'", "signInActivity/lastSignInRequestId eq 'r1'")]
    [InlineData("users | where todatetime(signInActivity.lastSignInDateTime) <= datetime(2026-01-01)",
        "signInActivity/lastSignInDateTime le 2026-01-01T00:00:00Z")]
    [InlineData("users | where todatetime(signInActivity.lastSuccessfulSignInDateTime) between (datetime(2026-01-01) .. datetime(2026-02-01))",
        "signInActivity/lastSuccessfulSignInDateTime ge 2026-01-01T00:00:00Z and signInActivity/lastSuccessfulSignInDateTime le 2026-02-01T00:00:00Z")]
    public void Nested_properties_are_sent_as_paths(string kql, string filter)
    {
        var clause = Assert.Single(Fetch(kql).Clauses);

        Assert.Equal(filter, clause.OData);
        Assert.StartsWith("signInActivity/", clause.Feature, StringComparison.Ordinal);
        Assert.False(clause.Advanced);
    }

    [Fact]
    public void A_column_graph_filters_only_alone_keeps_the_other_conditions_local()
    {
        var explained = Explained("users | where accountEnabled == true and todatetime(signInActivity.lastSignInDateTime) < ago(90d) | where mail endswith 'x'");

        Assert.Equal("signInActivity/lastSignInDateTime le 2026-07-22T00:00:00Z", explained.Filter);
        Assert.Equal([PushdownReasons.Alone("signInActivity"), PushdownReasons.Alone("signInActivity")], explained.Local.Select(l => l.Reason));
        Assert.Equal(["accountEnabled == true", "mail endswith 'x'"], explained.Local.Select(l => l.Condition));
    }

    [Theory]
    // A conversion that could change the value, an operator Graph doesn't document on the column, a column without $filter.
    [InlineData("users | where toint(signInActivity.lastSignInDateTime) == 1")]
    [InlineData("users | where tostring(signInActivity.lastSignInRequestId) startswith 'x'")]
    [InlineData("users | where tostring(mailboxSettings.timeZone) == 'x'")]
    [InlineData("users | where todatetime(signInActivity.lastSignInDateTime) < todatetime(signInActivity.lastNonInteractiveSignInDateTime)")]
    public void Nested_properties_are_not_sent_otherwise(string kql) => Assert.Null(Fetch(kql).Filter);

    // Lambdas: set_has_element is element equality; Graph's eq keeps at least those elements.
    [Theory]
    [InlineData("users | where set_has_element(proxyAddresses, 'SMTP:adele@contoso.com')", "users", "proxyAddresses/any(p:p eq 'SMTP:adele@contoso.com')")]
    [InlineData("groups | where set_has_element(proxyAddresses, \"smtp:it@contoso.com\")", "groups", "proxyAddresses/any(p:p eq 'smtp:it@contoso.com')")]
    [InlineData("servicePrincipals | where set_has_element(tags, 'WindowsAzureActiveDirectoryIntegratedApp')", "servicePrincipals",
        "tags/any(p:p eq 'WindowsAzureActiveDirectoryIntegratedApp')")]
    public void Set_has_element_is_sent_as_any(string kql, string table, string filter)
    {
        var clause = Assert.Single(Fetch(kql).Clauses);

        Assert.Equal(new FilterClause(filter, filter[..filter.IndexOf('(', StringComparison.Ordinal)], Advanced: true), clause);
        Assert.Equal(table, Fetch(kql).Table.Name);
    }

    [Fact]
    public void Words_in_an_array_are_not_element_equality()
    {
        Assert.Equal(PushdownReasons.WordsInArray, Reason("users | where proxyAddresses has 'adele@contoso.com'"));
        Assert.Equal(PushdownReasons.WordsInArray, Reason("users | where assignedLicenses has '6fd2c87f-b296-42f0-b197-1e91e994b900'"));
        Assert.Equal(PushdownReasons.WordsInArray, Reason("users | where proxyAddresses contains 'contoso'"));
    }

    [Fact]
    public void Set_has_element_is_not_sent_otherwise()
    {
        Assert.Equal(PushdownReasons.DirectoryOnly, Reason("testAlerts | where set_has_element(tags, 'x')"));
        Assert.Equal(PushdownReasons.Operator("assignedLicenses"), Reason("users | where set_has_element(assignedLicenses, 'x')"));
        Assert.Equal(PushdownReasons.EmptyString, Reason("users | where set_has_element(proxyAddresses, '')"));
        Assert.Equal(PushdownReasons.FixedValue, Reason("users | where set_has_element(proxyAddresses, mail)"));
    }

    // count: the whole query is a count over pushed filters that Graph keeps exactly.
    [Theory]
    [InlineData("users | count", "Count")]
    [InlineData("users | where accountEnabled == true | count", "Count")]
    [InlineData("users | where createdDateTime >= datetime(2026-01-01) | summarize count()", "count_")]
    [InlineData("users | where displayName =~ 'adele' | summarize n = count()", "n")]
    [InlineData("users | where mail endswith '@contoso.com' | count", "Count")]
    [InlineData("testAlerts | count", "Count")]
    public void A_count_over_exact_pushed_filters_is_counted_by_graph(string kql, string column) => Assert.Equal(column, Fetch(kql).Count);

    [Theory]
    // Graph's eq ignores case where == doesn't, and a strict datetime bound is sent inclusive: not exact.
    [InlineData("users | where displayName == 'Adele' | count")]
    [InlineData("users | where createdDateTime > datetime(2026-01-01) | count")]
    [InlineData("users | where set_has_element(proxyAddresses, 'x') | count")]
    [InlineData("users | where isnotempty(mail) | count")]
    // Something runs locally, or the count isn't the answer.
    [InlineData("users | where displayName has 'a' | count")]
    [InlineData("users | extend x = 1 | count")]
    [InlineData("users | count | extend x = 1")]
    [InlineData("users | summarize count() by department")]
    [InlineData("users | summarize count(), dcount(department)")]
    [InlineData("users | summarize countif(accountEnabled)")]
    [InlineData("users | take 5 | count")]
    [InlineData("users | count as n")]
    public void No_count_when_graph_might_not_count_the_same_rows(string kql) => Assert.Null(Fetch(kql).Count);

    [Fact]
    public void No_count_when_another_table_is_read()
    {
        var plan = GraphQueryPlanner.Plan(Schema, "users | join kind=leftsemi (groups) on $left.id == $right.id | count", Now);

        Assert.All(plan.Fetches, f => Assert.Null(f.Count));
    }

    // sort and take, and top: the order goes to Graph with the row limit.
    [Theory]
    [InlineData("users | sort by createdDateTime desc | take 5", "createdDateTime desc", 5)]
    [InlineData("users | sort by createdDateTime | take 5", "createdDateTime desc", 5)]
    [InlineData("users | order by createdDateTime asc nulls last | limit 3", "createdDateTime asc", 3)]
    [InlineData("users | where accountEnabled == true | top 10 by createdDateTime", "createdDateTime desc", 10)]
    [InlineData("users | top 10 by createdDateTime desc nulls last | project displayName", "createdDateTime desc", 10)]
    [InlineData("auditLogs_signIns | top 20 by createdDateTime", "createdDateTime desc", 20)]
    public void A_sort_then_take_is_sent_as_orderby_and_top(string kql, string orderBy, int top)
    {
        var fetch = Fetch(kql);

        Assert.Equal(orderBy, fetch.OrderBy?.OData);
        Assert.Equal(top, fetch.Top);
    }

    [Theory]
    // KQL puts nulls first when ascending; text sorts differently in Graph; more than one column.
    [InlineData("users | sort by createdDateTime asc | take 5")]
    [InlineData("users | top 5 by createdDateTime desc nulls first")]
    [InlineData("users | sort by displayName desc | take 5")]
    [InlineData("users | sort by createdDateTime desc, displayName asc | take 5")]
    [InlineData("users | sort by createdDateTime desc")]
    [InlineData("users | top 5 by datetime_add('day', 1, createdDateTime)")]
    // Something runs locally before the sort.
    [InlineData("users | where displayName has 'a' | sort by createdDateTime desc | take 5")]
    [InlineData("users | sort by createdDateTime desc | where accountEnabled == true | take 5")]
    [InlineData("users | extend x = 1 | top 5 by createdDateTime")]
    public void No_orderby_when_graph_might_order_differently(string kql)
    {
        var fetch = Fetch(kql);

        Assert.Null(fetch.OrderBy);
        Assert.Null(fetch.Top);
    }
}
