using System.Globalization;
using System.Text.Json.Nodes;
using Kustodian.Graph.Query;
using Kustodian.Graph.Run;

namespace Kustodian.Graph.Fetch;

/// <summary>
/// The relationship columns a query names, read after the list, one column at a time: each object's value from
/// <paramref name="cache"/> where it has one (unless refreshing), else from Graph (<see cref="GraphRelationshipReader"/>),
/// unless more than <see cref="GraphLimits.RelationshipObjectsPerTable"/> objects are left to read: then the column stays
/// empty, cached values included, as a column with some objects' values and not others' would read as if it were whole.
/// A cache entry is one object's value of one relationship, under the columns <c>["rel:" + column]</c> so it never mixes with
/// a property's, as <c>{"value": …, "truncated": …}</c>. Only values Graph returned are kept, not refused or failed reads.
/// </summary>
internal sealed class GraphRelationshipColumns(HttpClient http, IGraphObjectCache cache, GraphLimits limits)
{
    private const string KeyPrefix = "rel:";
    private readonly GraphRelationshipReader _reader = new(http, limits);

    /// <summary>Reads <paramref name="columns"/> into <paramref name="read"/>'s objects and returns it with an outcome per
    /// column; the columns read leave <see cref="GraphCollection.Unreadable"/>. Each column that sends requests adds its
    /// template (<see cref="GraphRelationshipReader.Template"/>) to <paramref name="requests"/> once.</summary>
    public async Task<GraphCollection> ReadAsync(string accountKey, GraphFetch fetch, GraphFetchLease lease, List<string> requests,
        GraphCollection read, IReadOnlyList<string> columns, bool refresh, RunDiagnostics? diagnostics, CancellationToken ct)
    {
        var outcomes = new List<GraphRelationshipOutcome>();
        var done = new List<string>();
        foreach (var name in columns)
        {
            var column = fetch.Table.Columns.First(c => c.Name == name);
            var outcome = await ReadColumnAsync(accountKey, fetch, column, lease, requests, read.Objects, refresh, diagnostics, ct);
            outcomes.Add(outcome);
            if (!outcome.Capped)
                done.Add(name);
        }
        return read with
        {
            Unreadable = [.. read.Unreadable.Where(c => !done.Contains(c))],
            Relationships = outcomes,
        };
    }

    private async Task<GraphRelationshipOutcome> ReadColumnAsync(string accountKey, GraphFetch fetch, Schema.GraphColumn column,
        GraphFetchLease lease, List<string> requests, IReadOnlyList<JsonObject> objects, bool refresh, RunDiagnostics? diagnostics,
        CancellationToken ct)
    {
        var path = fetch.Table.Path;
        var named = fetch.Table.Name + "." + column.Name;
        IReadOnlyList<string> key = [KeyPrefix + column.Name];
        var hits = new List<(JsonObject Target, GraphCachedValues Values)>();
        var misses = new List<JsonObject>();
        foreach (var o in objects)
        {
            if (!refresh && Id(o) is { } id && await cache.GetAsync(accountKey, path, key, id, ct) is { } cached)
                hits.Add((o, cached));
            else
                misses.Add(o);
        }

        var cap = limits.RelationshipObjectsPerTable;
        if (misses.Count > cap)
        {
            Log(diagnostics, DiagnosticKinds.PerObject, string.Create(CultureInfo.InvariantCulture,
                $"{named}: {misses.Count:N0} objects are more than {cap:N0} to read one at a time; left empty"));
            return new GraphRelationshipOutcome(column.Name, objects.Count, 0, 0, 0, true, 0);
        }

        var truncated = 0;
        if (hits.Count > 0)
            Log(diagnostics, DiagnosticKinds.Cache, string.Create(CultureInfo.InvariantCulture,
                $"{named} for {Objects(hits.Count)} from the cache"));
        foreach (var (target, values) in hits)
        {
            // Cached values take memory in the run as Graph's answers do.
            await lease.AddAsync(values.Json.Length, ct);
            var parsed = JsonNode.Parse(values.Json) as JsonObject;
            target[column.Name] = parsed?["value"]?.DeepClone();
            if (parsed?["truncated"] is JsonValue cut && cut.TryGetValue<bool>(out var wasCut) && wasCut)
                truncated++;
        }

        var (refused, failed) = (0, 0);
        if (misses.Count > 0)
        {
            requests.Add(GraphRelationshipReader.Template(path, column.Name, column.Collection));
            var answered = await _reader.ReadAsync(accountKey, path, column, misses, lease, diagnostics, ct);
            (refused, failed) = (answered.Refused, answered.Failed);
            truncated += answered.Truncated.Count;
            var cut = answered.Truncated.ToHashSet(StringComparer.Ordinal);
            foreach (var o in misses)
                if (Id(o) is { } id && answered.Values.TryGetValue(id, out var value))
                    o[column.Name] = value?.DeepClone();
            foreach (var (id, value) in answered.Values)
            {
                var entry = new JsonObject { ["value"] = value?.DeepClone(), ["truncated"] = cut.Contains(id) };
                await cache.SetAsync(accountKey, path, key, id, entry.ToJsonString(), ct);
            }
            Log(diagnostics, DiagnosticKinds.PerObject, string.Create(CultureInfo.InvariantCulture,
                $"{named}: read one object at a time for {Objects(misses.Count)}, {refused:N0} refused, {failed:N0} failed, {answered.Truncated.Count:N0} cut off at {limits.RelationshipEntriesPerObject:N0} entries"));
        }
        return new GraphRelationshipOutcome(column.Name, objects.Count, truncated, refused, failed, false, hits.Count);
    }

    private static string Objects(int count)
        => count.ToString("N0", CultureInfo.InvariantCulture) + (count == 1 ? " object" : " objects");

    /// <summary>Adds a step of the read, with no request of its own, to the run's log.</summary>
    private static void Log(RunDiagnostics? diagnostics, string kind, string detail)
        => diagnostics?.Add(new DiagnosticEntry(diagnostics.NowMs, kind, detail, null, null, null));

    private static string? Id(JsonObject o) => o["id"] is JsonValue v && v.TryGetValue<string>(out var id) ? id : null;
}
