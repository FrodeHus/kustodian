using Kustodian.Graph.Run;
using Kustodian.Library;
using Kustodian.Storage;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Library;

public sealed class LibraryServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero));
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private LibraryService NewService() => new(new JsonFileStore(_dir), _time);

    private string SavedDir => Path.Combine(_dir, "saved");

    private static SavedQueryInput Input(string name = "Stale apps", string? folder = null, string? id = null,
        IReadOnlyList<ParameterDef>? parameters = null) =>
        new(id, name, folder, "graph", "applications | take 5", parameters ?? []);

    [Fact]
    public async Task Options_round_trip_through_recent_library_and_session()
    {
        var service = NewService();
        var scope = new ArgScope("managementGroup", ["contoso-root"]);
        var arg = await service.SaveAsync(Input(name: "Arg") with { Source = "arg", Options = new QueryOptions(null, scope) }, Ct);
        var hunting = await service.SaveAsync(Input(name: "Hunting") with { Source = "hunting", Options = new QueryOptions("P30D", null) }, Ct);
        var graph = await service.SaveAsync(Input(name: "Graph"), Ct);

        var listed = (await NewService().ListAsync(Ct)).Queries.ToDictionary(q => q.Id);

        Assert.Equal("managementGroup", arg.Options?.Scope?.Kind);
        Assert.Equal("managementGroup", listed[arg.Id].Options?.Scope?.Kind);
        Assert.Equal(["contoso-root"], listed[arg.Id].Options?.Scope?.Ids);
        Assert.Equal("P30D", listed[hunting.Id].Options?.Timespan);
        Assert.Null(listed[graph.Id].Options);
    }

    [Fact]
    public async Task Old_files_without_options_load_with_null_options()
    {
        const string id = "22222222-2222-2222-2222-222222222222";
        Directory.CreateDirectory(SavedDir);
        await File.WriteAllTextAsync(Path.Combine(SavedDir, id + ".json"),
            $$"""{"version":1,"id":"{{id}}","name":"Old","folder":null,"source":"graph","text":"users","parameters":[],"createdAt":"2026-10-01T00:00:00Z","modifiedAt":"2026-10-01T00:00:00Z"}""",
            Ct);

        var list = await NewService().ListAsync(Ct);

        Assert.Equal(0, list.Skipped);
        Assert.Null(Assert.Single(list.Queries).Options);
        Assert.Null(Assert.Single(list.Queries).Origin);
    }

    [Fact]
    public async Task Origin_survives_a_plain_save_and_the_internal_save_clears_it()
    {
        var service = NewService();
        var origin = new SolutionOrigin("entra-risky-users", "1.0.0", "risky-users", "up", "content");
        var saved = await service.SaveAsync(Input(), origin, Ct);

        await service.SaveAsync(Input(id: saved.Id, name: "Renamed"), Ct);

        var listed = Assert.Single((await NewService().ListAsync(Ct)).Queries);
        Assert.Equal("Renamed", listed.Name);
        Assert.Equal(origin, listed.Origin);

        await service.SaveAsync(Input(id: saved.Id), null, Ct);
        Assert.Null(Assert.Single((await NewService().ListAsync(Ct)).Queries).Origin);
    }

    [Fact]
    public void Input_with_partial_options_takes_defaults()
    {
        var node = System.Text.Json.Nodes.JsonNode.Parse("""{"name":"q","source":"arg","options":{"scope":{"kind":"subscriptions"}}}""");

        var input = LibraryService.ReadInput(node, JsonFileStore.Options);

        Assert.NotNull(input);
        Assert.Null(input.Options?.Timespan);
        Assert.Equal("subscriptions", input.Options?.Scope?.Kind);
        Assert.Empty(input.Options?.Scope?.Ids ?? ["missing"]);
    }

    [Fact]
    public async Task Save_creates_file_per_query_with_guid_name()
    {
        var saved = await NewService().SaveAsync(Input(parameters: [new ParameterDef("days", "number", "30", true, ["7", "30"])]), Ct);

        Assert.True(Guid.TryParseExact(saved.Id, "D", out _));
        var file = Path.Combine(SavedDir, saved.Id + ".json");
        Assert.True(File.Exists(file));
        Assert.Equal([file], Directory.GetFiles(SavedDir));
        Assert.Equal(1, saved.Version);
        Assert.Equal(_time.GetUtcNow(), saved.CreatedAt);
        Assert.Equal(saved.CreatedAt, saved.ModifiedAt);
        var listed = (await NewService().ListAsync(Ct)).Queries.Single();
        Assert.Equal("Stale apps", listed.Name);
        Assert.Equal("applications | take 5", listed.Text);
        Assert.Equal(new ParameterDef("days", "number", "30", true, ["7", "30"]), listed.Parameters.Single(), ParameterComparer.Instance);
    }

    [Fact]
    public async Task Save_update_keeps_created_and_bumps_modified()
    {
        var service = NewService();
        var created = await service.SaveAsync(Input(), Ct);
        _time.Advance(TimeSpan.FromHours(2));

        var updated = await service.SaveAsync(Input(name: "Renamed", id: created.Id), Ct);

        Assert.Equal(created.Id, updated.Id);
        Assert.Equal(created.CreatedAt, updated.CreatedAt);
        Assert.Equal(created.CreatedAt.AddHours(2), updated.ModifiedAt);
        var listed = await service.ListAsync(Ct);
        Assert.Equal("Renamed", listed.Queries.Single().Name);
        Assert.Equal(created.CreatedAt, listed.Queries.Single().CreatedAt);
        Assert.Single(Directory.GetFiles(SavedDir));
    }

    [Fact]
    public async Task Folder_with_slash_is_refused()
    {
        var service = NewService();

        var ex = await Assert.ThrowsAsync<LibraryRejectedException>(() => service.SaveAsync(Input(folder: "a/b"), Ct));

        Assert.Equal("The folder must be 1 to 80 characters and have no /.", ex.Message);
        Assert.False(Directory.Exists(SavedDir));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Empty_name_is_refused(string name)
    {
        await Assert.ThrowsAsync<LibraryRejectedException>(() => NewService().SaveAsync(Input(name: name), Ct));
        Assert.False(Directory.Exists(SavedDir));
    }

    [Fact]
    public async Task Name_folder_and_text_limits_are_enforced()
    {
        var service = NewService();

        await service.SaveAsync(Input(name: new string('n', 200), folder: new string('f', 80)) with { Text = new string('x', 1 << 20) }, Ct);
        await Assert.ThrowsAsync<LibraryRejectedException>(() => service.SaveAsync(Input(name: new string('n', 201)), Ct));
        await Assert.ThrowsAsync<LibraryRejectedException>(() => service.SaveAsync(Input(folder: new string('f', 81)), Ct));
        await Assert.ThrowsAsync<LibraryRejectedException>(() => service.SaveAsync(Input(folder: ""), Ct));
        await Assert.ThrowsAsync<LibraryRejectedException>(
            () => service.SaveAsync(Input() with { Text = new string('x', (1 << 20) + 1) }, Ct));
        Assert.Single(Directory.GetFiles(SavedDir));
    }

    [Fact]
    public async Task Parameter_type_must_be_known_and_id_must_be_a_guid()
    {
        var service = NewService();

        await Assert.ThrowsAsync<LibraryRejectedException>(
            () => service.SaveAsync(Input(parameters: [new ParameterDef("p", "bool", "", false, null)]), Ct));
        await Assert.ThrowsAsync<LibraryRejectedException>(() => service.SaveAsync(Input(id: "../evil"), Ct));
        await Assert.ThrowsAsync<LibraryRejectedException>(() => service.DeleteAsync("../evil", Ct));
    }

    [Fact]
    public async Task List_returns_folders_sorted_distinct()
    {
        var service = NewService();
        await service.SaveAsync(Input(name: "b", folder: "Zeta"), Ct);
        await service.SaveAsync(Input(name: "a", folder: "alpha"), Ct);
        await service.SaveAsync(Input(name: "c", folder: "Zeta"), Ct);
        await service.SaveAsync(Input(name: "d"), Ct);

        var listed = await service.ListAsync(Ct);

        Assert.Equal(["alpha", "Zeta"], listed.Folders);
        Assert.Equal(["a", "b", "c", "d"], listed.Queries.Select(q => q.Name));
        Assert.Equal(0, listed.Skipped);
    }

    [Fact]
    public async Task Library_skips_and_moves_aside_an_unreadable_query_file()
    {
        var service = NewService();
        await service.SaveAsync(Input(name: "one"), Ct);
        await service.SaveAsync(Input(name: "two"), Ct);
        var bad = Path.Combine(SavedDir, Guid.NewGuid().ToString("D") + ".json");
        await File.WriteAllTextAsync(bad, "{ not json", Ct);

        var listed = await service.ListAsync(Ct);

        Assert.Equal(["one", "two"], listed.Queries.Select(q => q.Name));
        Assert.Equal(1, listed.Skipped);
        Assert.True(File.Exists(bad + ".corrupt"));
        Assert.False(File.Exists(bad));
        Assert.Equal(0, (await service.ListAsync(Ct)).Skipped);
    }

    [Fact]
    public async Task Library_skips_a_file_of_the_wrong_shape_or_named_for_another_id()
    {
        var id = Guid.NewGuid().ToString("D");
        Directory.CreateDirectory(SavedDir);
        await File.WriteAllTextAsync(Path.Combine(SavedDir, id + ".json"), """{"version":1,"id":"other","name":"x"}""", Ct);
        var typed = Guid.NewGuid().ToString("D");
        await File.WriteAllTextAsync(Path.Combine(SavedDir, typed + ".json"), $$"""{"version":1,"id":"{{typed}}","name":5}""", Ct);

        var listed = await NewService().ListAsync(Ct);

        Assert.Empty(listed.Queries);
        Assert.Equal(2, listed.Skipped);
        Assert.True(File.Exists(Path.Combine(SavedDir, id + ".json.corrupt")));
        Assert.True(File.Exists(Path.Combine(SavedDir, typed + ".json.corrupt")));
    }

    [Fact]
    public async Task Saved_query_parameter_missing_fields_load_with_their_defaults()
    {
        var id = Guid.NewGuid().ToString("D");
        Directory.CreateDirectory(SavedDir);
        await File.WriteAllTextAsync(Path.Combine(SavedDir, id + ".json"), $$"""
            {"version":1,"id":"{{id}}","name":"Sparse","source":"graph","text":"users",
             "parameters":[{"name":"days","type":"number","value":"30"}, {"name":"who"}],
             "createdAt":"2026-10-01T00:00:00+00:00","modifiedAt":"2026-10-02T00:00:00+00:00"}
            """, Ct);

        var listed = await NewService().ListAsync(Ct);

        Assert.Equal(0, listed.Skipped);
        var query = listed.Queries.Single();
        Assert.Null(query.Folder);
        Assert.Equal(new ParameterDef("days", "number", "30", false, null), query.Parameters[0], ParameterComparer.Instance);
        Assert.Equal(new ParameterDef("who", "text", "", false, null), query.Parameters[1], ParameterComparer.Instance);
    }

    [Fact]
    public async Task Saved_query_missing_parameters_and_source_load_with_their_defaults()
    {
        var id = Guid.NewGuid().ToString("D");
        Directory.CreateDirectory(SavedDir);
        await File.WriteAllTextAsync(Path.Combine(SavedDir, id + ".json"), $$"""{"version":1,"id":"{{id}}","name":"Bare"}""", Ct);

        var query = (await NewService().ListAsync(Ct)).Queries.Single();

        Assert.Empty(query.Parameters);
        Assert.Equal("graph", query.Source);
        Assert.Equal("", query.Text);
    }

    [Fact]
    public async Task Delete_removes_file()
    {
        var service = NewService();
        var saved = await service.SaveAsync(Input(), Ct);

        await service.DeleteAsync(saved.Id, Ct);
        await service.DeleteAsync(saved.Id, Ct);

        Assert.Empty(Directory.GetFiles(SavedDir));
        Assert.Empty((await service.ListAsync(Ct)).Queries);
    }

    [Fact]
    public async Task Empty_library_lists_nothing_without_a_saved_folder()
    {
        var listed = await NewService().ListAsync(Ct);

        Assert.Empty(listed.Queries);
        Assert.Empty(listed.Folders);
        Assert.Equal(0, listed.Skipped);
    }

    private static HighlightRule Rule(string id = "r1", string column = "risk", string op = "==", string value = "high",
        string colour = "danger", string target = "row") => new(id, column, op, value, colour, target);

    [Fact]
    public async Task Highlights_round_trip()
    {
        HighlightRule[] rules = [Rule(), Rule("r2", "name", "isempty", "", "info", "cell")];
        var saved = await NewService().SaveAsync(Input() with { Highlights = rules }, Ct);

        var listed = Assert.Single((await NewService().ListAsync(Ct)).Queries);

        Assert.Equal(rules, saved.Highlights);
        Assert.Equal(rules, listed.Highlights);
    }

    [Fact]
    public async Task Old_files_without_highlights_load_with_none_and_save_back_without_an_array()
    {
        const string id = "33333333-3333-3333-3333-333333333333";
        Directory.CreateDirectory(SavedDir);
        var path = Path.Combine(SavedDir, id + ".json");
        await File.WriteAllTextAsync(path,
            $$"""{"version":1,"id":"{{id}}","name":"Old","folder":null,"source":"graph","text":"users","parameters":[],"createdAt":"2026-10-01T00:00:00Z","modifiedAt":"2026-10-01T00:00:00Z"}""",
            Ct);

        var old = Assert.Single((await NewService().ListAsync(Ct)).Queries);
        Assert.Null(old.Highlights);
        await NewService().SaveAsync(new SavedQueryInput(old.Id, old.Name, old.Folder, old.Source, old.Text, old.Parameters, old.Options, old.Highlights), Ct);

        var written = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(path, Ct))!.AsObject();
        Assert.True(!written.ContainsKey("highlights") || written["highlights"] is null);
    }

    public static TheoryData<string, HighlightRule?[]> BadHighlights => new()
    {
        { "op", [Rule(op: "like")] },
        { "colour", [Rule(colour: "red")] },
        { "target", [Rule(target: "column")] },
        { "count", Enumerable.Range(0, 21).Select(i => (HighlightRule?)Rule("r" + i)).ToArray() },
        { "column", [Rule(column: " ")] },
        { "value", [Rule(value: new string('v', 1001))] },
        { "null item", [null] },
        { "null value", [Rule() with { Value = null! }] },
        { "null id", [Rule() with { Id = null! }] },
    };

    [Theory]
    [MemberData(nameof(BadHighlights))]
    public async Task Bad_highlights_are_refused(string why, HighlightRule?[] rules)
    {
        var ex = await Assert.ThrowsAsync<LibraryRejectedException>(
            () => NewService().SaveAsync(Input() with { Highlights = rules! }, Ct));

        Assert.StartsWith("The highlight rules", ex.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(SavedDir), why);
    }

    [Fact]
    public async Task Twenty_highlights_and_a_value_of_1000_characters_are_allowed()
    {
        var rules = Enumerable.Range(0, 20).Select(i => Rule("r" + i, value: new string('v', 1000))).ToList();

        var saved = await NewService().SaveAsync(Input() with { Highlights = rules }, Ct);

        Assert.Equal(20, saved.Highlights?.Count);
    }
}
