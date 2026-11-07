using System.Text.Json.Nodes;
using Kustodian.Storage;
using Kustodian.Workbooks;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.Workbooks;

public sealed class WorkbookServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 8, 0, 0, TimeSpan.Zero));
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private WorkbookService NewService() => new(new JsonFileStore(_dir), _time);

    private string WorkbooksDir => Path.Combine(_dir, WorkbookService.Folder);

    private static JsonObject Doc(string? id = null, string name = "VM hygiene", string? folder = null) => new()
    {
        ["kind"] = "kustodian.workbook",
        ["version"] = 1,
        ["id"] = id ?? Guid.NewGuid().ToString("D"),
        ["name"] = name,
        ["folder"] = folder,
        ["parameters"] = new JsonArray(),
        ["widgets"] = new JsonArray(),
    };

    private string[] Files(string pattern) =>
        Directory.Exists(WorkbooksDir) ? Directory.GetFiles(WorkbooksDir, pattern) : [];

    [Fact]
    public async Task Save_then_get_round_trips_the_document_and_sets_modifiedAt()
    {
        var service = NewService();
        var doc = Doc();

        var saved = await service.SaveAsync(doc, Ct);
        var read = await NewService().GetAsync(doc["id"]!.GetValue<string>(), Ct);

        Assert.NotNull(read);
        Assert.Equal(_time.GetUtcNow(), DateTimeOffset.Parse(read["modifiedAt"]!.GetValue<string>()));
        Assert.Equal(saved["modifiedAt"]!.GetValue<string>(), read["modifiedAt"]!.GetValue<string>());
        foreach (var (key, value) in doc)
        {
            Assert.Equal(value?.ToJsonString(), read[key]?.ToJsonString());
        }
    }

    [Fact]
    public async Task Save_keeps_fields_it_does_not_know()
    {
        var doc = Doc();
        doc["x-note"] = "keep me";
        doc["widgets"] = new JsonArray(new JsonObject { ["chart"] = new JsonObject { ["stack"] = "percent" } });

        await NewService().SaveAsync(doc, Ct);
        var read = await NewService().GetAsync(doc["id"]!.GetValue<string>(), Ct);

        Assert.Equal("keep me", read!["x-note"]!.GetValue<string>());
        Assert.Equal("percent", read["widgets"]![0]!["chart"]!["stack"]!.GetValue<string>());
    }

    public static TheoryData<string, string?> Refusals() => new()
    {
        { "kind", "This isn't a Kustodian workbook." },
        { "version", "This workbook needs a newer Kustodian." },
        { "id", null },
        { "name-empty", null },
        { "name-long", null },
        { "folder-slash", null },
        { "folder-empty", null },
        { "folder-long", null },
        { "widgets-missing", null },
        { "widgets-not-array", null },
        { "widgets-101", null },
        { "too-big", null },
    };

    [Theory]
    [MemberData(nameof(Refusals))]
    public async Task Save_refuses(string what, string? message)
    {
        var doc = Doc();
        switch (what)
        {
            case "kind": doc["kind"] = "other"; break;
            case "version": doc["version"] = 2; break;
            case "id": doc["id"] = "not-a-guid"; break;
            case "name-empty": doc["name"] = ""; break;
            case "name-long": doc["name"] = new string('n', 201); break;
            case "folder-slash": doc["folder"] = "a/b"; break;
            case "folder-empty": doc["folder"] = ""; break;
            case "folder-long": doc["folder"] = new string('f', 81); break;
            case "widgets-missing": doc.Remove("widgets"); break;
            case "widgets-not-array": doc["widgets"] = "x"; break;
            case "widgets-101": doc["widgets"] = new JsonArray(Enumerable.Range(0, 101).Select(_ => (JsonNode?)new JsonObject()).ToArray()); break;
            case "too-big": doc["x-pad"] = new string('p', WorkbookService.MaxBytes); break;
        }

        var ex = await Assert.ThrowsAsync<WorkbookRejectedException>(() => NewService().SaveAsync(doc, Ct));

        if (message is not null)
        {
            Assert.Equal(message, ex.Message);
        }

        Assert.False(Directory.Exists(WorkbooksDir) && Directory.EnumerateFileSystemEntries(WorkbooksDir).Any());
    }

    [Fact]
    public void Check_accepts_a_valid_workbook_and_writes_nothing()
    {
        Assert.Null(WorkbookService.Check(Doc()));
        Assert.False(Directory.Exists(WorkbooksDir));
    }

    [Theory]
    [InlineData("kind")]
    [InlineData("version")]
    [InlineData("id")]
    [InlineData("name-empty")]
    [InlineData("name-long")]
    [InlineData("folder-slash")]
    [InlineData("widgets-101")]
    public async Task Check_refuses_what_save_refuses(string what)
    {
        var doc = Doc();
        switch (what)
        {
            case "kind": doc["kind"] = "x"; break;
            case "version": doc["version"] = 2; break;
            case "id": doc["id"] = "abc"; break;
            case "name-empty": doc["name"] = ""; break;
            case "name-long": doc["name"] = new string('n', 201); break;
            case "folder-slash": doc["folder"] = "a/b"; break;
            case "widgets-101": doc["widgets"] = new JsonArray(Enumerable.Range(0, 101).Select(_ => (JsonNode?)new JsonObject()).ToArray()); break;
        }

        var ex = await Assert.ThrowsAsync<WorkbookRejectedException>(() => NewService().SaveAsync(doc, Ct));

        Assert.Equal(ex.Message, WorkbookService.Check(doc));
    }

    [Fact]
    public void Check_refuses_a_workbook_over_2_MB()
    {
        var doc = Doc();
        doc["widgets"] = new JsonArray(new JsonObject { ["type"] = "markdown", ["text"] = new string('p', WorkbookService.MaxBytes) });

        Assert.Equal("The workbook can be at most 2 MB.", WorkbookService.Check(doc));
    }

    [Fact]
    public async Task List_returns_summaries_sorted_by_name_then_id_and_distinct_folders()
    {
        var service = NewService();
        var b = Doc("bbbbbbbb-0000-0000-0000-000000000000", "Beta", "Ops");
        b["widgets"] = new JsonArray(new JsonObject(), new JsonObject());
        await service.SaveAsync(b, Ct);
        await service.SaveAsync(Doc("22222222-0000-0000-0000-000000000000", "alpha", "Ops"), Ct);
        await service.SaveAsync(Doc("11111111-0000-0000-0000-000000000000", "alpha", "Dev"), Ct);
        await service.SaveAsync(Doc("33333333-0000-0000-0000-000000000000", "Gamma"), Ct);

        var list = await NewService().ListAsync(Ct);

        Assert.Equal(0, list.Skipped);
        Assert.Equal(["11111111-0000-0000-0000-000000000000", "22222222-0000-0000-0000-000000000000",
            "bbbbbbbb-0000-0000-0000-000000000000", "33333333-0000-0000-0000-000000000000"], list.Workbooks.Select(w => w.Id));
        Assert.Equal(["Dev", "Ops"], list.Folders);
        Assert.Equal(2, list.Workbooks[2].Widgets);
        Assert.Null(list.Workbooks[3].Folder);
        Assert.Equal(_time.GetUtcNow(), list.Workbooks[0].ModifiedAt);
    }

    [Fact]
    public async Task List_moves_an_unreadable_file_aside_and_counts_it()
    {
        Directory.CreateDirectory(WorkbooksDir);
        const string bad = "44444444-0000-0000-0000-000000000000";
        const string other = "55555555-0000-0000-0000-000000000000";
        await File.WriteAllTextAsync(Path.Combine(WorkbooksDir, bad + ".json"), "not json", Ct);
        await File.WriteAllTextAsync(Path.Combine(WorkbooksDir, other + ".json"), Doc(bad).ToJsonString(), Ct);

        var list = await NewService().ListAsync(Ct);

        Assert.Equal(2, list.Skipped);
        Assert.Empty(list.Workbooks);
        Assert.Empty(Files("*.json"));
        Assert.Equal(2, Files("*.corrupt").Length);
    }

    [Fact]
    public async Task Delete_removes_the_workbook_and_its_values()
    {
        var service = NewService();
        var doc = Doc();
        var id = doc["id"]!.GetValue<string>();
        await service.SaveAsync(doc, Ct);
        await service.SaveValuesAsync(id, new JsonObject { ["a"] = 1 }, Ct);

        await service.DeleteAsync(id, Ct);

        Assert.Null(await service.GetAsync(id, Ct));
        Assert.Empty((await service.GetValuesAsync(id, Ct)));
        Assert.Empty(Directory.GetFiles(Path.Combine(_dir, WorkbookService.ValuesFolder)));
    }

    [Fact]
    public async Task Delete_of_a_missing_id_does_nothing() =>
        await NewService().DeleteAsync(Guid.NewGuid().ToString("D"), Ct);

    [Fact]
    public async Task Values_round_trip_and_default_to_empty()
    {
        var service = NewService();
        var id = Guid.NewGuid().ToString("D");

        Assert.Empty(await service.GetValuesAsync(id, Ct));

        await service.SaveValuesAsync(id, new JsonObject { ["Timerange"] = "P7D" }, Ct);

        Assert.Equal("P7D", (await NewService().GetValuesAsync(id, Ct))["Timerange"]!.GetValue<string>());
    }
}
