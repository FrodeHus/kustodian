using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Schema;

namespace Kustodian.Engine.Tests;

public sealed class EngineHandlerTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 0, 0, 0, TimeSpan.Zero);

    private static EngineResponse Run(string kql, DateTimeOffset? now = null, int maxRows = 10_000, params EngineTable[] tables) =>
        EngineHandler.Handle(new EngineRequest(kql, now ?? Now, tables, maxRows));

    private static EngineResponse RunOnFixtures(string kql) =>
        Run(kql, tables: [EngineTables.FromFixture("applications"), EngineTables.FromFixture("servicePrincipals")]);

    private static void AssertRan(EngineResponse response)
    {
        Assert.True(response.Refusal is null, response.Refusal);
        Assert.True(response.Error is null, response.Error);
        Assert.NotNull(response.Columns);
        Assert.NotNull(response.Rows);
    }

    private static string?[] Strings(JsonElement element) =>
        element.ValueKind == JsonValueKind.Null ? [] : element.EnumerateArray().Select(e => e.GetString()).ToArray();

    [Fact]
    public void Expired_credentials_or_passthru_returns_the_three_apps()
    {
        var response = RunOnFixtures("""
            let expiredCreds = union
                    (applications | mv-expand c = passwordCredentials | extend credType = "secret"),
                    (applications | mv-expand c = keyCredentials | extend credType = "certificate")
                | where todatetime(c.endDateTime) < now()
                | summarize expired = count(), kinds = make_set(credType) by appId;
            applications
            | join kind=leftouter expiredCreds on appId
            | extend expired = coalesce(expired, 0), passthru = tostring(onPremisesPublishing.externalAuthenticationType) == "passthru"
            | where expired > 0 or passthru
            | project displayName, appId, expired, kinds, passthru
            | order by displayName asc
            """);

        AssertRan(response);
        Assert.Equal(["displayName", "appId", "expired", "kinds", "passthru"], response.Columns!.Select(c => c.Name));
        Assert.Equal(["string", "string", "long", "dynamic", "bool"], response.Columns!.Select(c => c.Type));
        Assert.Equal(3, response.Total);
        var rows = response.Rows!;
        Assert.Equal(3, rows.Count);

        Assert.Equal("CI Deployer", rows[0][0].GetString());
        Assert.Equal(2, rows[0][2].GetInt64());
        Assert.Equal(["secret", "certificate"], Strings(rows[0][3]));
        Assert.False(rows[0][4].GetBoolean());

        Assert.Equal("Legacy Intranet (App Proxy)", rows[1][0].GetString());
        Assert.Equal(0, rows[1][2].GetInt64());
        Assert.Equal(JsonValueKind.Null, rows[1][3].ValueKind);
        Assert.True(rows[1][4].GetBoolean());

        Assert.Equal("Payroll Portal", rows[2][0].GetString());
        Assert.Equal(1, rows[2][2].GetInt64());
        Assert.Equal(["secret"], Strings(rows[2][3]));
        Assert.False(rows[2][4].GetBoolean());
    }

    [Fact]
    public void Join_with_service_principals_counts_per_audience()
    {
        var response = RunOnFixtures("""
            applications
            | join kind=leftouter (servicePrincipals | project appId, spEnabled = accountEnabled, spType = servicePrincipalType) on appId
            | summarize apps = count(), withoutSp = countif(isempty(appId1)) by signInAudience
            """);

        AssertRan(response);
        var rows = response.Rows!
            .Select(r => $"{r[0].GetString()} {r[1].GetInt64()} {r[2].GetInt64()}")
            .Order(StringComparer.Ordinal)
            .ToList();
        Assert.Equal(["AzureADMultipleOrgs 1 0", "AzureADMyOrg 4 1", "AzureADandPersonalMicrosoftAccount 1 1"], rows);
    }

    [Fact]
    public void Now_comes_from_the_request()
    {
        var response = Run("print now()", new DateTimeOffset(2026, 10, 20, 8, 0, 0, TimeSpan.Zero));

        AssertRan(response);
        Assert.Equal("datetime", response.Columns![0].Type);
        Assert.Equal("2026-10-20T08:00:00.0000000Z", response.Rows![0][0].GetString());
    }

    [Fact]
    public void Now_ago_and_now_with_an_offset_all_use_the_request_time()
    {
        var response = Run("print a = ago(1d), b = now(1h), c = now() - 1d", new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero));

        AssertRan(response);
        Assert.Equal("2019-12-31T00:00:00.0000000Z", response.Rows![0][0].GetString());
        Assert.Equal("2020-01-01T01:00:00.0000000Z", response.Rows![0][1].GetString());
        Assert.Equal("2019-12-31T00:00:00.0000000Z", response.Rows![0][2].GetString());
    }

    [Fact]
    public void A_row_just_before_a_pushed_now_bound_is_kept()
    {
        // The planner pushed `createdDateTime lt <now>` with the run's now; the engine has to compare with the same instant,
        // not its own later clock, or rows fetched near the bound would disagree.
        var now = new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var table = Applications(
            ("just before", "2019-12-31T23:59:59Z"),
            ("just after", "2020-01-01T00:00:01Z"),
            ("two days ago", "2019-12-30T00:00:00Z"));

        var response = Run("applications | where createdDateTime < now() and createdDateTime > ago(1d) | project displayName", now, tables: table);

        AssertRan(response);
        Assert.Equal(["just before"], response.Rows!.Select(r => r[0].GetString()));
    }

    [Fact]
    public void Now_in_strings_and_comments_is_left_alone_and_inside_functions_is_pinned()
    {
        var response = Run("""
            let f = () { ago(now() - datetime(2019-12-31)) };
            print s = "now() and ago(1d)", d = f() // now()
            """, new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero));

        AssertRan(response);
        Assert.Equal("now() and ago(1d)", response.Rows![0][0].GetString());
        Assert.Equal("2019-12-31T00:00:00.0000000Z", response.Rows![0][1].GetString());
    }

    [Fact]
    public void Literals_are_read_invariantly_in_a_comma_decimal_culture()
    {
        var before = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("nb-NO");
        try
        {
            var response = Run("print x = 1.5 * 2, t = 1.5d");

            AssertRan(response);
            Assert.Equal(3.0, response.Rows![0][0].GetDouble());
            Assert.Equal("1.12:00:00", response.Rows![0][1].GetString());
            Assert.Equal("nb-NO", CultureInfo.CurrentCulture.Name);
        }
        finally
        {
            CultureInfo.CurrentCulture = before;
        }
    }

    [Fact]
    public void A_datetime_literal_with_an_offset_is_that_instant_in_utc()
    {
        var response = Run("print a = datetime(2026-01-01T10:00+02:00), b = datetime(2026-01-01T10:00:00Z), c = datetime(2026-01-01 10:00)");

        AssertRan(response);
        Assert.Equal("2026-01-01T08:00:00.0000000Z", response.Rows![0][0].GetString());
        Assert.Equal("2026-01-01T10:00:00.0000000Z", response.Rows![0][1].GetString());
        Assert.Equal("2026-01-01T10:00:00.0000000Z", response.Rows![0][2].GetString());
    }

    [Theory]
    [InlineData("displayName == ''", "empty,missing,null")]
    [InlineData("isempty(displayName)", "empty,missing,null")]
    [InlineData("isnull(displayName)", "")]
    [InlineData("isnotnull(displayName)", "empty,missing,named,null")]
    [InlineData("displayName startswith ''", "empty,missing,named,null")]
    public void A_missing_string_reads_as_empty_like_kusto(string predicate, string expected)
    {
        // The translator's assumption: KQL has no null strings, so a missing or null Graph value is "" in the query.
        var table = EngineTables.Of(GraphSchemaCatalog.Beta.Find("applications")!,
        [
            new JsonObject { ["id"] = "empty", ["displayName"] = "" },
            new JsonObject { ["id"] = "missing" },
            new JsonObject { ["id"] = "named", ["displayName"] = "Payroll" },
            new JsonObject { ["id"] = "null", ["displayName"] = null },
        ]);

        var response = Run($"applications | where {predicate} | project id | order by id asc", tables: table);

        AssertRan(response);
        Assert.Equal(expected, string.Join(",", response.Rows!.Select(r => r[0].GetString())));
    }

    [Fact]
    public void Values_that_dont_convert_are_counted()
    {
        var table = Applications(("bad", "not a date"), ("good", "2026-01-01T00:00:00Z"));

        var response = Run("applications | project displayName, createdDateTime | order by displayName asc", tables: table);

        AssertRan(response);
        Assert.Equal(1, response.DroppedValues);
        Assert.Equal(JsonValueKind.Null, response.Rows![0][1].ValueKind);
        Assert.Equal("2026-01-01T00:00:00.0000000Z", response.Rows![1][1].GetString());
    }

    [Fact]
    public void Cells_keep_their_kusto_shape()
    {
        var table = EngineTables.Of(
            new GraphTable("things", "things", "x", "", "", [
                new("i", "int", "", [], false, null),
                new("l", "long", "", [], false, null),
                new("r", "real", "", [], false, null),
                new("b", "bool", "", [], false, null),
                new("g", "guid", "", [], false, null),
                new("t", "timespan", "", [], false, null),
                new("d", "dynamic", "", [], false, null),
                new("s", "string", "", [], false, null),
            ]),
            [new JsonObject
            {
                ["i"] = 7, ["l"] = 9_000_000_000L, ["r"] = 2.5, ["b"] = true,
                ["g"] = "0b1a1c2e-0000-4000-8000-000000000001", ["t"] = "PT1H30M",
                ["d"] = new JsonObject { ["a"] = new JsonArray(1, 2) }, ["s"] = "x",
            }]);

        var response = Run("things", tables: table);

        AssertRan(response);
        Assert.Equal(["int", "long", "real", "bool", "guid", "timespan", "dynamic", "string"], response.Columns!.Select(c => c.Type));
        var row = response.Rows![0];
        Assert.Equal(7, row[0].GetInt32());
        Assert.Equal(9_000_000_000L, row[1].GetInt64());
        Assert.Equal(2.5, row[2].GetDouble());
        Assert.True(row[3].GetBoolean());
        Assert.Equal("0b1a1c2e-0000-4000-8000-000000000001", row[4].GetString());
        Assert.Equal("01:30:00", row[5].GetString());
        Assert.Equal("""{"a":[1,2]}""", row[6].GetRawText());
        Assert.Equal("x", row[7].GetString());
        Assert.Equal(0, response.DroppedValues);
    }

    [Fact]
    public void Unsupported_function_is_an_error_naming_it()
    {
        var response = Run("print x = array_concat(dynamic([1]), dynamic([2]))");

        Assert.Null(response.Refusal);
        Assert.NotNull(response.Error);
        Assert.StartsWith("Not supported here: ", response.Error, StringComparison.Ordinal);
        Assert.Contains("array_concat", response.Error, StringComparison.Ordinal);
        Assert.Null(response.Rows);
    }

    [Theory]
    [InlineData("externaldata (x:string) [@\"https://example.com/a.csv\"]")]
    [InlineData(".show tables")]
    [InlineData("evaluate sql_request(\"x\", \"y\")")]
    public void Worker_refuses_externaldata(string kql)
    {
        var response = Run(kql);

        Assert.NotNull(response.Refusal);
        Assert.Null(response.Error);
        Assert.Null(response.Columns);
        Assert.Null(response.Rows);
    }

    [Fact]
    public void External_data_never_reaches_the_network_even_past_the_refusal()
    {
        // The context Handle uses, with the refusal bypassed: the resolver refuses before any request is made.
        var result = EngineHandler.NewContext()
            .RunQueryWithoutDemandBasedTableLoading("externaldata (x:string) [@\"https://127.0.0.1:9/a.csv\"]");

        Assert.Equal("externaldata isn't available in Graph query.", result.Error);
    }

    [Fact]
    public void A_user_let_named_now_doesnt_shadow_the_built_in_so_it_is_pinned_like_the_built_in()
    {
        // Kusto.Language binds now() to the built-in even under `let now = …` (no diagnostic), and KustoLoco, unrewritten,
        // answers it with its wall clock: the user's function is never called. The rewrite pins what would run anyway.
        var response = Run("let now = () { datetime(2001-01-01) }; print now()", new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero));

        AssertRan(response);
        Assert.Equal("2020-01-01T00:00:00.0000000Z", response.Rows![0][0].GetString());
    }

    [Theory]
    [InlineData("print ['now'] = 1 | project ['now'], ['ago'] = 2")]
    [InlineData("print s = \"datetime(2026-01-01T10:00+02:00)\"")]
    [InlineData("print s = 'now() ago(1d)' // now() datetime(2026-01-01T10:00+02:00)")]
    public void The_rewrite_leaves_names_strings_and_comments_alone(string kql)
    {
        Assert.Equal(kql, QueryClock.Rewrite(kql, new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc)));
    }

    [Fact]
    public void A_datetime_literal_that_cant_be_read_fails_loudly()
    {
        var e = Assert.Throws<FormatException>(() => QueryClock.Utc("datetime(not a date)"));

        Assert.Contains("datetime(not a date)", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rows_are_cut_at_MaxRows_and_total_counts_all()
    {
        var response = Run("range x from 1 to 50 step 1", maxRows: 10);

        AssertRan(response);
        Assert.Equal(10, response.Rows!.Count);
        Assert.Equal(50, response.Total);
        Assert.Equal(Enumerable.Range(1, 10).Select(i => (long)i), response.Rows!.Select(r => r[0].GetInt64()));
    }

    private static EngineTable Applications(params (string Name, string Created)[] rows) =>
        EngineTables.Of(GraphSchemaCatalog.Beta.Find("applications")!,
            rows.Select(r => new JsonObject { ["displayName"] = r.Name, ["createdDateTime"] = r.Created }).ToList());

    [Fact]
    public void Cells_are_cut_to_1000_characters_before_answering()
    {
        var response = Run("print s = strrep('a', 5000), d = bag_pack('k', strrep('b', 5000)), short = 'x'");

        AssertRan(response);
        var row = response.Rows![0];
        Assert.Equal(1000, row[0].GetString()!.Length);
        Assert.EndsWith("…", row[0].GetString());
        Assert.Equal(JsonValueKind.String, row[1].ValueKind);   // a dynamic value too long to keep is sent as its cut JSON
        Assert.Equal(1000, row[1].GetString()!.Length);
        Assert.StartsWith("""{"k":"bbb""", row[1].GetString());
        Assert.Equal("x", row[2].GetString());
    }

    [Fact]
    public void A_make_series_answer_keeps_its_arrays_whole()
    {
        // The app unrolls these to one row per point, so they are not cut however long they are.
        var response = Run("range x from 1 to 200 step 1 | extend t = datetime(2026-01-01) + x * 1d | make-series n = count() default = 0 on t from datetime(2026-01-01) to datetime(2026-08-01) step 1d");

        AssertRan(response);
        var series = response.Columns!.Select((c, i) => (c, i)).Where(x => x.c.Type == "dynamic").Select(x => response.Rows![0][x.i]).ToList();
        Assert.Equal(2, series.Count);
        Assert.All(series, cell => Assert.Equal(JsonValueKind.Array, cell.ValueKind));
        Assert.All(series, cell => Assert.True(cell.GetArrayLength() > 200));
    }

    [Theory]
    [InlineData("print x = OutOfMemoryException")]
    [InlineData("print x = ['System.OutOfMemoryException']")]
    public void A_bind_error_naming_OutOfMemoryException_is_an_error_not_an_out_of_memory_exit(string kql)
    {
        var response = Run(kql);

        Assert.NotNull(response.Error);
        Assert.StartsWith(EngineHandler.UnsupportedPrefix, response.Error);
    }


    [Theory]
    [InlineData("applications | mv-expand rra = requiredResourceAccess | mv-expand permission = rra.resourceAccess | where permission.id in (dynamic(['a'])) | project appId")]
    [InlineData("applications | where tags !in ('x')")]
    [InlineData("applications | where tags in~ ('x')")]
    [InlineData("applications | where tags has_any ('x')")]
    public void A_dynamic_value_left_of_in_says_to_convert_it(string kql)
    {
        var response = RunOnFixtures(kql);

        Assert.Equal(EngineHandler.UnsupportedPrefix + EngineHandler.DynamicSetMessage, response.Error);
    }

    [Fact]
    public void A_dynamic_value_converted_with_tostring_works_left_of_in()
    {
        var response = RunOnFixtures("""
            let roles = servicePrincipals | mv-expand role = appRoles | project id = tostring(role.id);
            applications
            | mv-expand rra = requiredResourceAccess
            | mv-expand permission = rra.resourceAccess
            | where tostring(permission.id) in (roles)
            | project appId
            """);

        AssertRan(response);
    }
}
