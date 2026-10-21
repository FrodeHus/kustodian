using System.Globalization;
using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;
using Kusto.Language;

namespace Kustodian.Graph.Tests;

public sealed class GraphFilterTranslatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 0, 0, 0, TimeSpan.Zero);

    private static readonly IReadOnlyList<GraphColumn> Columns =
    [
        new("id", "string", "", ["eq", "in"], false, null),
        new("appId", "string", "", ["eq", "in"], false, null),
        new("displayName", "string", "", ["eq", "ne", "not", "ge", "le", "in", "startsWith"], false, null),
        new("createdDateTime", "datetime", "", ["eq", "ne", "not", "ge", "le", "gt", "lt", "in"], false, null),
        new("deletedDateTime", "datetime", "", ["eq", "ne", "ge", "le"], false, null),
        new("accountEnabled", "bool", "", ["eq", "ne"], false, null),
        new("keyCount", "long", "", ["eq", "ne", "gt", "ge", "lt", "le", "in"], false, null),
        new("weight", "real", "", ["eq", "gt"], false, null),
        new("onPremisesPublishing", "dynamic", "", ["eq"], false, "microsoft.graph.onPremisesPublishing"),
    ];

    private static readonly GraphTable Applications =
        new("applications", "applications", "microsoft.graph.application", "", "", Columns, DirectoryObject: true);

    /// <summary>The same columns on a table that isn't a directory object, where Graph's string matching may be
    /// case-sensitive.</summary>
    private static readonly GraphTable Incidents = new("security_incidents", "security/incidents", "microsoft.graph.security.incident", "", "", Columns);

    private static readonly GraphSchema Schema = new("test", DateTimeOffset.UnixEpoch, [Applications, Incidents],
        new Dictionary<string, IReadOnlyList<GraphField>>
        {
            ["microsoft.graph.onPremisesPublishing"] = [new("externalAuthenticationType", "string", false, null, "")],
        });

    private static string? Translate(string kql) => Translate(Applications, kql);

    private static string? Translate(GraphTable table, string kql)
    {
        var code = KustoCode.ParseAndAnalyze(kql, GraphGlobals.Plain(Schema));
        Assert.DoesNotContain(code.GetDiagnostics(), d => d.Severity == DiagnosticSeverity.Error);
        var symbol = code.Globals.Database.Tables.Single(t => t.Name == table.Name);
        var predicates = GraphQueryPlanner.LeadingPredicates(code, symbol);
        Assert.NotNull(predicates);
        return GraphFilterTranslator.Translate(table, predicates, Now);
    }

    [Theory]
    [InlineData("applications | where displayName == 'Payroll'", "displayName eq 'Payroll'")]
    [InlineData("applications | where displayName =~ 'x'", "displayName eq 'x'")]
    [InlineData("applications | where createdDateTime > datetime(2026-01-01)", "createdDateTime ge 2026-01-01T00:00:00Z")]
    [InlineData("applications | where createdDateTime >= ago(7d)", "createdDateTime ge 2026-10-13T00:00:00Z")]
    [InlineData("applications | where createdDateTime < now()", "createdDateTime le 2026-10-20T00:00:00Z")]
    [InlineData("applications | where createdDateTime <= datetime(2026-01-01)", "createdDateTime le 2026-01-01T00:00:00Z")]
    [InlineData("applications | where keyCount > 3", "keyCount gt 3")]
    [InlineData("applications | where weight > 1.5", "weight gt 1.5")]
    [InlineData("applications | where appId in ('a','b')", "appId in ('a','b')")]
    [InlineData("applications | where appId in~ ('a', \"b\")", "appId in ('a','b')")]
    [InlineData("applications | where displayName startswith 'Pay'", "startswith(displayName,'Pay')")]
    [InlineData("applications | where displayName startswith_cs 'Pay'", "startswith(displayName,'Pay')")]
    [InlineData("applications | where accountEnabled == true", "accountEnabled eq true")]
    [InlineData("applications | where accountEnabled == false", "accountEnabled eq false")]
    [InlineData("applications | where appId == 'a' and displayName == 'b'", "appId eq 'a' and displayName eq 'b'")]
    [InlineData("applications | where appId == 'a' | where displayName == 'b'", "appId eq 'a' and displayName eq 'b'")]
    [InlineData("applications | where appId == 'a' or displayName startswith 'b'", "(appId eq 'a' or startswith(displayName,'b'))")]
    [InlineData("applications | where (appId == 'a')", "appId eq 'a'")]
    [InlineData("applications | where displayName == \"O'Brien\"", "displayName eq 'O''Brien'")]
    [InlineData("applications | where createdDateTime in (datetime(2026-01-01), datetime(2026-02-01 10:00))",
        "createdDateTime in (2026-01-01T00:00:00Z,2026-02-01T10:00:00Z)")]
    [InlineData("applications | where createdDateTime < now(1d)", "createdDateTime le 2026-10-21T00:00:00Z")]
    [InlineData("applications | where createdDateTime > datetime(2026-01-01T10:00+02:00)", "createdDateTime ge 2026-01-01T08:00:00Z")]
    [InlineData("applications | where createdDateTime > datetime(2026-01-01T10:00:00Z)", "createdDateTime ge 2026-01-01T10:00:00Z")]
    public void Pushes(string kql, string filter) => Assert.Equal(filter, Translate(kql));

    [Theory]
    // Graph's datetime precision isn't known, so a strict bound is sent inclusive: the fetch only widens. Numbers keep
    // gt and lt; >= and <= are unchanged.
    [InlineData("applications | where createdDateTime > datetime(2026-01-01)", "createdDateTime ge 2026-01-01T00:00:00Z")]
    [InlineData("applications | where createdDateTime < datetime(2026-01-01)", "createdDateTime le 2026-01-01T00:00:00Z")]
    [InlineData("applications | where createdDateTime >= datetime(2026-01-01)", "createdDateTime ge 2026-01-01T00:00:00Z")]
    [InlineData("applications | where createdDateTime <= datetime(2026-01-01)", "createdDateTime le 2026-01-01T00:00:00Z")]
    [InlineData("applications | where deletedDateTime > ago(1d)", "deletedDateTime ge 2026-10-19T00:00:00Z")]
    [InlineData("applications | where keyCount > 3", "keyCount gt 3")]
    [InlineData("applications | where keyCount < 3", "keyCount lt 3")]
    public void Strict_datetime_bounds_push_inclusive(string kql, string filter) => Assert.Equal(filter, Translate(kql));

    [Theory]
    [InlineData("applications | where displayName != 'x'")]
    [InlineData("applications | where displayName !~ 'x'")]
    [InlineData("applications | where displayName has 'x'")]
    [InlineData("applications | where displayName contains 'x'")]
    [InlineData("applications | where displayName matches regex 'x'")]
    [InlineData("applications | where onPremisesPublishing.externalAuthenticationType == 'passthru'")]
    [InlineData("applications | where tolower(displayName) startswith 'x'")]
    [InlineData("applications | where appId == displayName")]
    [InlineData("applications | where not(appId == 'a')")]
    [InlineData("applications | where appId startswith 'a'")]
    [InlineData("applications | where accountEnabled in (true)")]
    [InlineData("applications | where appId !in ('a')")]
    [InlineData("applications | where isnotnull(displayName)")]
    [InlineData("applications | where appId == 'a' or displayName has 'b'")]
    [InlineData("applications | extend x = 1 | where appId == 'a'")]
    [InlineData("applications | take 10 | where appId == 'a'")]
    [InlineData("applications")]
    // KQL has no null strings: a missing value reads as "", so an empty literal would match rows Graph's eq '' drops.
    [InlineData("applications | where displayName == ''")]
    [InlineData("applications | where displayName =~ ''")]
    [InlineData("applications | where appId in ('a', '')")]
    [InlineData("applications | where appId in~ ('', 'a')")]
    [InlineData("applications | where displayName startswith ''")]
    [InlineData("applications | where displayName startswith_cs ''")]
    [InlineData("applications | where displayName !startswith 'a'")]
    [InlineData("applications | where appId !in~ ('a')")]
    public void Does_not_push(string kql) => Assert.Null(Translate(kql));

    [Theory]
    // Graph's string matching is only known to ignore case on directory objects: elsewhere a case-insensitive KQL
    // operator could match rows Graph's eq/in/startswith drops. Case-sensitive == and in are safe either way.
    [InlineData("security_incidents | where displayName =~ 'x'", null)]
    [InlineData("security_incidents | where appId in~ ('a')", null)]
    [InlineData("security_incidents | where displayName startswith 'x'", null)]
    [InlineData("security_incidents | where displayName startswith_cs 'x'", null)]
    [InlineData("security_incidents | where displayName == 'x'", "displayName eq 'x'")]
    [InlineData("security_incidents | where appId in ('a')", "appId in ('a')")]
    public void Case_insensitive_operators_push_only_on_directory_objects(string kql, string? filter) =>
        Assert.Equal(filter, Translate(Incidents, kql));

    [Theory]
    // ne and null checks need Graph's advanced query mode on directory objects (ConsistencyLevel eventual and $count),
    // which Graph query doesn't use: there they aren't pushed. Elsewhere they are.
    [InlineData("applications | where keyCount != 3", null)]
    [InlineData("applications | where accountEnabled != true", null)]
    [InlineData("applications | where isnull(displayName)", null)]
    [InlineData("applications | where isnotnull(createdDateTime)", null)]
    [InlineData("applications | where keyCount != 3 and appId == 'a'", "appId eq 'a'")]
    [InlineData("security_incidents | where keyCount != 3", "keyCount ne 3")]
    [InlineData("security_incidents | where accountEnabled != true", "accountEnabled ne true")]
    [InlineData("security_incidents | where isnull(displayName)", "displayName eq null")]
    [InlineData("security_incidents | where isnotnull(createdDateTime)", "createdDateTime ne null")]
    public void Ne_and_null_checks_push_only_off_directory_objects(string kql, string? filter)
    {
        var table = kql.StartsWith("applications", StringComparison.Ordinal) ? Applications : Incidents;
        Assert.Equal(filter, Translate(table, kql));
    }

    [Theory]
    // KQL has no null strings, so isnotnull on text keeps every row; "ne null" would keep fewer. Off directory objects,
    // isnotnull still pushes on non-text columns.
    [InlineData("security_incidents | where isnotnull(displayName)", null)]
    [InlineData("security_incidents | where isnotnull(appId)", null)]
    [InlineData("security_incidents | where isnotnull(keyCount)", "keyCount ne null")]
    public void Isnotnull_on_text_not_pushed(string kql, string? filter) => Assert.Equal(filter, Translate(Incidents, kql));

    [Theory]
    // An or narrows only when both sides do: one side that can't be pushed would drop rows the other side keeps.
    [InlineData("applications | where appId == 'a' or keyCount > 3", "(appId eq 'a' or keyCount gt 3)")]
    [InlineData("applications | where appId == 'a' or displayName has 'b'", null)]
    [InlineData("applications | where displayName has 'b' or appId == 'a'", null)]
    [InlineData("applications | where (appId == 'a' or keyCount > 3) and displayName has 'b'", "(appId eq 'a' or keyCount gt 3)")]
    public void Or_pushes_only_when_both_sides_push(string kql, string? filter) => Assert.Equal(filter, Translate(kql));

    [Theory]
    [InlineData("applications | where not(appId == 'a')")]
    [InlineData("applications | where not(keyCount > 3)")]
    [InlineData("security_incidents | where not(appId == 'a')")]
    [InlineData("security_incidents | where not(keyCount > 3)")]
    public void Not_is_never_pushed(string kql) =>
        Assert.Null(Translate(kql.StartsWith("applications", StringComparison.Ordinal) ? Applications : Incidents, kql));

    [Theory]
    // A column is only filtered with the operators Graph says it supports (weight: eq and gt only; id: eq and in only).
    [InlineData("applications | where weight < 2")]
    [InlineData("applications | where weight >= 2")]
    [InlineData("applications | where id != 'x'")]
    [InlineData("security_incidents | where weight < 2")]
    [InlineData("security_incidents | where isnotnull(weight)")]
    [InlineData("security_incidents | where id != 'x'")]
    [InlineData("applications | where weight in (1, 2)")]
    [InlineData("security_incidents | where weight in (1, 2)")]
    [InlineData("security_incidents | where displayName != 'x'")]
    public void Disallowed_operators_are_not_pushed(string kql) =>
        Assert.Null(Translate(kql.StartsWith("applications", StringComparison.Ordinal) ? Applications : Incidents, kql));

    [Fact]
    public void Pushes_the_pushable_conjuncts_only() =>
        Assert.Equal("appId eq 'a'", Translate("applications | where appId == 'a' and displayName has 'b'"));

    [Theory]
    // Sub-second bounds round outwards, so the pushed range never keeps fewer rows than KQL; equality can't round.
    [InlineData("applications | where createdDateTime > datetime(2026-01-01 10:00:00.5)", "createdDateTime ge 2026-01-01T10:00:00Z")]
    [InlineData("applications | where createdDateTime >= datetime(2026-01-01 10:00:00.5)", "createdDateTime ge 2026-01-01T10:00:00Z")]
    [InlineData("applications | where createdDateTime < datetime(2026-01-01 10:00:00.5)", "createdDateTime le 2026-01-01T10:00:01Z")]
    [InlineData("applications | where createdDateTime <= datetime(2026-01-01 10:00:00.5)", "createdDateTime le 2026-01-01T10:00:01Z")]
    [InlineData("applications | where createdDateTime == datetime(2026-01-01 10:00:00.5)", null)]
    [InlineData("applications | where createdDateTime != datetime(2026-01-01 10:00:00.5)", null)]
    public void Rounds_sub_second_datetimes_outwards(string kql, string? filter) => Assert.Equal(filter, Translate(kql));

    [Theory]
    [InlineData("applications | where weight > 1.5", "weight gt 1.5")]
    [InlineData("applications | where createdDateTime >= ago(1.5d)", "createdDateTime ge 2026-10-18T12:00:00Z")]
    [InlineData("applications | where createdDateTime >= ago(90m)", "createdDateTime ge 2026-10-19T22:30:00Z")]
    [InlineData("applications | where createdDateTime > datetime(2026-01-01 10:00:00.5)", "createdDateTime ge 2026-01-01T10:00:00Z")]
    public void Reads_literals_invariantly_in_a_comma_decimal_culture(string kql, string filter)
    {
        var culture = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("nb-NO");
        try
        {
            Assert.Equal(filter, Translate(kql));
        }
        finally
        {
            CultureInfo.CurrentCulture = culture;
        }
    }

    [Fact]
    public void Planner_sets_the_filter()
    {
        var plan = GraphQueryPlanner.Plan(Schema, "applications | where appId == 'a' | project displayName", Now);

        Assert.Equal("appId eq 'a'", Assert.Single(plan.Fetches).Filter);
    }
}
