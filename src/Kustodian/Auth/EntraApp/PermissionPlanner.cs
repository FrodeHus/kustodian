using Kustodian.Graph.Schema;

namespace Kustodian.Auth.EntraApp;

/// <summary>One permission the dialog offers. <paramref name="Unlocks"/> names the source for a source permission and is null
/// for a Graph permission, which lists <paramref name="Tables"/> instead.</summary>
public sealed record PlannedPermission(
    string Resource,
    string ResourceAppId,
    string Name,
    bool AdminConsent,
    string Description,
    IReadOnlyList<string> Tables,
    string? Unlocks,
    bool Ticked);

/// <summary>A titled run of permissions inside a group.</summary>
public sealed record PlannedSubgroup(string Title, IReadOnlyList<PlannedPermission> Permissions);

/// <summary>A top-level group: <c>graph</c>, <c>security</c> or <c>azure</c>.</summary>
public sealed record PlannedGroup(string Id, string Title, IReadOnlyList<PlannedSubgroup> Subgroups);

/// <summary>The groups plus the table totals: <paramref name="TablesWithData"/> are covered by a read permission,
/// <paramref name="WriteOnlyTables"/> only by write permissions, <paramref name="TablesWithoutData"/> by none.</summary>
public sealed record PermissionPlan(IReadOnlyList<PlannedGroup> Groups, int TablesWithData, int TablesWithoutData, int WriteOnlyTables);

/// <summary>Spec 5.2 and 5.3: the least set of read permissions covering the tables (greedy set cover), filed under groups
/// and ticked by home area. Pure and deterministic.</summary>
public static class PermissionPlanner
{
    private const string GraphResource = "Microsoft Graph";
    private const string SecurityArea = "Security";
    private const string SecurityDataSubgroup = "Graph security data";

    private static readonly HashSet<string> UntickedAreas = new(StringComparer.Ordinal)
    {
        "Mail, Teams and files",
        "Reports and usage",
        GraphAreas.Other,
    };

    /// <summary>Plans over <paramref name="tables"/> (the schema) using <paramref name="catalog"/>.</summary>
    public static PermissionPlan Plan(GraphPermissionCatalog catalog, IReadOnlyList<GraphTable> tables, GraphAreas areas)
    {
        var schemaPaths = new HashSet<string>(tables.Select(t => t.Path), StringComparer.Ordinal);
        var readable = catalog.Permissions
            .Where(IsReadOnly)
            .Where(p => !string.Equals(p.Name, SourcePermissions.Hunting.Scope, StringComparison.Ordinal))
            .Select(p => p with { Tables = [.. p.Tables.Where(schemaPaths.Contains)] })
            .Where(p => p.Tables.Count > 0)
            .ToList();

        var picked = GreedyCover(readable);
        var covered = new HashSet<string>(picked.SelectMany(p => p.Tables), StringComparer.Ordinal);
        var writable = new HashSet<string>(
            catalog.Permissions.Where(p => !IsReadOnly(p)).SelectMany(p => p.Tables).Where(schemaPaths.Contains), StringComparer.Ordinal);
        writable.ExceptWith(covered);
        var withoutData = schemaPaths.Count - covered.Count - writable.Count;

        var graph = new Dictionary<string, List<PlannedPermission>>(StringComparer.Ordinal);
        var securityData = new List<PlannedPermission>();
        foreach (var permission in picked)
        {
            var home = HomeArea(permission, areas);
            var planned = new PlannedPermission(
                GraphResource, SourcePermissions.GraphAppId, permission.Name, permission.AdminConsent, permission.Description,
                permission.Tables, null, !UntickedAreas.Contains(home));
            if (home == SecurityArea)
            {
                securityData.Add(planned);
            }
            else
            {
                if (!graph.TryGetValue(home, out var list))
                    graph[home] = list = [];
                list.Add(planned);
            }
        }

        var graphSubgroups = GraphAreas.Names
            .Where(name => name != SecurityArea && graph.ContainsKey(name))
            .Select(name => new PlannedSubgroup(name, graph[name]))
            .ToList();
        var securitySubgroups = new List<PlannedSubgroup> { new(SourcePermissions.Hunting.SubgroupTitle, [FromSource(SourcePermissions.Hunting)]) };
        if (securityData.Count > 0)
            securitySubgroups.Add(new PlannedSubgroup(SecurityDataSubgroup, securityData));

        List<PlannedGroup> groups =
        [
            new("graph", "Graph", graphSubgroups),
            new("security", "Security", securitySubgroups),
            new("azure", "Azure Resources", [new PlannedSubgroup(SourcePermissions.ResourceGraph.SubgroupTitle, [FromSource(SourcePermissions.ResourceGraph)])]),
        ];
        return new PermissionPlan(groups, covered.Count, withoutData, writable.Count);
    }

    /// <summary>The tables that stop being covered when <paramref name="untick"/> (a <c>resource|name</c> key) is removed from
    /// <paramref name="ticked"/>: its tables no other ticked permission reads, each once, sorted.</summary>
    public static IReadOnlyList<string> LostTables(PermissionPlan plan, ISet<string> ticked, string untick)
    {
        var all = plan.Groups.SelectMany(g => g.Subgroups).SelectMany(s => s.Permissions).ToList();
        var target = all.FirstOrDefault(p => Key(p) == untick);
        if (target is null)
            return [];

        var others = new HashSet<string>(
            all.Where(p => Key(p) != untick && ticked.Contains(Key(p))).SelectMany(p => p.Tables), StringComparer.Ordinal);
        return [.. target.Tables.Where(t => !others.Contains(t)).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];
    }

    private static string Key(PlannedPermission p) => $"{p.Resource}|{p.Name}";

    private static bool IsReadOnly(CatalogPermission p) =>
        p.Name.Contains(".Read", StringComparison.Ordinal) && !p.Name.Contains("Write", StringComparison.Ordinal);

    private static PlannedPermission FromSource(SourcePermission s) =>
        new(s.ResourceName, s.ResourceAppId, s.Scope, s.AdminConsent, "", [], s.Unlocks, true);

    private static List<CatalogPermission> GreedyCover(List<CatalogPermission> permissions)
    {
        var uncovered = new HashSet<string>(permissions.SelectMany(p => p.Tables), StringComparer.Ordinal);
        var remaining = new List<CatalogPermission>(permissions);
        var picked = new List<CatalogPermission>();
        while (uncovered.Count > 0)
        {
            var best = remaining
                .Select(p => (Permission: p, Gain: p.Tables.Count(uncovered.Contains)))
                .Where(x => x.Gain > 0)
                .OrderByDescending(x => x.Gain)
                .ThenBy(x => x.Permission.AdminConsent)
                .ThenBy(x => x.Permission.Name, StringComparer.Ordinal)
                .First().Permission;
            picked.Add(best);
            remaining.Remove(best);
            uncovered.ExceptWith(best.Tables);
        }

        return picked;
    }

    /// <summary>The area most of the permission's tables are in; ties go to the first in <see cref="GraphAreas.Names"/>.</summary>
    private static string HomeArea(CatalogPermission permission, GraphAreas areas)
    {
        var counts = permission.Tables.GroupBy(areas.Of).ToDictionary(g => g.Key, g => g.Count());
        return GraphAreas.Names.Where(counts.ContainsKey).OrderByDescending(n => counts[n]).First();
    }
}
