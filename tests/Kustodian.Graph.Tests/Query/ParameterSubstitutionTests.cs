using System.Text.Json;
using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;
using Kusto.Language;
using Kusto.Language.Syntax;

namespace Kustodian.Graph.Tests.Query;

public sealed class ParameterSubstitutionTests
{
    // The comparison comes after a project, so nothing is pushed down to $filter: the fetch is the same whatever the value.
    private const string TextTemplate = "applications | project displayName | where displayName == {v} | take 5";

    private static ParameterValue Value(string name, string type, string value, bool required = false) => new(name, type, value, required);

    private static SubstitutionResult Apply(string kql, params ParameterValue[] values) => ParameterSubstitution.Apply(kql, values);

    [Fact]
    public void Find_ignores_strings_and_comments()
    {
        const string kql = """
            applications
            | where a == "{s1}" or a == '{s2}' or a == "\"{s3}" or a == '\'{s4}'
            | where a == @"{v1}" or a == @'x''{v2}' or a == @"x""{v3}" or a == h"{h1}"
            | where a == ```{m1}
            {m2}``` // {c1}
            | where a == {first} and b == {second} and c == {first} and d == @"a\" == {third}
            // {c2}
            | where e == {fourth}
            """;

        Assert.Equal(["first", "second", "third", "fourth"], ParameterSubstitution.Find(kql));
    }

