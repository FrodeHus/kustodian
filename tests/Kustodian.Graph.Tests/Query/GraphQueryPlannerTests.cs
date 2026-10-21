using System.Globalization;
using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Tests;

public sealed class GraphQueryPlannerTests
{
    private static GraphQueryPlan Plan(string kql) =>
        GraphQueryPlanner.Plan(TestSchemas.WithServicePrincipals(), kql, DateTimeOffset.UnixEpoch);

    private static GraphFetch Fetch(GraphQueryPlan plan, string table) => plan.Fetches.Single(f => f.Table.Name == table);

    [Fact]
    public void Plan_parses_reals_and_timespans_under_comma_decimal_culture()
    {
        const string kql = "applications | where createdDateTime > ago(1.5d) | extend x = 0.5";
        var now = new DateTimeOffset(2026, 10, 20, 0, 0, 0, TimeSpan.Zero);
        var schema = GraphSchemaCatalog.Beta;
        var expected = GraphQueryPlanner.Plan(schema, kql, now);
        Assert.Null(expected.Error);
        Assert.Equal("createdDateTime ge 2026-10-18T12:00:00Z", Assert.Single(expected.Fetches).Filter);

        var culture = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("nb-NO");
        try
        {
            var plan = GraphQueryPlanner.Plan(schema, kql, now);

            Assert.Null(plan.Error);
            Assert.Equal(Assert.Single(expected.Fetches).Filter, Assert.Single(plan.Fetches).Filter);
        }
        finally
        {
            CultureInfo.CurrentCulture = culture;
        }
    }

    [Fact]
    public void Finds_tables_across_let_union_join_lookup()
    {
        var plan = Plan("""
            let apps = applications | project appId, displayName;
            let sps = servicePrincipals | project appId, accountEnabled;
            union (apps | join kind=leftouter sps on appId), (apps | lookup sps on appId), (applications | project appId)
            """);

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        Assert.Equal(["applications", "servicePrincipals"], plan.Fetches.Select(f => f.Table.Name).Order().ToArray());
    }

    [Fact]
    public void Selects_referenced_passed_through_and_join_key_columns()
    {
        var plan = Plan("applications | join (servicePrincipals | project appId, accountEnabled) on appId | project displayName");

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        Assert.Equal(["appId", "displayName", "id"], Fetch(plan, "applications").Select.Order().ToArray());
        Assert.Superset(new HashSet<string>(["appId", "accountEnabled", "id"]), Fetch(plan, "servicePrincipals").Select.ToHashSet());
    }

    [Fact]
    public void Columns_passed_through_a_join_are_selected()
    {
        var plan = Plan("applications | join (servicePrincipals | project appId, accountEnabled) on appId");

        Assert.Contains("createdDateTime", Fetch(plan, "applications").Select);
    }

