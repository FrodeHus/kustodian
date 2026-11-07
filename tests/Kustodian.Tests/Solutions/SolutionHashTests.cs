using System.Text.Json.Nodes;
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
}