    [Fact]
    public void Find_matches_shared_fixture()
    {
        // web/src/params/find-params.fixture.json, linked into the output: the web's findParams reads the same cases.
        using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "Query", "find-params.fixture.json"));
        using var fixture = JsonDocument.Parse(stream);
        var cases = fixture.RootElement.GetProperty("cases").EnumerateArray().ToList();

        Assert.NotEmpty(cases);
        foreach (var testCase in cases)
        {
            var expected = testCase.GetProperty("params").EnumerateArray().Select(p => p.GetString()!).ToList();
            var found = ParameterSubstitution.Find(testCase.GetProperty("text").GetString()!);
            Assert.True(expected.SequenceEqual(found),
                $"{testCase.GetProperty("name").GetString()}: expected [{string.Join(", ", expected)}], found [{string.Join(", ", found)}]");
        }
    }

    [Fact]
    public void Find_needs_a_name_in_braces()
    {
        Assert.Equal(["a_1", "_b"], ParameterSubstitution.Find("print {a_1}, {_b}, {1c}, { d }, {e f}, {}, dynamic({\"g\": 1})"));
    }

    [Fact]
    public void Find_skips_an_unterminated_string_to_the_end()
    {
        Assert.Equal(["a"], ParameterSubstitution.Find("print {a}, \"{b}"));
        Assert.Equal(["a"], ParameterSubstitution.Find("print {a}, ```{b}\n{c}"));
    }

    [Fact]
    public void Text_value_with_quotes_and_comment_is_one_literal()
    {
        var result = Apply(TextTemplate, Value("v", "text", "a\" or 1==1 //"));

        Assert.Null(result.Error);
        Assert.Contains("\"a\\\" or 1==1 //\"", result.Text, StringComparison.Ordinal);
        AssertSameStructure(TextTemplate, Value("v", "text", "a\" or 1==1 //"), Value("v", "text", "x"));
        var plan = GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, result.Text!, DateTimeOffset.UnixEpoch);
        var benign = GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, Apply(TextTemplate, Value("v", "text", "x")).Text!, DateTimeOffset.UnixEpoch);
        Assert.Null(plan.Error);
        var fetch = Assert.Single(plan.Fetches);
        Assert.Equal("applications", fetch.Table.Name);
        Assert.Equal(Assert.Single(benign.Fetches).Select, fetch.Select);
        Assert.Null(fetch.Filter);
    }

    [Theory]
    [InlineData("a\"b")]
    [InlineData("a\\")]
    [InlineData("a\\\" | take 1 //")]
    [InlineData("line 1\nline 2 | take 1")]
    [InlineData("crlf\r\n| take 1")]
    [InlineData("tab\there\u0001\u007f")]
    [InlineData("// not a comment")]
    [InlineData("x | project id")]
    [InlineData("x} | take 1 {y")]
    [InlineData("{other}")]
    [InlineData("'single' ```triple``` @\"verbatim\"")]
    [InlineData("")]
    public void Hostile_text_is_one_literal_holding_the_value(string value)
    {
        AssertSameStructure(TextTemplate, Value("v", "text", value), Value("v", "text", "x"));
        Assert.Equal(value, Assert.Single(Literals(Apply(TextTemplate, Value("v", "text", value)).Text!),
            l => l.Kind == SyntaxKind.StringLiteralExpression).LiteralValue);
    }

    [Theory]
    [InlineData("print x = @{v}")]
    [InlineData("print x = @\"a\"{v}")]
    [InlineData("print x = h{v}")]
    [InlineData("print x = 'a'{v}")]
    public void Text_next_to_a_prefix_or_string_is_never_read_as_part_of_it(string template)
    {
        var text = Apply(template, Value("v", "text", "a\" or 1==1 //")).Text!;

        // Whatever the parser makes of the rest (an error, or two adjacent strings), the value is one regular string token that
        // holds it whole.
        Assert.Contains(KustoCode.Parse(text).Syntax.GetDescendants<SyntaxToken>(),
            t => t.Kind == SyntaxKind.StringLiteralToken && t.Text == "\"a\\\" or 1==1 //\"");
        Assert.DoesNotContain(KustoCode.Parse(text).Syntax.GetDescendants<SyntaxNode>(), n => n.Kind == SyntaxKind.OrExpression);
    }

    [Theory]
    [InlineData("print x = 1 + {n}d", "5")]
    [InlineData("print x = 1 + {n}.5", "5")]
    [InlineData("print x = 1 + {n}e3", "5")]
    [InlineData("print x = y{n}", "5")]
    public void Number_next_to_a_name_or_dot_stays_a_separate_token(string template, string value)
    {
        var text = Apply(template, Value("n", "number", value)).Text!;

        Assert.Contains(Literals(text), l => l.Kind == SyntaxKind.LongLiteralExpression && (long?)l.LiteralValue == 5);
        Assert.DoesNotContain(Literals(text), l => l.Kind is SyntaxKind.TimespanLiteralExpression or SyntaxKind.RealLiteralExpression);
    }

    [Theory]
    [InlineData("5; drop")]
    [InlineData("1 or true")]
    [InlineData("1) | take 1")]
    [InlineData("NaN")]
    [InlineData("Infinity")]
    [InlineData("1e999")]
    [InlineData("0x10")]
    [InlineData("1,5")]
    [InlineData("١")]
    public void Number_rejects_anything_but_a_number(string value)
    {
        var result = Apply("applications | where 1 == {n}", Value("n", "number", value));

        Assert.Null(result.Text);
        Assert.Equal(new ParameterError("n", "n: a number like 30 or 2.5."), result.Error);
    }

    [Theory]
    [InlineData("30", "30")]
    [InlineData(" -7 ", "long(-7)")]
    [InlineData("-2.5", "real(-2.5)")]
    [InlineData("+7", "7")]
    [InlineData("2.5", "2.5")]
    [InlineData("5.0", "5.0")]
    [InlineData("1e20", "1E+20")]
    [InlineData("10000000000000000000000", "1E+22")]
    public void Number_is_emitted_invariantly(string value, string literal)
    {
        Assert.Equal($"print x = {literal}", Apply("print x = {n}", Value("n", "number", value)).Text);
        Assert.Empty(KustoCode.Parse(Apply("print x = 1 - {n}", Value("n", "number", value)).Text!).GetDiagnostics());
    }

    [Theory]
    [InlineData("7")]
    [InlineData("7x")]
    [InlineData("1d) | take 1")]
    [InlineData("1d\n| take 1")]
    [InlineData("1d | take 1")]
    [InlineData("1.d")]
    [InlineData("-1d")]
    [InlineData("١d")]
    public void Timespan_rejects_bad_value_with_rule_message(string value)
    {
        var result = Apply("applications | where createdDateTime > ago({withinDays})", Value("withinDays", "timespan", value));

        Assert.Null(result.Text);
        Assert.Null(result.Missing);
        Assert.Equal(new ParameterError("withinDays", "withinDays: a timespan like 7d, 12h or 30m."), result.Error);
    }

    [Theory]
    [InlineData("7d")]
    [InlineData("12h")]
    [InlineData("30m")]
    [InlineData("45s")]
    [InlineData("1.5ms")]
    public void Timespan_is_emitted_as_written(string value)
    {
        Assert.Equal($"print x = ago({value})", Apply("print x = ago({t})", Value("t", "timespan", value)).Text);
    }

    [Fact]
    public void Datetime_emits_datetime_literal()
    {
        Assert.Equal("print x = datetime(2026-10-01T00:00:00Z)", Apply("print x = {d}", Value("d", "datetime", "2026-10-01")).Text);
        Assert.Equal("print x = datetime(2026-10-21T08:30:00Z)",
            Apply("print x = {d}", Value("d", "datetime", "2026-10-21T08:30:00Z")).Text);
        Assert.Equal("print x = datetime(2026-10-21T06:30:00.125Z)",
            Apply("print x = {d}", Value("d", "datetime", "2026-10-21T08:30:00.125+02:00")).Text);
        Assert.Equal("print x = datetime(2026-10-21T08:30:00Z)", Apply("print x = {d}", Value("d", "datetime", "2026-10-21T08:30")).Text);
    }

    [Theory]
    [InlineData("2026-10-01) | take 1")]
    [InlineData("2026-10-01 | take 1")]
    [InlineData("2026-10-01\n| take 1")]
    [InlineData("2026-02-30")]
    [InlineData("10/21/2026")]
    [InlineData("Oct 21 2026")]
    [InlineData("2026-10-21T08:30:00Zjunk")]
    [InlineData("now")]
    public void Datetime_rejects_anything_but_iso_8601(string value)
    {
        var result = Apply("print x = {d}", Value("d", "datetime", value));

        Assert.Null(result.Text);
        Assert.Equal(new ParameterError("d", "d: a date like 2026-10-21 or 2026-10-21T08:30:00Z."), result.Error);
    }

    [Fact]
    public void List_after_in_is_tuple_otherwise_dynamic()
    {
        var names = Value("names", "list", "alpha\nbeta\n");

        Assert.Equal("applications | where displayName in (\"alpha\", \"beta\")",
            Apply("applications | where displayName in {names}", names).Text);
        Assert.Equal("applications | where displayName !in~ (\"alpha\", \"beta\")",
            Apply("applications | where displayName !in~ {names}", names).Text);
        Assert.Equal("applications | where displayName in~ ( \"alpha\", \"beta\" )",
            Apply("applications | where displayName in~ ( {names} )", names).Text);
        Assert.Equal("applications | extend x = dynamic([\"alpha\", \"beta\"])", Apply("applications | extend x = {names}", names).Text);
        Assert.Equal("applications | where displayName in (\"c\", dynamic([\"alpha\", \"beta\"]))",
            Apply("applications | where displayName in (\"c\", {names})", names).Text);
        Assert.Equal("print x = strcat_array(dynamic([\"alpha\", \"beta\"]), \",\")", Apply("print x = strcat_array({names}, \",\")", names).Text);
    }

    [Fact]
    public void List_of_numbers_is_numbers_and_empty_list_is_empty()
    {
        Assert.Equal("print x = 1 in (1, -2, 2.5)", Apply("print x = 1 in {n}", Value("n", "list", "1\r\n-2\n 2.5 ")).Text);
        Assert.Equal("print x = dynamic([\"1\", \"b\"])", Apply("print x = {n}", Value("n", "list", "1\nb")).Text);
        Assert.Equal("print x = 1 in (dynamic([]))", Apply("print x = 1 in {n}", Value("n", "list", "\n")).Text);
        Assert.Equal("print x = 1 in (dynamic([]))", Apply("print x = 1 in ({n})", Value("n", "list", "")).Text);
    }

    [Theory]
    [InlineData("a\"\nb\") | take 1 //")]
    [InlineData("\"), (\"x\nz")]
    [InlineData("a\\\nb'c")]
    public void Hostile_list_values_are_literals_only(string value)
    {
        foreach (var template in new[] { "applications | project displayName | where displayName in {v}", "applications | project displayName | where set_has_element({v}, displayName)" })
        {
            AssertSameStructure(template, Value("v", "list", value), Value("v", "list", "p\nq"));
            var text = Apply(template, Value("v", "list", value)).Text!;
            Assert.Equal(value.Split('\n').Select(v => v.Trim()), Literals(text).Where(l => l.Kind == SyntaxKind.StringLiteralExpression)
                .Select(l => (string?)l.LiteralValue));
        }
    }

    [Fact]
    public void Empty_optional_values_are_typed_nulls()
    {
        var result = Apply("print a = {t}, b = {n}, c = {s}, d = {w}",
            Value("t", "text", ""), Value("n", "number", ""), Value("s", "timespan", " "), Value("w", "datetime", ""));

        Assert.Equal("print a = \"\", b = long(null), c = timespan(null), d = datetime(null)", result.Text);
        Assert.DoesNotContain(KustoCode.ParseAndAnalyze(result.Text!).GetDiagnostics(), d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void Missing_required_names_it()
    {
        var result = Apply("print a = {late}, b = {early}, c = {early}",
            Value("early", "text", "x", required: true), Value("late", "number", " ", required: true), Value("other", "text", "", required: true));

        Assert.Null(result.Text);
        Assert.Null(result.Error);
        Assert.Equal("late", result.Missing);
    }

    [Fact]
    public void Missing_comes_before_a_bad_value()
    {
        var result = Apply("print a = {bad}, b = {missing}", Value("bad", "number", "x"), Value("missing", "text", "", required: true));

        Assert.Equal("missing", result.Missing);
        Assert.Null(result.Error);
    }

    [Fact]
    public void Unknown_type_is_an_error_and_unknown_placeholder_is_kept()
    {
        Assert.Equal(new ParameterError("v", "v: unknown parameter type html."), Apply("print {v}", Value("v", "html", "x")).Error);
        Assert.Equal("print {nobody}, \"x\"", Apply("print {nobody}, {v}", Value("v", "text", "x")).Text);
    }

    [Fact]
    public void Values_are_not_substituted_again()
    {
        Assert.Equal("print \"{b}\", \"x\"", Apply("print {a}, {b}", Value("a", "text", "{b}"), Value("b", "text", "x")).Text);
    }

    [Fact]
    public void Error_position_maps_back_to_original()
    {
        const string kql = "applications | where displayName == {name} | wher x";
        var result = Apply(kql, Value("name", "text", new string('a', 200)));
        var plan = GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, result.Text!, DateTimeOffset.UnixEpoch);
        Assert.NotNull(plan.Error);
        Assert.True(plan.Error.Column > 200);

        Assert.Equal((1, kql.IndexOf("wher x", StringComparison.Ordinal) + 1), result.MapBack(plan.Error.Line, plan.Error.Column));
    }

    [Fact]
    public void Error_position_maps_back_across_lines()
    {
        const string kql = "applications\n| where displayName in ({names}) and notes == {t} | project id\n| wher x";
        var result = Apply(kql, Value("names", "list", "alpha\nbeta\ngamma"), Value("t", "text", "one\ntwo\r\nthree"));
        Assert.Equal(3, result.Text!.Split('\n').Length);
        var plan = GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, result.Text, DateTimeOffset.UnixEpoch);
        Assert.NotNull(plan.Error);

        Assert.Equal((3, 3), result.MapBack(plan.Error.Line, plan.Error.Column));
        // After a value on its line, a column moves back by what the value added; inside a value it is the placeholder.
        var line2 = result.Text.Split('\n')[1];
        Assert.Equal((2, kql.Split('\n')[1].IndexOf("| project", StringComparison.Ordinal) + 1),
            result.MapBack(2, line2.IndexOf("| project", StringComparison.Ordinal) + 1));
        Assert.Equal((2, kql.Split('\n')[1].IndexOf("{t}", StringComparison.Ordinal) + 1),
            result.MapBack(2, line2.IndexOf("two", StringComparison.Ordinal) + 1));
        Assert.Equal((1, 3), result.MapBack(1, 3));
    }

    [Fact]
    public void Map_back_without_substitutions_is_identity()
    {
        var result = Apply("print 1\n| take 1");

        Assert.Equal("print 1\n| take 1", result.Text);
        Assert.Equal((2, 4), result.MapBack(2, 4));
    }

    public static TheoryData<string> RawLiteralPrefixes =>
        ["long", "int", "int64", "real", "double", "decimal", "bool", "date", "datetime", "time", "timespan", "guid"];

    [Theory]
    [MemberData(nameof(RawLiteralPrefixes))]
    public void Placeholder_inside_a_raw_literal_is_refused_never_substituted(string prefix)
    {
        var template = $"applications | project displayName | where displayName == {prefix}({{v}}) | take 5";
        var hostile = new[]
        {
            Value("v", "text", "x), y = 1 //"),
            Value("v", "text", "x) | take 1 //"),
            Value("v", "list", "a\"\nb), y = (1"),
            Value("v", "datetime", "2026-10-01"),
            Value("v", "number", "5"),
        };

        Assert.Empty(ParameterSubstitution.Find(template));
        foreach (var value in hostile)
        {
            var result = Apply(template, value);
            Assert.Null(result.Text);
            Assert.Equal(new ParameterError("v", "v: the value doesn't fit where the placeholder is."), result.Error);
        }
    }

    [Theory]
    [MemberData(nameof(RawLiteralPrefixes))]
    public void Raw_literal_beside_a_placeholder_leaves_the_value_one_literal(string prefix)
    {
        // The raw literal ends at its own ')': the placeholder after it is a placeholder, and its value stays one literal.
        var template = $"applications | project displayName | where displayName == strcat(tostring({prefix}(null)), {{v}}) | take 5";

        Assert.Equal(["v"], ParameterSubstitution.Find(template));
        AssertSameStructure(template, Value("v", "text", "x), y = 1 //"), Value("v", "text", "x"));
        AssertSameStructure(template, Value("v", "text", "x) | take 1 //"), Value("v", "text", "x"));
    }

    [Fact]
    public void Datetime_value_inside_datetime_is_a_clear_error()
    {
        var result = Apply("applications | where createdDateTime > datetime({start})", Value("start", "datetime", "2026-10-01"));

        Assert.Null(result.Text);
        Assert.Equal(new ParameterError("start", "start: the value doesn't fit where the placeholder is."), result.Error);
    }

    [Theory]
    [InlineData("print x = ~~~{v}~~~")]
    [InlineData("print x = ~~~a\n{v}\n~~~")]
    [InlineData("print x = guid(\"), y = \"{v}\"")]
    [InlineData("print x = bool(\"), y = \"{v}\"")]
    [InlineData("print x = h'{v}'")]
    [InlineData("print x = 1 // \"{v}\"")]
    public void Placeholder_inside_a_string_kusto_lexes_is_left_as_written(string template)
    {
        Assert.Empty(ParameterSubstitution.Find(template));
        var result = Apply(template, Value("v", "text", "~~~, y = 1 //\", z = 1 //"));

        Assert.Equal(template, result.Text);
    }

    [Fact]
    public void Placeholder_named_like_a_keyword_is_a_placeholder()
    {
        Assert.Equal(["where", "limit"], ParameterSubstitution.Find("print {where}, {limit}"));
        Assert.Equal("print \"a\"", Apply("print {where}", Value("where", "text", "a")).Text);
    }

    [Fact]
    public void Fits_needs_exactly_the_literal_tokens_the_value_was_written_as()
    {
        static ParameterSubstitution.Segment At(string text, string literal, ParameterSubstitution.Form form = ParameterSubstitution.Form.Scalar,
            int items = 1)
        {
            var start = text.IndexOf(literal, StringComparison.Ordinal);
            return new ParameterSubstitution.Segment("v", 0, 0, start, literal.Length, start, literal.Length, new(form, items));
        }

        Assert.True(ParameterSubstitution.Fits("print x = \"a\"", At("print x = \"a\"", "\"a\"")));
        Assert.True(ParameterSubstitution.Fits("print x = long(-7)", At("print x = long(-7)", "long(-7)")));
        // Swallowed by a raw literal, cut short by a verbatim string, or not one token.
        Assert.False(ParameterSubstitution.Fits("print x = bool(\"a\")", At("print x = bool(\"a\")", "\"a\"")));
        Assert.False(ParameterSubstitution.Fits("print x = @\"a\\\" or 1==1 //\"", At("print x = @\"a\\\" or 1==1 //\"", "\"a\\\" or 1==1 //\"")));
        Assert.False(ParameterSubstitution.Fits("print x = -7", At("print x = -7", "-7")));
        Assert.False(ParameterSubstitution.Fits("print x = a", At("print x = a", "a")));
        // Lists: only literals and commas, in the form they were written.
        const string tuple = "print 1 in (\"a\", -2)";
        Assert.True(ParameterSubstitution.Fits(tuple, At(tuple, "(\"a\", -2)", ParameterSubstitution.Form.Tuple, 2)));
        Assert.False(ParameterSubstitution.Fits(tuple, At(tuple, "(\"a\", -2)", ParameterSubstitution.Form.Tuple, 1)));
        const string injected = "print 1 in (\"a\", y)";
        Assert.False(ParameterSubstitution.Fits(injected, At(injected, "(\"a\", y)", ParameterSubstitution.Form.Tuple, 2)));
        const string dynamic = "print dynamic([\"a\", 1])";
        Assert.True(ParameterSubstitution.Fits(dynamic, At(dynamic, "dynamic([\"a\", 1])", ParameterSubstitution.Form.Dynamic, 2)));
    }

    /// <summary>The literal expressions of <paramref name="kql"/>'s parse.</summary>
    private static List<LiteralExpression> Literals(string kql) => KustoCode.Parse(kql).Syntax.GetDescendants<LiteralExpression>().ToList();

    /// <summary>Substituting <paramref name="hostile"/> gives the same syntax tree, node for node, as substituting
    /// <paramref name="benign"/>, with no syntax errors: the value only ever fills in literals.</summary>
    private static void AssertSameStructure(string template, ParameterValue hostile, ParameterValue benign)
    {
        var hostileResult = Apply(template, hostile);
        Assert.Null(hostileResult.Error);
        var hostileCode = KustoCode.Parse(hostileResult.Text!);
        var benignCode = KustoCode.Parse(Apply(template, benign).Text!);

        Assert.Empty(hostileCode.GetDiagnostics());
        Assert.Equal(Kinds(benignCode), Kinds(hostileCode));
    }

    private static List<SyntaxKind> Kinds(KustoCode code) => code.Syntax.GetDescendants<SyntaxNode>().Select(n => n.Kind).ToList();
}
