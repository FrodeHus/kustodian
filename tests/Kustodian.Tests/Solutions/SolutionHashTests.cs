using System.Text.Json.Nodes;
using Kustodian.Graph.Run;
using Kustodian.Library;
using Kustodian.Solutions;

namespace Kustodian.Tests.Solutions;

public sealed class SolutionHashTests
{
    [Fact]
    public void Canonical_sorts_keys_at_every_depth()
    {
        var node = JsonNode.Parse("""{"b":1,"a":[{"d":2,"c":3}]}""");
        Assert.Equal("""{"a":[{"c":3,"d":2}],"b":1}""", SolutionHash.Canonical(node));
    }

    [Fact]
    public void Sha256_is_lowercase_hex()
    {
        Assert.Equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            SolutionHash.Sha256("abc"u8));
    }

    [Fact]
    public void Query_ignores_identity_and_follows_text()
    {
        var a = new SavedQueryInput("1", "A", "f", "graph", "users | take 1", []);
        var b = new SavedQueryInput("2", "B", null, "graph", "users | take 1", []);
        Assert.Equal(SolutionHash.Query(a), SolutionHash.Query(b));
        Assert.NotEqual(SolutionHash.Query(a), SolutionHash.Query(a with { Text = "users | take 2" }));
    }

    [Fact]
    public void Query_follows_source_and_parameters()
    {
        var a = new SavedQueryInput("1", "A", null, "graph", "t", []);
        var hash = SolutionHash.Query(a);
        Assert.NotEqual(hash, SolutionHash.Query(a with { Source = "hunting" }));
        Assert.NotEqual(hash, SolutionHash.Query(a with { Parameters = [new ParameterDef("p", "string", "v", false, null)] }));
    }

    [Fact]
    public void Workbook_keeps_the_text_of_an_unlinked_widget()
    {
        static JsonObject Wb(string text) => JsonNode.Parse(
            """{"widgets":[{"query":{"saved":null,"text":"TEXT"}}]}""".Replace("TEXT", text))!.AsObject();
        Assert.NotEqual(SolutionHash.Workbook(Wb("a")), SolutionHash.Workbook(Wb("b")));
    }

    private static JsonObject Workbook(string name = "W", string layout = "1", string text = "t") =>
        JsonNode.Parse("""
        {"id":"w","name":"NAME","folder":"x","modifiedAt":"m","createdAt":"c","origin":{"a":1},
         "widgets":[{"layout":"LAYOUT","query":{"saved":"q","text":"TEXT","source":"graph","parameters":[],"options":{}}}]}
        """.Replace("NAME", name).Replace("LAYOUT", layout).Replace("TEXT", text))!.AsObject();

    [Fact]
    public void Workbook_ignores_identity_and_linked_copies_but_not_layout()
    {
        var hash = SolutionHash.Workbook(Workbook());
        Assert.Equal(hash, SolutionHash.Workbook(Workbook(name: "Other", text: "changed")));
        Assert.NotEqual(hash, SolutionHash.Workbook(Workbook(layout: "2")));
    }

    [Fact]
    public void Workbook_ignores_the_name_of_a_linked_query_but_not_its_id()
    {
        static JsonObject Wb(string id, string name) => JsonNode.Parse(
            """{"widgets":[{"query":{"saved":{"id":"ID","name":"NAME"}}}]}""".Replace("ID", id).Replace("NAME", name))!.AsObject();
        var hash = SolutionHash.Workbook(Wb("q1", "Risky users"));
        Assert.Equal(hash, SolutionHash.Workbook(Wb("q1", "Renamed")));
        Assert.NotEqual(hash, SolutionHash.Workbook(Wb("q2", "Risky users")));
    }

    private static readonly SavedQueryInput Pinned = new("1", "A", null, "graph", "users | take 1",
        [new ParameterDef("p", "text", "v", false, null)], new QueryOptions("P1D", null));

    [Fact]
    public void Query_without_highlights_hashes_as_before_highlights()
    {
        // Computed by the code before highlights existed: a query without rules must hash exactly as it did.
        const string before = "35973cae265fa9ce34098d98173a5610f5a0989de37706b2eb38d70c4291a1cd";
        Assert.Equal(before, SolutionHash.Query(Pinned));
        Assert.Equal(before, SolutionHash.Query(Pinned with { Highlights = [] }));
    }

    [Fact]
    public void Query_follows_highlights()
    {
        var hash = SolutionHash.Query(Pinned);
        var one = Pinned with { Highlights = [new HighlightRule("r1", "risk", "==", "high", "danger", "row")] };
        Assert.NotEqual(hash, SolutionHash.Query(one));
        Assert.NotEqual(SolutionHash.Query(one), SolutionHash.Query(one with { Highlights = [one.Highlights![0] with { Colour = "info" }] }));
    }

    [Fact]
    public void Workbook_ignores_the_highlights_copied_into_a_linked_widget_but_not_an_unlinked_one()
    {
        static JsonObject Wb(string saved, string highlights) => JsonNode.Parse(
            """{"widgets":[{"query":{"saved":SAVED,"text":"t","highlights":HL}}]}""".Replace("SAVED", saved).Replace("HL", highlights))!.AsObject();
        const string rule = """[{"id":"r1","column":"risk","op":"==","value":"high","colour":"danger","target":"row"}]""";
        Assert.Equal(SolutionHash.Workbook(Wb("""{"id":"q1"}""", "null")), SolutionHash.Workbook(Wb("""{"id":"q1"}""", rule)));
        Assert.NotEqual(SolutionHash.Workbook(Wb("null", "null")), SolutionHash.Workbook(Wb("null", rule)));
    }
}