    [Fact]
    public void Plans_against_the_embedded_schema()
    {
        var plan = GraphQueryPlanner.Plan(Kustodian.Graph.Schema.GraphSchemaCatalog.Beta,
            "applications | mv-expand c = passwordCredentials | join (servicePrincipals | project appId, accountEnabled) on appId | project displayName, c.endDateTime",
            DateTimeOffset.UnixEpoch);

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        Assert.Equal(["appId", "displayName", "id", "passwordCredentials"], Fetch(plan, "applications").Select.Order(StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void Columns_passed_through_a_union_are_selected()
    {
        var plan = Plan("union applications, servicePrincipals");

        Assert.All(plan.Fetches, f => Assert.Equal(f.Table.Columns.Count(c => c.Listable), f.Select.Count));
    }

    [Fact]
    public void A_query_without_project_selects_every_listable_column()
    {
        var plan = Plan("applications | take 5");

        var fetch = Fetch(plan, "applications");
        Assert.Equal(fetch.Table.Columns.Where(c => c.Listable).Select(c => c.Name), fetch.Select);
        Assert.DoesNotContain("getOnlyGroup", fetch.Select);
        Assert.Empty(fetch.Unreadable);
    }

    [Theory]
    [InlineData("applications | search \"x\"")]
    [InlineData("applications | extend b = pack_all()")]
    public void Columns_read_implicitly_leave_out_get_only_ones(string kql)
    {
        var fetch = Fetch(Plan(kql), "applications");

        Assert.DoesNotContain("getOnlyGroup", fetch.Select);
        Assert.DoesNotContain("getOnlyById", fetch.Select);
        Assert.Empty(fetch.Unreadable);
    }

    [Fact]
    public void A_named_get_only_column_is_left_out_and_reported_unreadable_up_front()
    {
        var plan = Plan("applications | project displayName, getOnlyGroup");

        var fetch = Fetch(plan, "applications");
        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        Assert.Equal(["displayName", "id"], fetch.Select.Order().ToArray());
        Assert.Equal(["getOnlyGroup"], fetch.Unreadable);
    }

    [Fact]
    public void Named_lists_the_columns_the_query_names_not_those_it_passes_through()
    {
        var named = Fetch(Plan("applications | where displayName startswith 'P' | extend x = getOnlyGroup"), "applications").Named;
        var passed = Fetch(Plan("applications | take 5"), "applications").Named;

        Assert.Equal(["displayName", "getOnlyGroup"], named.Order(StringComparer.Ordinal));
        Assert.Empty(passed);
    }

    [Fact]
    public void Groups_take_10_selects_no_get_only_column()
    {
        var plan = GraphQueryPlanner.Plan(Kustodian.Graph.Schema.GraphSchemaCatalog.Beta, "groups | take 10", DateTimeOffset.UnixEpoch);

        var fetch = Fetch(plan, "groups");
        var getOnly = fetch.Table.Columns.Where(c => !c.Listable).Select(c => c.Name).ToList();
        Assert.Contains("hideFromOutlookClients", getOnly);   // "Supported only on the Get group API (GET /groups/{ID})"
        Assert.Empty(fetch.Select.Intersect(getOnly));
        Assert.Empty(fetch.Unreadable);
    }

    [Fact]
    public void Users_selects_no_column_only_a_single_user_get_returns()
    {
        var fetch = Fetch(GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, "users", DateTimeOffset.UnixEpoch), "users");

        Assert.Contains("displayName", fetch.Select);
        Assert.Empty(fetch.Select.Intersect(GraphSchemaBuilderTests.UsersGetOnlyColumns));
        Assert.Empty(fetch.Unreadable);
    }

    [Fact]
    public void Users_projecting_about_me_reads_it_one_user_at_a_time()
    {
        var fetch = Fetch(GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, "users | project displayName, aboutMe", DateTimeOffset.UnixEpoch), "users");

        Assert.Equal(["displayName", "id"], fetch.Select.Order(StringComparer.Ordinal).ToArray());
        Assert.Equal(["aboutMe"], fetch.Unreadable);
        Assert.Contains("aboutMe", fetch.Named);
    }

    [Fact]
    public void Unknown_column_is_an_error_with_position()
    {
        var plan = Plan("applications | project nope");

        Assert.NotNull(plan.Error);
        Assert.Contains("nope", plan.Error.Message);
        Assert.Equal(1, plan.Error.Line);
        // "nope" starts at the 24th character (offset 23).
        Assert.Equal(24, plan.Error.Column);
        Assert.Empty(plan.Fetches);
        Assert.False(plan.CanRun);
    }

    [Fact]
    public void Error_position_counts_lines()
    {
        var plan = Plan("applications\r\n| project\n  nope");

        Assert.NotNull(plan.Error);
        Assert.Equal(3, plan.Error.Line);
        Assert.Equal(3, plan.Error.Column);
    }

    [Theory]
    [InlineData("externaldata (x:string) [@\"https://example.com/a.csv\"]")]
    [InlineData(".show tables")]
    [InlineData(".set-or-append T <| print 1")]
    [InlineData("applications | evaluate python(typeof(*), \"\")")]
    [InlineData("evaluate sql_request(\"x\", \"y\")")]
    public void Refuses_sandbox_escapes(string kql)
    {
        var plan = Plan(kql);

        Assert.NotNull(plan.Refusal);
        Assert.Empty(plan.Fetches);
        Assert.False(plan.CanRun);
    }

    [Theory]
    [InlineData("externaldata (x:string) [@\"https://example.com/a.csv\"]")]
    [InlineData(".show tables")]
    [InlineData(".set-or-append T <| print 1")]
    [InlineData("applications | evaluate python(typeof(*), \"\")")]
    [InlineData("evaluate sql_request(\"x\", \"y\")")]
    public void Refusal_without_a_schema_matches_the_plan(string kql)
    {
        Assert.Equal(Plan(kql).Refusal, GraphQueryPlanner.RefusalOf(kql));
    }

    [Theory]
    [InlineData("applications | evaluate bag_unpack(onPremisesPublishing)")]
    [InlineData("print now()")]
    [InlineData("nosuchtable | take 1")]
    public void No_refusal_without_a_schema_for_what_stays_inside(string kql)
    {
        Assert.Null(GraphQueryPlanner.RefusalOf(kql));
    }

    [Fact]
    public void Externaldata_refusal_says_why()
    {
        var plan = Plan("externaldata (x:string) [@\"https://example.com/a.csv\"]");

        Assert.Equal("externaldata isn't available in Graph query. Only Graph tables can be queried.", plan.Refusal);
    }

    [Theory]
    [InlineData("applications | project onPremisesPublishing | evaluate bag_unpack(onPremisesPublishing)")]
    [InlineData("applications | project displayName, appId | evaluate narrow()")]
    [InlineData("applications | project displayName, appId | evaluate pivot(displayName)")]
    public void Allows_reshaping_plugins(string kql)
    {
        var plan = Plan(kql);

        Assert.Null(plan.Refusal);
        Assert.Single(plan.Fetches);
    }

    [Fact]
    public void Self_join_fetches_once_without_filter()
    {
        var plan = Plan("""applications | where appId == "a" | join (applications | where displayName == "b") on id""");

        var fetch = Assert.Single(plan.Fetches);
        Assert.Null(fetch.Filter);
        Assert.Superset(new HashSet<string>(["appId", "displayName", "id"]), fetch.Select.ToHashSet());
    }

    [Fact]
    public void Print_only_query_has_no_fetches_and_can_run()
    {
        var plan = Plan("print 1");

        Assert.True(plan.CanRun);
        Assert.Empty(plan.Fetches);
    }

    [Theory]
    [InlineData("union app*")]
    [InlineData("table(\"applications\") | take 1")]
    [InlineData("database(\"graph\").applications | take 1")]
    public void Finds_tables_referenced_indirectly(string kql)
    {
        var plan = Plan(kql);

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        Assert.Equal("applications", Assert.Single(plan.Fetches).Table.Name);
    }

    [Fact]
    public void A_wildcard_union_fetches_every_table_it_matches()
    {
        var plan = Plan("union * | take 1");

        Assert.Equal(["applications", "security_incidents", "servicePrincipals"],
            plan.Fetches.Select(f => f.Table.Name).Order(StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void Leading_where_predicates_are_found_for_pushdown()
    {
        var predicates = Predicates("""applications | where appId == "a" | where displayName == "b" | project id""");

        Assert.Equal(["appId == \"a\"", "displayName == \"b\""], predicates!.Select(p => p.ToString().Trim()).ToArray());
    }

    [Theory]
    [InlineData("applications | take 5 | where appId == \"a\"")]
    [InlineData("union applications, servicePrincipals | where appId == \"a\"")]
    public void Only_a_where_directly_after_the_table_is_pushdown(string kql)
    {
        Assert.Empty(Predicates(kql)!);
    }

    [Theory]
    [InlineData("""applications | where appId == "a" | join (applications | where displayName == "b") on id""")]
    [InlineData("""applications | where appId == "a" | join (table("applications")) on id""")]
    public void A_table_used_twice_has_no_pushdown(string kql)
    {
        Assert.Null(Predicates(kql));
    }

    private static IReadOnlyList<Kusto.Language.Syntax.Expression>? Predicates(string kql)
    {
        var globals = GraphGlobals.Plain(TestSchemas.WithServicePrincipals());
        var code = Kusto.Language.KustoCode.ParseAndAnalyze(kql, globals);
        return GraphQueryPlanner.LeadingPredicates(code, globals.Database.GetTable("applications"));
    }

    [Theory]
    [InlineData("applications | project p = pack_all()")]
    [InlineData("applications | project x = column_ifexists(\"displayName\", \"\")")]
    [InlineData("applications | where * has \"x\" | project id")]
    [InlineData("applications | search \"x\" | count")]
    [InlineData("applications | evaluate narrow()")]
    [InlineData("applications | project p = bag_pack_columns(displayName) | extend q = pack_all()")]
    [InlineData("applications | fork (take 1) (project id)")]
    public void Implicit_column_use_selects_every_listable_column(string kql)
    {
        var plan = Plan(kql);

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        var fetch = Fetch(plan, "applications");
        Assert.Equal(fetch.Table.Columns.Count(c => c.Listable), fetch.Select.Count);
    }

    [Fact]
    public void More_than_one_result_statement_is_an_error()
    {
        var plan = Plan("applications | take 1; servicePrincipals | take 1");

        Assert.Equal("Graph query returns one result. Remove the extra statements.", plan.Error?.Message);
        Assert.Empty(plan.Fetches);
    }

    [Fact]
    public void Let_statements_before_the_result_are_fine()
    {
        var plan = Plan("let a = applications | project appId; let n = 1; a | take n");

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
    }

    [Theory]
    [InlineData("cluster(\"x\").database(\"y\").T")]
    [InlineData("database(\"y\").T")]
    [InlineData("applications | join (cluster(\"x\").database(\"graph\").applications) on id")]
    public void Other_clusters_and_databases_are_an_error(string kql)
    {
        var plan = Plan(kql);

        Assert.Equal("Only Microsoft Graph tables can be queried.", plan.Error?.Message);
        Assert.Empty(plan.Fetches);
    }
    [Theory]
    [InlineData("servicePrincipals | take 10", 10)]
    [InlineData("servicePrincipals | limit 10", 10)]
    [InlineData("servicePrincipals | where accountEnabled == true | take 10", 10)]
    [InlineData("servicePrincipals | where accountEnabled == true | where appId == 'a' | limit 3 | project displayName", 3)]
    [InlineData("servicePrincipals | take 2000", 2000)]
    public void A_take_after_only_pushed_filters_is_a_row_limit(string kql, int top)
    {
        var plan = Plan(kql);

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        Assert.Equal(top, Fetch(plan, "servicePrincipals").Top);
    }

    [Theory]
    [InlineData("servicePrincipals")]
    [InlineData("servicePrincipals | where displayName has 'x' | take 10")]
    [InlineData("servicePrincipals | where accountEnabled == true and displayName has 'x' | take 10")]
    [InlineData("servicePrincipals | where accountEnabled == true | where displayName has 'x' | take 10")]
    [InlineData("servicePrincipals | extend x = 1 | take 10")]
    [InlineData("servicePrincipals | project displayName | take 10")]
    [InlineData("servicePrincipals | sort by displayName | take 10")]
    [InlineData("servicePrincipals | top 10 by displayName")]
    [InlineData("servicePrincipals | summarize count() by appId | take 10")]
    [InlineData("servicePrincipals | mv-expand x = dynamic([1, 2]) | take 10")]
    [InlineData("servicePrincipals | take 0")]
    [InlineData("let n = 10; servicePrincipals | take n * 2")]
    [InlineData("union servicePrincipals, (servicePrincipals | where accountEnabled == true) | take 10")]
    [InlineData("servicePrincipals | join (servicePrincipals | take 10) on appId")]
    [InlineData("let sps = servicePrincipals; sps | take 10")]
    public void No_row_limit_when_anything_local_comes_before_the_take(string kql)
    {
        var plan = Plan(kql);

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        Assert.Null(Fetch(plan, "servicePrincipals").Top);
    }

    [Fact]
    public void A_take_inside_a_join_limits_only_that_side()
    {
        var plan = Plan("applications | join (servicePrincipals | take 5) on appId");

        Assert.True(plan.CanRun, plan.Error?.Message ?? plan.Refusal);
        Assert.Equal(5, Fetch(plan, "servicePrincipals").Top);
        Assert.Null(Fetch(plan, "applications").Top);
    }
}
