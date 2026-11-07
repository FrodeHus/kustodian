using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.History;

public sealed record HistoryColumn(string Name, string Type);

public sealed record RecordRequest(string WorkbookId, string WidgetId, HistoryQuery Query, HistorySetting Setting, string Label,
    IReadOnlyList<HistoryColumn> Columns, IReadOnlyList<JsonElement[]> Rows);

/// <summary><see cref="Skipped"/> is "interval", "tooManyRows" or "keysNotUnique" when nothing was recorded.</summary>
public sealed record RecordAnswer(bool Recorded, string? Skipped, bool Reset);

public sealed record Snapshot(DateTimeOffset TakenAt, IReadOnlyList<HistoryColumn> Columns, IReadOnlyList<JsonElement[]> Rows);

public sealed record ValuesAnswer(IReadOnlyList<Snapshot> Snapshots, bool Reset);

public sealed record TrackedRow(JsonElement[] Values, DateTimeOffset FirstSeen, DateTimeOffset? Gone);

public sealed record ChangesAnswer(DateTimeOffset? Since, IReadOnlyList<HistoryColumn> Columns, IReadOnlyList<TrackedRow> New,
    int NewCount, IReadOnlyList<TrackedRow> Gone, int GoneCount, int Open, bool Reset);

/// <summary>Stored is the snapshot count in Values mode and the tracked key rows in Rows mode.</summary>
public sealed record SeriesInfo(string Label, DateTimeOffset Since, int Snapshots, int Gaps, int Stored);

/// <summary>
/// Per-widget result history in one SQLite file, <c>history.db</c>. A series is one workbook, widget and parameter combination.
/// Values mode keeps whole results as snapshots; Rows mode keeps key rows with first seen and gone times. Local only: nothing
/// here is exported, reported or logged. A file that is corrupt, not a database or fails its check is moved aside and replaced
/// (<see cref="RecordAnswer.Reset"/> says so for the rest of the session). One gate serialises every call.
/// </summary>
public sealed class HistoryStore(string root, TimeProvider time, ILogger<HistoryStore>? logger = null) : IDisposable
{
    public const int MaxValueRows = 500, MaxChangeRows = 5000;

    private const string Schema = """
        CREATE TABLE series (id INTEGER PRIMARY KEY, workbook_id TEXT NOT NULL, widget_id TEXT NOT NULL,
          series_key TEXT NOT NULL, query_key TEXT NOT NULL, mode TEXT NOT NULL, interval TEXT NOT NULL,
          label TEXT NOT NULL, columns TEXT NOT NULL, UNIQUE (workbook_id, widget_id, series_key));
        CREATE TABLE snapshots (series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
          taken_at INTEGER NOT NULL, result TEXT, columns TEXT);
        CREATE INDEX snapshots_by_time ON snapshots (series_id, taken_at);
        CREATE TABLE tracked (series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
          key TEXT NOT NULL, row TEXT NOT NULL, first_seen INTEGER NOT NULL, gone INTEGER);
        CREATE UNIQUE INDEX tracked_open ON tracked (series_id, key) WHERE gone IS NULL;
        CREATE INDEX tracked_first_seen ON tracked (series_id, first_seen);
        CREATE INDEX tracked_gone ON tracked (series_id, gone);
        PRAGMA user_version = 2;
        """;

    // v1 read every snapshot with its series' latest columns; its snapshots keep a NULL here and still do.
    private const string ToV2 = """
        ALTER TABLE snapshots ADD COLUMN columns TEXT;
        PRAGMA user_version = 2;
        """;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<HistoryStore> _log = logger ?? NullLogger<HistoryStore>.Instance;
    private SqliteConnection? _db;
    private bool _reset;

    private string DbPath => Path.Combine(root, "history.db");

    public void Dispose()
    {
        _db?.Dispose();
        _gate.Dispose();
    }

