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

    /// <summary>Parameters compare by their fields, choices included.</summary>
    private sealed class ParameterComparer : IEqualityComparer<ParameterDef>
    {
        public static ParameterComparer Instance { get; } = new();

        public bool Equals(ParameterDef? x, ParameterDef? y) =>
            x is not null && y is not null && x.Name == y.Name && x.Type == y.Type && x.Value == y.Value && x.Required == y.Required
            && (x.Choices is null ? y.Choices is null : y.Choices is not null && x.Choices.SequenceEqual(y.Choices));

        public int GetHashCode(ParameterDef obj) => obj.Name.GetHashCode(StringComparison.Ordinal);
    }
}
