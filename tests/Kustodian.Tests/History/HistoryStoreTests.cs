using System.Text.Json;
using Kustodian.History;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Time.Testing;

namespace Kustodian.Tests.History;

public sealed class HistoryStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 8, 0, 0, TimeSpan.Zero));
    private readonly List<HistoryStore> _stores = [];
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly HistoryColumn[] Cols = [new("id", "string"), new("n", "long")];
    private static readonly HistorySetting Rows = new(HistoryMode.Rows, HistoryInterval.Day, 30, ["id"]);
    private static readonly HistorySetting Values = new(HistoryMode.Values, HistoryInterval.Day, 30, []);

    public void Dispose()
    {
        foreach (var store in _stores)
        {
            store.Dispose();
        }

        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private HistoryStore NewStore()
    {
        var store = new HistoryStore(_dir, _time);
        _stores.Add(store);
        return store;
    }

    private static HistoryQuery Query(string text = "T | take 5", params HistoryParameter[] parameters) =>
        new("graph", text, null, parameters);

    private static JsonElement[] Row(string id, long n = 1) =>
        [JsonSerializer.SerializeToElement(id), JsonSerializer.SerializeToElement(n)];

    private static RecordRequest Request(HistorySetting setting, IEnumerable<JsonElement[]> rows, HistoryQuery? query = null,
        string label = "all") =>
        new("wb", "w1", query ?? Query(), setting, label, Cols, [.. rows]);

    private static JsonElement[][] Ids(params string[] ids) => [.. ids.Select(i => Row(i))];

    private Task<RecordAnswer> Record(HistoryStore s, HistorySetting setting, params string[] ids) =>
        s.RecordAsync(Request(setting, Ids(ids)), Ct);

    private void NextDay() => _time.Advance(TimeSpan.FromDays(1));

    [Fact]
    public async Task values_mode_keeps_one_snapshot_per_day_the_latest_wins()
    {
        var s = NewStore();
        await s.RecordAsync(Request(Values, [Row("morning")]), Ct);
        _time.Advance(TimeSpan.FromHours(7));
        await s.RecordAsync(Request(Values, [Row("afternoon")]), Ct);
        NextDay();
        await s.RecordAsync(Request(Values, [Row("tomorrow")]), Ct);

        var answer = await s.ValuesAsync("wb", "w1", Query(), Values, Ct);

        Assert.Equal(2, answer.Snapshots.Count);
        Assert.Equal("afternoon", answer.Snapshots[0].Rows[0][0].GetString());
        Assert.Equal("tomorrow", answer.Snapshots[1].Rows[0][0].GetString());
        Assert.False(answer.Reset);
    }

    [Fact]
    public async Task values_mode_refuses_more_than_500_rows()
    {
        var s = NewStore();

        var answer = await s.RecordAsync(Request(Values, Enumerable.Range(0, 501).Select(i => Row("r" + i))), Ct);

        Assert.False(answer.Recorded);
        Assert.Equal("tooManyRows", answer.Skipped);
        Assert.Empty(await s.SeriesAsync("wb", "w1", Ct));
    }

    [Fact]
    public async Task rows_mode_marks_new_and_gone()
    {
        var s = NewStore();
        await Record(s, Rows, "A", "B");
        NextDay();
        await Record(s, Rows, "B", "C");

        var changes = await s.ChangesAsync("wb", "w1", Query(), Rows, "previous", Ct);

        Assert.Equal("C", Assert.Single(changes.New).Values[0].GetString());
        var gone = Assert.Single(changes.Gone);
        Assert.Equal("A", gone.Values[0].GetString());
        Assert.Equal(_time.GetUtcNow(), gone.Gone);
        Assert.Equal(2, changes.Open);
    }

    [Fact]
    public async Task a_key_that_returns_starts_a_new_first_seen()
    {
        var s = NewStore();
        await Record(s, Rows, "A");
        var day1 = _time.GetUtcNow();
        NextDay();
        await Record(s, Rows);
        var day2 = _time.GetUtcNow();
        NextDay();
        await Record(s, Rows, "A");

        var changes = await s.ChangesAsync("wb", "w1", Query(), Rows, day1.ToString("O"), Ct);

        var back = Assert.Single(changes.New);
        Assert.Equal(_time.GetUtcNow(), back.FirstSeen);
        Assert.Null(back.Gone);
        var old = Assert.Single(changes.Gone);
        Assert.Equal(day1, old.FirstSeen);
        Assert.Equal(day2, old.Gone);
        Assert.Equal(1, changes.Open);
    }

    [Fact]
    public async Task duplicate_keys_are_refused_and_nothing_changes()
    {
        var s = NewStore();
        await Record(s, Rows, "A", "B");
        NextDay();

        var answer = await Record(s, Rows, "A", "A");
        var changes = await s.ChangesAsync("wb", "w1", Query(), Rows, "previous", Ct);

        Assert.False(answer.Recorded);
        Assert.Equal("keysNotUnique", answer.Skipped);
        Assert.Equal(2, changes.Open);
        Assert.Empty(changes.Gone);
    }

    [Fact]
    public async Task rows_mode_applies_at_most_once_per_interval()
    {
        var s = NewStore();
        await Record(s, Rows, "A", "B");
        _time.Advance(TimeSpan.FromHours(2));

        var answer = await Record(s, Rows, "A");
        var changes = await s.ChangesAsync("wb", "w1", Query(), Rows, "previous", Ct);

        Assert.False(answer.Recorded);
        Assert.Equal("interval", answer.Skipped);
        Assert.Empty(changes.Gone);
        Assert.Equal(2, changes.Open);
    }

    [Fact]
    public async Task week_interval_follows_the_iso_week()
    {
        var weekly = Rows with { Interval = HistoryInterval.Week };
        var s = NewStore();
        await Record(s, weekly, "A"); // Friday 2026-11-06
        _time.Advance(TimeSpan.FromDays(2)); // Sunday, same ISO week
        Assert.Equal("interval", (await Record(s, weekly, "A")).Skipped);
        _time.Advance(TimeSpan.FromDays(1)); // Monday
        Assert.True((await Record(s, weekly, "A")).Recorded);
    }

    [Fact]
    public async Task changes_are_capped_at_5000_with_counts()
    {
        var s = NewStore();
        await s.RecordAsync(Request(Rows, Enumerable.Range(0, 6000).Select(i => Row("k" + i))), Ct);

        var changes = await s.ChangesAsync("wb", "w1", Query(), Rows, "previous", Ct);

        Assert.Equal(5000, changes.New.Count);
        Assert.Equal(6000, changes.NewCount);
        Assert.Equal(6000, changes.Open);
    }

    [Fact]
    public async Task retention_drops_old_snapshots_and_gone_keys()
    {
        var s = NewStore();
        await Record(s, Rows, "A");
        NextDay();
        await Record(s, Rows);
        _time.Advance(TimeSpan.FromDays(31));
        await Record(s, Rows);

        var changes = await s.ChangesAsync("wb", "w1", Query(), Rows, "2000-01-01T00:00:00Z", Ct);
        var info = Assert.Single(await s.SeriesAsync("wb", "w1", Ct));

        Assert.Empty(changes.Gone);
        Assert.Equal(1, info.Snapshots);

        var v = NewStore();
        await v.RecordAsync(Request(Values, [Row("old")], Query("V")), Ct);
        _time.Advance(TimeSpan.FromDays(31));
        await v.RecordAsync(Request(Values, [Row("new")], Query("V")), Ct);
        Assert.Single((await v.ValuesAsync("wb", "w1", Query("V"), Values, Ct)).Snapshots);
    }

    [Fact]
    public async Task a_different_query_key_drops_the_widgets_other_series()
    {
        var s = NewStore();
        await s.RecordAsync(Request(Rows, Ids("A"), Query("old")), Ct);
        await s.RecordAsync(Request(Rows, Ids("A"), Query("new"), "new"), Ct);

        var info = Assert.Single(await s.SeriesAsync("wb", "w1", Ct));

        Assert.Equal("new", info.Label);
    }

    [Fact]
    public async Task each_parameter_combination_is_its_own_series()
    {
        var s = NewStore();
        var critical = Query("T", new HistoryParameter("Severity", "Critical"));
        var high = Query("T", new HistoryParameter("Severity", "High"));
        await s.RecordAsync(Request(Rows, Ids("A"), critical, "Severity=Critical"), Ct);
        await s.RecordAsync(Request(Rows, Ids("A"), high, "Severity=High"), Ct);

        var series = await s.SeriesAsync("wb", "w1", Ct);

        Assert.Equal(["Severity=Critical", "Severity=High"], series.Select(x => x.Label).Order().ToArray());
    }

    [Fact]
    public async Task series_counts_gaps_in_daily_values()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 11, 1, 8, 0, 0, TimeSpan.Zero));
        using var s = new HistoryStore(_dir, clock);
        foreach (var advance in new[] { 0, 1, 3 })
        {
            clock.Advance(TimeSpan.FromDays(advance));
            await s.RecordAsync(Request(Values, [Row("x")]), Ct);
        }

        var info = Assert.Single(await s.SeriesAsync("wb", "w1", Ct));

        Assert.Equal(3, info.Snapshots);
        Assert.Equal(2, info.Gaps);
        Assert.Equal(3, info.Stored);
        Assert.Equal(new DateTimeOffset(2026, 11, 1, 8, 0, 0, TimeSpan.Zero), info.Since);
    }

    [Fact]
    public async Task clear_and_delete_workbook_remove_series()
    {
        var s = NewStore();
        await s.RecordAsync(Request(Rows, Ids("A")), Ct);
        await s.RecordAsync(new RecordRequest("wb", "w2", Query(), Rows, "l", Cols, Ids("A")), Ct);
        await s.RecordAsync(new RecordRequest("other", "w1", Query(), Rows, "l", Cols, Ids("A")), Ct);

        await s.ClearAsync("wb", "w1", Ct);
        Assert.Empty(await s.SeriesAsync("wb", "w1", Ct));
        Assert.Single(await s.SeriesAsync("wb", "w2", Ct));

        await s.DeleteWorkbookAsync("wb", Ct);
        Assert.Empty(await s.SeriesAsync("wb", "w2", Ct));
        Assert.Single(await s.SeriesAsync("other", "w1", Ct));
        Assert.Equal(0, (await s.ChangesAsync("wb", "w1", Query(), Rows, "previous", Ct)).Open);
    }

    [Fact]
    public async Task a_damaged_database_is_renamed_and_replaced()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllBytes(Path.Combine(_dir, "history.db"), new byte[4096].Select((_, i) => (byte)(i * 31 + 7)).ToArray());

        var first = await NewStore().RecordAsync(Request(Rows, Ids("A")), Ct);

        Assert.True(first.Recorded);
        Assert.True(first.Reset);
        Assert.True(File.Exists(Path.Combine(_dir, "history.db.damaged-20261106080000")));

        NextDay();
        var next = await NewStore().RecordAsync(Request(Rows, Ids("A")), Ct);
        Assert.False(next.Reset);
    }
}