    public Task<RecordAnswer> RecordAsync(RecordRequest r, CancellationToken ct)
    {
        return Gated(db =>
        {
            var setting = r.Setting;
            var rows = setting.Mode == HistoryMode.Values;
            if (rows && r.Rows.Count > MaxValueRows)
            {
                return new RecordAnswer(false, "tooManyRows", _reset);
            }

            Dictionary<string, JsonElement[]>? keyed = null;
            if (!rows)
            {
                keyed = new Dictionary<string, JsonElement[]>();
                foreach (var row in r.Rows)
                {
                    if (!keyed.TryAdd(KeyOf(row, setting), row))
                    {
                        return new RecordAnswer(false, "keysNotUnique", _reset);
                    }
                }
            }

            var now = time.GetUtcNow().ToUnixTimeMilliseconds();
            var start = IntervalStart(setting.Interval);
            using var tx = db.BeginTransaction();
            Run(db, tx, "DELETE FROM series WHERE workbook_id = $w AND widget_id = $g AND query_key <> $q",
                ("$w", r.WorkbookId), ("$g", r.WidgetId), ("$q", HistoryKeys.QueryKey(r.Query, setting)));
            var id = Scalar<long>(db, tx, """
                INSERT INTO series (workbook_id, widget_id, series_key, query_key, mode, interval, label, columns)
                VALUES ($w, $g, $s, $q, $m, $v, $l, $c)
                ON CONFLICT (workbook_id, widget_id, series_key) DO UPDATE SET interval = $v, label = $l, columns = $c
                RETURNING id
                """, ("$w", r.WorkbookId), ("$g", r.WidgetId), ("$s", HistoryKeys.SeriesKey(r.Query, setting)),
                ("$q", HistoryKeys.QueryKey(r.Query, setting)), ("$m", setting.Mode.ToString()), ("$v", setting.Interval.ToString()), ("$l", r.Label),
                ("$c", JsonSerializer.Serialize(r.Columns)));

            if (keyed is null)
            {
                if (start is { } from)
                {
                    Run(db, tx, "DELETE FROM snapshots WHERE series_id = $i AND taken_at >= $t", ("$i", id), ("$t", from));
                }

                // Each snapshot keeps its own columns: the same query can return them in another order or shape.
                Run(db, tx, "INSERT INTO snapshots (series_id, taken_at, result, columns) VALUES ($i, $t, $r, $c)",
                    ("$i", id), ("$t", now), ("$r", JsonSerializer.Serialize(r.Rows)), ("$c", JsonSerializer.Serialize(r.Columns)));
            }
            else
            {
                if (start is { } from
                    && Scalar<long>(db, tx, "SELECT COUNT(*) FROM snapshots WHERE series_id = $i AND taken_at >= $t",
                        ("$i", id), ("$t", from)) > 0)
                {
                    tx.Commit();
                    return new RecordAnswer(false, "interval", _reset);
                }

                Run(db, tx, "INSERT INTO snapshots (series_id, taken_at, result) VALUES ($i, $t, NULL)", ("$i", id), ("$t", now));
                ApplyRows(db, tx, id, keyed, now);
            }

            var cutoff = now - setting.RetentionDays * 86_400_000L;
            // Only Values snapshots age out: Rows markers are what "Previous snapshot" compares with.
            Run(db, tx, "DELETE FROM snapshots WHERE series_id = $i AND taken_at < $c AND result IS NOT NULL", ("$i", id), ("$c", cutoff));
            Run(db, tx, "DELETE FROM tracked WHERE series_id = $i AND gone < $c", ("$i", id), ("$c", cutoff));
            tx.Commit();
            return new RecordAnswer(true, null, _reset);
        }, ct);
    }

