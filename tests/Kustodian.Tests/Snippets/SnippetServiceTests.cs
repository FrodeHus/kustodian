using Kustodian.Graph.Query;
using Kustodian.Graph.Schema;
using Kustodian.Library;
using Kustodian.Snippets;
using Kustodian.Storage;

namespace Kustodian.Tests.Snippets;

public sealed class SnippetServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private SnippetService NewService() => new(new JsonFileStore(_dir));

    [Fact]
    public async Task Builtin_graph_snippets_all_plan_without_error()
    {
        var snippets = (await NewService().ListAsync(Ct)).Where(s => s.BuiltIn && s.Source == "graph").ToList();

        Assert.Equal(4, snippets.Count);
        Assert.All(snippets, s => Assert.Equal("Identity checks", s.Group));
        foreach (var snippet in snippets)
        {
            // Each placeholder is declared, and each takes its declared default.
            Assert.Equal(ParameterSubstitution.Find(snippet.Text).Order(), snippet.Parameters.Select(p => p.Name).Order());
            var substituted = ParameterSubstitution.Apply(snippet.Text,
                snippet.Parameters.Select(p => new ParameterValue(p.Name, p.Type, p.Value, p.Required)).ToList());
            Assert.True(substituted.Text is not null, $"{snippet.Name}: {substituted.Missing}{substituted.Error?.Message}");

            var plan = GraphQueryPlanner.Plan(GraphSchemaCatalog.Beta, substituted.Text, DateTimeOffset.UnixEpoch);

            Assert.True(plan.Error is null && plan.Refusal is null, $"{snippet.Name}: {plan.Error?.Message}{plan.Refusal}");
        }
    }

    [Fact]
    public async Task Builtin_snippets_are_listed_first_and_have_stable_guid_ids()
    {
        var service = NewService();
        await service.SaveAsync(new SnippetInput(null, "graph", "Aardvark", "", "users", null, []), Ct);

        var listed = await service.ListAsync(Ct);

        Assert.True(listed[0].BuiltIn);
        Assert.False(listed[^1].BuiltIn);
        Assert.All(listed.Where(s => s.BuiltIn), s => Assert.True(Guid.TryParseExact(s.Id, "D", out _)));
        Assert.Equal(listed.Where(s => s.BuiltIn).Select(s => s.Id), (await NewService().ListAsync(Ct)).Where(s => s.BuiltIn).Select(s => s.Id));
    }

    [Fact]
    public async Task Builtin_snippet_cannot_be_deleted()
    {
        var service = NewService();
        var builtIn = (await service.ListAsync(Ct)).First(s => s.BuiltIn);

        await Assert.ThrowsAsync<SnippetRejectedException>(() => service.DeleteAsync(builtIn.Id, Ct));
        await Assert.ThrowsAsync<SnippetRejectedException>(() =>
            service.SaveAsync(new SnippetInput(builtIn.Id, "graph", "Mine", "", "users", null, []), Ct));

        Assert.Contains(await service.ListAsync(Ct), s => s.Id == builtIn.Id);
    }

    [Fact]
    public async Task User_snippet_round_trip()
    {
        var parameters = new[] { new ParameterDef("days", "timespan", "90d", false, ["30d", "90d"]) };
        var saved = await NewService().SaveAsync(
            new SnippetInput(null, "graph", "Mine", "Mine desc", "users | where createdDateTime < ago({days})", "Mine group", parameters), Ct);

        Assert.True(Guid.TryParseExact(saved.Id, "D", out _));
        Assert.False(saved.BuiltIn);
        Assert.True(File.Exists(Path.Combine(_dir, "snippets", saved.Id + ".json")));

        var listed = (await NewService().ListAsync(Ct)).Single(s => s.Id == saved.Id);
        Assert.Equal("Mine", listed.Name);
        Assert.Equal("Mine desc", listed.Description);
        Assert.Equal("Mine group", listed.Group);
        Assert.Equal("graph", listed.Source);
        Assert.Equal(new ParameterDef("days", "timespan", "90d", false, ["30d", "90d"]), listed.Parameters.Single(), ParameterComparer.Instance);

        var updated = await NewService().SaveAsync(new SnippetInput(saved.Id, "graph", "Renamed", "", "groups", null, []), Ct);
        Assert.Equal(saved.Id, updated.Id);
        Assert.Equal("Renamed", (await NewService().ListAsync(Ct)).Single(s => !s.BuiltIn).Name);

        await NewService().DeleteAsync(saved.Id, Ct);
        Assert.DoesNotContain(await NewService().ListAsync(Ct), s => s.Id == saved.Id);
    }

    [Fact]
    public async Task Unreadable_snippet_file_is_moved_aside_and_others_are_listed()
    {
        var service = NewService();
        var good = await service.SaveAsync(new SnippetInput(null, "graph", "Good", "", "users", null, []), Ct);
        var bad = Path.Combine(_dir, "snippets", Guid.NewGuid().ToString("D") + ".json");
        await File.WriteAllTextAsync(bad, "{ nope", Ct);

        var listed = await service.ListAsync(Ct);

        Assert.Contains(listed, s => s.Id == good.Id);
        Assert.False(File.Exists(bad));
    }

    [Fact]
    public async Task Invalid_snippet_is_rejected_and_nothing_is_written()
    {
        await Assert.ThrowsAsync<SnippetRejectedException>(() =>
            NewService().SaveAsync(new SnippetInput(null, "graph", " ", "", "users", null, []), Ct));
        await Assert.ThrowsAsync<SnippetRejectedException>(() =>
            NewService().SaveAsync(new SnippetInput("not-a-guid", "graph", "x", "", "users", null, []), Ct));

        Assert.False(Directory.Exists(Path.Combine(_dir, "snippets")) && Directory.GetFiles(Path.Combine(_dir, "snippets")).Length > 0);
    }
}
