using System.Globalization;
using System.Text.Json.Nodes;
using Kustodian.Graph.Engine;
using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;

namespace Kustodian.Engine.Tests;

/// <summary>The pushdown property (spec §3.3): a pushed <c>$filter</c> only narrows the fetch, so the query's answer over the
/// objects Graph keeps for the filter is the answer over every object. Graph is played by <see cref="ODataMatcher"/>, which
/// implements exactly the operators the translator emits, with Graph's case-insensitive string matching on directory
/// objects.</summary>
public sealed class PushdownEquivalenceTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 8, 0, 0, TimeSpan.Zero);

    private static readonly GraphTable Applications = new("applications", "applications", "microsoft.graph.application", "", "",
    [
        new("id", "string", "", ["eq", "in"], false, null),
        new("displayName", "string", "", ["eq", "ne", "not", "ge", "le", "in", "startsWith"], false, null),
        new("signInAudience", "string", "", ["eq", "ne", "not", "in"], false, null),
        new("createdDateTime", "datetime", "", ["eq", "ne", "not", "ge", "le", "gt", "lt", "in"], false, null),
        new("keyCount", "long", "", ["eq", "ne", "gt", "ge", "lt", "le", "in"], false, null),
        new("weight", "real", "", ["eq", "ne", "gt", "ge", "lt", "le"], false, null),
        new("isDisabled", "bool", "", ["eq", "ne"], false, null),
        new("notes", "string", "", [], false, null),
    ], DirectoryObject: true);

    private static readonly GraphSchema Schema = new("test", DateTimeOffset.UnixEpoch, [Applications],
        new Dictionary<string, IReadOnlyList<GraphField>>());

    // "" is where Graph and KQL part ways: Graph keeps an empty string apart from a missing value, KQL reads both as "".
    // Objects get "", a value, or no property at all.
    private static readonly string[] Names =
        ["Payroll Portal", "payroll portal", "PAYROLL", "Partner Portal", "CI Deployer", "ci deployer", "HR Wiki", "O'Brien App", "Marketing", ""];

    private static readonly string[] Audiences = ["AzureADMyOrg", "azureadmyorg", "AzureADMultipleOrgs", "AzureADandPersonalMicrosoftAccount", ""];

    private static readonly string[] Instants =
    [
        "2026-01-01T08:00:00Z", "2026-01-01T07:59:59Z", "2026-01-01T08:00:01Z", "2026-01-01T08:00:00.5Z", "2026-01-01T10:00:00Z",
        "2026-01-01T00:00:00Z", "2026-10-20T07:59:59.9999999Z", "2026-10-20T08:00:00Z", "2026-10-20T08:00:01Z", "2026-10-19T07:59:59Z",
        "2026-10-19T08:00:00Z", "2026-10-18T20:00:00Z", "2026-10-20T09:00:00Z", "2025-06-15T12:30:00Z",
    ];

    private static readonly string[] DateLiterals =
    [
        "datetime(2026-01-01T10:00+02:00)", "datetime(2026-01-01)", "datetime(2026-01-01 08:00:00.5)", "datetime(2026-01-01T08:00:00Z)",
        "now()", "ago(1d)", "ago(1.5d)", "now(1h)", "ago(12h)", "datetime(2025-06-15 12:30)",
    ];

    private static readonly string[] Required =
    [
        "createdDateTime > datetime(2026-01-01T10:00+02:00)",
        "createdDateTime >= datetime(2026-01-01T10:00+02:00) and createdDateTime < now()",
        "createdDateTime == datetime(2026-01-01T10:00+02:00)",
        "displayName == 'payroll portal'",
        "displayName =~ 'PAYROLL PORTAL'",
        "displayName in~ ('ci DEPLOYER', 'hr wiki')",
        "displayName startswith 'PAY'",
        "displayName == ''",
        "displayName startswith ''",
        "signInAudience in ('', 'AzureADMyOrg')",
        "isempty(displayName)",
        "displayName startswith_cs 'pay'",
        "signInAudience in ('azureadmyorg', 'AzureADMultipleOrgs')",
        "createdDateTime < now()",
        "isnull(createdDateTime) or keyCount > 3",
    ];

    [Fact]
    public void Pushed_filter_never_changes_the_answer()
    {
        var random = new Random(42);
        var objects = Enumerable.Range(0, 200).Select(i => GenerateObject(random, i)).ToList();
        var predicates = Required.Concat(Enumerable.Range(0, 30).Select(_ => GeneratePredicate(random))).ToList();

        var pushed = 0;
        var narrowed = 0;
        foreach (var predicate in predicates)
        {
            var kql = $"applications | where {predicate} | project id | order by id asc";
            var plan = GraphQueryPlanner.Plan(Schema, kql, Now);
            Assert.True(plan.CanRun, $"{kql}: {plan.Error?.Message ?? plan.Refusal}");
            var filter = plan.Fetches.Single().Filter;

            var kept = filter is null ? objects : objects.Where(o => ODataMatcher.Matches(filter, o, Applications.DirectoryObject)).ToList();
            if (filter is not null)
                pushed++;
            if (kept.Count < objects.Count)
                narrowed++;

            var all = Ids(kql, objects);
            var filtered = Ids(kql, kept);
            Assert.True(all.SequenceEqual(filtered),
                $"{kql}\n$filter={filter}\nall: {string.Join(",", all)}\nfiltered: {string.Join(",", filtered)}");
        }

        // The property is only worth something if most predicates were pushed and actually narrowed the fetch.
        Assert.True(pushed >= predicates.Count * 2 / 3, $"only {pushed} of {predicates.Count} predicates were pushed");
        Assert.True(narrowed >= predicates.Count / 2, $"only {narrowed} of {predicates.Count} filters narrowed the fetch");
    }

    /// <summary>The matcher itself, on the translator's shapes, so a matcher bug can't hide a translator bug.</summary>
    [Theory]
    [InlineData("displayName eq 'o''brien app'", true)]
    [InlineData("displayName eq 'x'", false)]
    [InlineData("startswith(displayName,'O''B')", true)]
    [InlineData("createdDateTime ge 2026-01-01T08:00:00Z", true)]
    [InlineData("createdDateTime gt 2026-01-01T08:00:00Z", false)]
    [InlineData("keyCount in (1,3)", true)]
    [InlineData("(keyCount lt 1 or isDisabled eq false)", true)]
    [InlineData("weight eq null", true)]
    [InlineData("weight ne 2", true)]
    [InlineData("weight lt 2", false)]
    [InlineData("keyCount eq null", false)]
    [InlineData("keyCount ne null and createdDateTime lt 2026-01-01T08:00:01Z", true)]
    [InlineData("keyCount ge 3.5", false)]
    public void Matcher_reads_the_translator_shapes(string filter, bool expected)
    {
        var row = JsonNode.Parse("""{"displayName":"O'Brien App","createdDateTime":"2026-01-01T08:00:00Z","keyCount":3,"isDisabled":false}""")!.AsObject();

        Assert.Equal(expected, ODataMatcher.Matches(filter, row, directoryObject: true));
    }

    [Fact]
    public void Matcher_is_case_sensitive_off_directory_objects()
    {
        var row = new JsonObject { ["displayName"] = "Payroll" };

        Assert.False(ODataMatcher.Matches("displayName eq 'payroll'", row, directoryObject: false));
        Assert.True(ODataMatcher.Matches("displayName eq 'payroll'", row, directoryObject: true));
    }

    private static List<string> Ids(string kql, IReadOnlyList<JsonObject> rows)
    {
        var response = EngineHandler.Handle(new EngineRequest(kql, Now, [EngineTables.Of(Applications, rows)], 10_000));
        Assert.True(response.Error is null && response.Refusal is null, $"{kql}: {response.Error ?? response.Refusal}");
        Assert.Equal(0, response.DroppedValues);
        return response.Rows!.Select(r => r[0].GetString()!).ToList();
    }

    private static JsonObject GenerateObject(Random random, int index)
    {
        var o = new JsonObject { ["id"] = $"app-{index:D3}" };
        if (random.Next(10) > 0)
            o["displayName"] = Names[random.Next(Names.Length)];
        if (random.Next(5) > 0)
            o["signInAudience"] = Audiences[random.Next(Audiences.Length)];
        if (random.Next(8) > 0)
            o["createdDateTime"] = random.Next(3) == 0
                ? new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddSeconds(random.Next(0, 3 * 365 * 24 * 3600)).AddMilliseconds(random.Next(2) * random.Next(1000))
                    .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
                : Instants[random.Next(Instants.Length)];
        if (random.Next(4) > 0)
            o["keyCount"] = random.Next(0, 7);
        if (random.Next(4) > 0)
            o["weight"] = random.Next(0, 7) * 0.5;
        if (random.Next(4) > 0)
            o["isDisabled"] = random.Next(2) == 0;
        o["notes"] = random.Next(2) == 0 ? "owned by finance" : "legacy";
        return o;
    }

    private static string GeneratePredicate(Random random)
    {
        var conjuncts = Enumerable.Range(0, random.Next(1, 4)).Select(_ => random.Next(4) == 0
            ? $"({GenerateAtom(random)} or {GenerateAtom(random)})"
            : GenerateAtom(random));
        // Sometimes two leading wheres instead of one and.
        var list = conjuncts.ToList();
        return list.Count > 1 && random.Next(3) == 0
            ? $"{string.Join(" and ", list.Skip(1))} | where {list[0]}"
            : string.Join(" and ", list);
    }

    private static string GenerateAtom(Random random)
    {
        T Pick<T>(IReadOnlyList<T> items) => items[random.Next(items.Count)];
        string Name() => Quote(Perturb(random, Pick(Names)));
        string Prefix()
        {
            var name = Pick(Names);
            return Quote(Perturb(random, name[..Math.Min(name.Length, random.Next(0, 5))]));
        }
        string Audience() => Quote(Perturb(random, Pick(Audiences)));
        string Comparison() => Pick(["<", "<=", ">", ">=", "==", "!="]);

        return random.Next(17) switch
        {
            0 => $"displayName {Pick(["==", "=~"])} {Name()}",
            1 => $"displayName {Pick(["in", "in~"])} ({Name()}, {Name()})",
            2 => $"displayName {Pick(["startswith", "startswith_cs"])} {Prefix()}",
            3 => $"signInAudience {Pick(["==", "=~"])} {Audience()}",
            4 => $"signInAudience {Pick(["in", "in~"])} ({Audience()}, {Audience()})",
            5 or 6 or 7 => $"createdDateTime {Comparison()} {Pick(DateLiterals)}",
            // KustoLoco runs `in` only on string and long lists, so a datetime `in` (which the translator pushes) can't be
            // compared here: the engine answers it with an error.
            8 => $"createdDateTime between ({Pick(DateLiterals)} .. {Pick(DateLiterals)})",
            9 => $"{Pick(["isnull", "isnotnull"])}({Pick(["createdDateTime", "keyCount", "weight", "isDisabled", "displayName"])})",
            10 or 11 => $"keyCount {Comparison()} {random.Next(0, 7)}",
            12 => $"keyCount in ({random.Next(0, 7)}, {random.Next(0, 7)})",
            13 => $"weight {Comparison()} {Pick(["1.5", "2.0", "0.5", "3"])}",
            14 => $"isDisabled {Pick(["==", "!="])} {Pick(["true", "false"])}",
            15 => $"displayName != {Name()}",
            _ => $"notes has {Quote(Pick(["finance", "legacy"]))}",
        };
    }

    private static string Perturb(Random random, string text) => random.Next(3) switch
    {
        0 => text.ToUpperInvariant(),
        1 => text.ToLowerInvariant(),
        _ => text,
    };

    private static string Quote(string text) => $"'{text.Replace("'", "\\'", StringComparison.Ordinal)}'";
}