    public Task<ValuesAnswer> ValuesAsync(string workbookId, string widgetId, HistoryQuery q, HistorySetting s,
        CancellationToken ct)
    {
        return Gated(db =>
        {
            var snapshots = new List<Snapshot>();
            if (FindSeries(db, workbookId, widgetId, q, s) is { } found)
            {
                using var cmd = Command(db, null, "SELECT taken_at, result, columns FROM snapshots WHERE series_id = $i AND result IS NOT NULL ORDER BY taken_at",
                    ("$i", found.Id));
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    var columns = reader.IsDBNull(2) ? found.Columns : JsonSerializer.Deserialize<HistoryColumn[]>(reader.GetString(2)) ?? [];
                    snapshots.Add(new Snapshot(DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(0)), columns,
                        JsonSerializer.Deserialize<JsonElement[][]>(reader.GetString(1)) ?? []));
                }
            }

            return new ValuesAnswer(snapshots, _reset);
        }, ct);
    }

    /// <param name="since">"previous" (the snapshot before the latest) or an ISO 8601 instant. With no previous snapshot
    /// there is no lower bound, so every row counts as new.</param>
    public Task<ChangesAnswer> ChangesAsync(string workbookId, string widgetId, HistoryQuery q, HistorySetting s,
        string since, CancellationToken ct)
    {
        return Gated(db =>
        {
            if (FindSeries(db, workbookId, widgetId, q, s) is not { } found)
            {
                return new ChangesAnswer(null, [], [], 0, [], 0, 0, _reset);
            }

            long? sinceMs;
            if (since == "previous")
            {
                using var cmd = Command(db, null, "SELECT taken_at FROM snapshots WHERE series_id = $i ORDER BY taken_at DESC LIMIT 1 OFFSET 1",
                    ("$i", found.Id));
                sinceMs = cmd.ExecuteScalar() as long?;
            }
            else
            {
                sinceMs = DateTimeOffset.Parse(since, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal).ToUnixTimeMilliseconds();
            }

            var lower = sinceMs ?? long.MinValue;
            var (added, addedCount) = Tracked(db, found.Id, "gone IS NULL AND first_seen > $t", "first_seen DESC", lower);
            var (removed, removedCount) = Tracked(db, found.Id, "gone > $t", "gone DESC", lower);
            var open = Scalar<long>(db, null, "SELECT COUNT(*) FROM tracked WHERE series_id = $i AND gone IS NULL", ("$i", found.Id));
            return new ChangesAnswer(sinceMs is { } ms ? DateTimeOffset.FromUnixTimeMilliseconds(ms) : null, found.Columns,
                added, addedCount, removed, removedCount, (int)open, _reset);
        }, ct);
    }

    public Task<IReadOnlyList<SeriesInfo>> SeriesAsync(string workbookId, string widgetId, CancellationToken ct)
    {
        return Gated<IReadOnlyList<SeriesInfo>>(db =>
        {
            var found = new List<(long Id, string Label, string Mode, string Interval)>();
            using (var cmd = Command(db, null, "SELECT id, label, mode, interval FROM series WHERE workbook_id = $w AND widget_id = $g ORDER BY id",
                ("$w", workbookId), ("$g", widgetId)))
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read())
                {
                    found.Add((reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3)));
                }
            }

            var zone = time.LocalTimeZone;
            var infos = new List<SeriesInfo>();
            foreach (var (id, label, mode, interval) in found)
            {
                var days = new SortedSet<DateTime>();
                var count = 0;
                long first = time.GetUtcNow().ToUnixTimeMilliseconds();
                using (var cmd = Command(db, null, "SELECT taken_at FROM snapshots WHERE series_id = $i ORDER BY taken_at", ("$i", id)))
                using (var reader = cmd.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var at = reader.GetInt64(0);
                        first = count++ == 0 ? at : first;
                        days.Add(TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(at), zone).Date);
                    }
                }

                // Only a daily series has days to miss; per-run and weekly series report none.
                var gaps = days.Count == 0 || interval != nameof(HistoryInterval.Day) ? 0 : (days.Max - days.Min).Days + 1 - days.Count;
                var stored = mode == nameof(HistoryMode.Rows)
                    ? (int)Scalar<long>(db, null, "SELECT COUNT(*) FROM tracked WHERE series_id = $i", ("$i", id))
                    : count;
                infos.Add(new SeriesInfo(label, DateTimeOffset.FromUnixTimeMilliseconds(first), count, gaps, stored));
            }

            return infos;
        }, ct);
    }

    public Task ClearAsync(string workbookId, string widgetId, CancellationToken ct) =>
        Delete("DELETE FROM series WHERE workbook_id = $w AND widget_id = $g", ct, ("$w", workbookId), ("$g", widgetId));

    public Task DeleteWorkbookAsync(string workbookId, CancellationToken ct) =>
        Delete("DELETE FROM series WHERE workbook_id = $w", ct, ("$w", workbookId));

    private Task Delete(string sql, CancellationToken ct, params (string, object)[] args) =>
        Gated(db =>
        {
            Run(db, null, sql, args);
            return 0;
        }, ct);

    /// <summary>Runs one call under the gate. A file that passed its check but is corrupt or not a database (SQLite 11 or 26)
    /// is replaced as at open and the call retried once, so a damaged history never fails a workbook.</summary>
    private async Task<T> Gated<T>(Func<SqliteConnection, T> body, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            // Off the caller's thread: the message pump starts the next handler only when this one first yields.
            return await Task.Run(() =>
            {
                try
                {
                    return body(Open());
                }
                catch (SqliteException e) when (e.SqliteErrorCode is 11 or 26)
                {
                    Reset();
                    return body(Open());
                }
            }, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static string KeyOf(JsonElement[] row, HistorySetting s) => JsonSerializer.Serialize(row.Take(s.Keys.Count));

    private static void ApplyRows(SqliteConnection db, SqliteTransaction tx, long id, Dictionary<string, JsonElement[]> keyed, long now)
    {
        var open = new Dictionary<string, string>();
        using (var cmd = Command(db, tx, "SELECT key, row FROM tracked WHERE series_id = $i AND gone IS NULL", ("$i", id)))
        using (var reader = cmd.ExecuteReader())
        {
            while (reader.Read())
            {
                open[reader.GetString(0)] = reader.GetString(1);
            }
        }

        foreach (var (key, row) in keyed)
        {
            var json = JsonSerializer.Serialize(row);
            if (!open.TryGetValue(key, out var stored))
            {
                Run(db, tx, "INSERT INTO tracked (series_id, key, row, first_seen, gone) VALUES ($i, $k, $r, $t, NULL)",
                    ("$i", id), ("$k", key), ("$r", json), ("$t", now));
            }
            else if (stored != json)
            {
                Run(db, tx, "UPDATE tracked SET row = $r WHERE series_id = $i AND key = $k AND gone IS NULL",
                    ("$i", id), ("$k", key), ("$r", json));
            }
        }

        foreach (var key in open.Keys.Where(k => !keyed.ContainsKey(k)))
        {
            Run(db, tx, "UPDATE tracked SET gone = $t WHERE series_id = $i AND key = $k AND gone IS NULL",
                ("$i", id), ("$k", key), ("$t", now));
        }
    }

    private static (List<TrackedRow> Rows, int Count) Tracked(SqliteConnection db, long id, string where, string order, long lower)
    {
        var count = (int)Scalar<long>(db, null, $"SELECT COUNT(*) FROM tracked WHERE series_id = $i AND {where}", ("$i", id), ("$t", lower));
        var rows = new List<TrackedRow>();
        using var cmd = Command(db, null,
            $"SELECT row, first_seen, gone FROM tracked WHERE series_id = $i AND {where} ORDER BY {order} LIMIT {MaxChangeRows}",
            ("$i", id), ("$t", lower));
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(new TrackedRow(JsonSerializer.Deserialize<JsonElement[]>(reader.GetString(0)) ?? [],
                DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(1)),
                reader.IsDBNull(2) ? null : DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(2))));
        }

        return (rows, count);
    }

    private (long Id, IReadOnlyList<HistoryColumn> Columns)? FindSeries(SqliteConnection db, string workbookId, string widgetId,
        HistoryQuery q, HistorySetting s)
    {
        using var cmd = Command(db, null, "SELECT id, columns FROM series WHERE workbook_id = $w AND widget_id = $g AND series_key = $s",
            ("$w", workbookId), ("$g", widgetId), ("$s", HistoryKeys.SeriesKey(q, s)));
        using var reader = cmd.ExecuteReader();
        return reader.Read()
            ? (reader.GetInt64(0), JsonSerializer.Deserialize<HistoryColumn[]>(reader.GetString(1)) ?? [])
            : null;
    }

    /// <summary>The unix ms the current interval began in the host's local time zone (Monday for a week); null for every run.</summary>
    private long? IntervalStart(HistoryInterval interval)
    {
        if (interval == HistoryInterval.Run)
        {
            return null;
        }

        var local = time.GetLocalNow();
        var date = interval == HistoryInterval.Week ? local.Date.AddDays(-(((int)local.DayOfWeek + 6) % 7)) : local.Date;
        return new DateTimeOffset(date, time.LocalTimeZone.GetUtcOffset(date)).ToUnixTimeMilliseconds();
    }

    private SqliteConnection Open()
    {
        if (_db is not null)
        {
            return _db;
        }

        Directory.CreateDirectory(root);
        try
        {
            _db = Connect();
        }
        // Only damage resets; disk full, read-only, busy or can't-open propagate and the call fails.
        catch (SqliteException e) when (e.SqliteErrorCode is 11 or 26)
        {
            Reset();
            _db = Connect();
        }

        return _db;
    }

    /// <summary>Moves the file (and its -wal/-shm) aside; the next <see cref="Open"/> starts a new one. Logs no contents.</summary>
    private void Reset()
    {
        _db?.Dispose();
        _db = null;
        var suffix = ".damaged-" + time.GetLocalNow().ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
        foreach (var ext in new[] { "", "-wal", "-shm" })
        {
            if (File.Exists(DbPath + ext))
            {
                File.Move(DbPath + ext, DbPath + ext + suffix, overwrite: true);
            }
        }

        _reset = true;
        _log.LogWarning("The history database could not be read and was replaced by an empty one.");
    }

    private SqliteConnection Connect()
    {
        // No pooling: the store keeps its one connection, and a pooled handle would keep the file open after Dispose/Reset (Windows can't move or delete it).
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = DbPath, Pooling = false }.ToString());
        try
        {
            db.Open();
            Run(db, null, "PRAGMA foreign_keys = ON");
            Run(db, null, "PRAGMA journal_mode = WAL");
            if (Scalar<string>(db, null, "PRAGMA quick_check") != "ok")
            {
                throw new SqliteException("quick_check failed", 11);
            }

            var version = Scalar<long>(db, null, "PRAGMA user_version");
            if (version < 2)
            {
                // One transaction: a first open cut short leaves version 0 and no tables, so the next open starts over.
                using var tx = db.BeginTransaction();
                Run(db, tx, version == 0 ? Schema : ToV2);
                tx.Commit();
            }

            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static SqliteCommand Command(SqliteConnection db, SqliteTransaction? tx, string sql, params (string Name, object Value)[] args)
    {
        var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        foreach (var (name, value) in args)
        {
            cmd.Parameters.AddWithValue(name, value);
        }

        return cmd;
    }

    private static void Run(SqliteConnection db, SqliteTransaction? tx, string sql, params (string, object)[] args)
    {
        using var cmd = Command(db, tx, sql, args);
        cmd.ExecuteNonQuery();
    }

    private static T Scalar<T>(SqliteConnection db, SqliteTransaction? tx, string sql, params (string, object)[] args)
    {
        using var cmd = Command(db, tx, sql, args);
        return (T)Convert.ChangeType(cmd.ExecuteScalar()!, typeof(T), CultureInfo.InvariantCulture);
    }
}
