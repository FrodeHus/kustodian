using Kustodian.Graph.Fetch;
using Kustodian.Graph.Schema;

namespace Kustodian.Graph.Query;

/// <summary>A column a query touches that the plan leaves out because the tenant lacks the license it needs.</summary>
public sealed record GraphLicenseGap(string Column, GraphLicenseRequirement Requirement);

/// <summary>What the planner leaves out for licenses: the tables and columns whose license (<see cref="GraphLicenses"/>) the
/// tenant is known not to have (<see cref="GraphLicenseState.Missing"/>). When the tenant's licenses are unknown nothing is
/// missing, so the plan is as without a gate.</summary>
public sealed record GraphLicenseGate(GraphLicenses Map, TenantLicenses Tenant)
{
    /// <summary>The license the table needs and the tenant lacks, or null.</summary>
    public GraphLicenseRequirement? MissingFor(GraphTable table) =>
        Map.ForTable(table.Path) is { } requirement && Tenant.StateOf(requirement) == GraphLicenseState.Missing ? requirement : null;

    /// <summary>The table's columns whose license the tenant lacks, by name.</summary>
    public IReadOnlyDictionary<string, GraphLicenseRequirement> MissingColumns(GraphTable table)
    {
        var missing = new Dictionary<string, GraphLicenseRequirement>(StringComparer.Ordinal);
        if (!Tenant.Known)
            return missing;
        foreach (var column in table.Columns)
        {
            if (Map.ForColumn(table.Path, column.Name) is { } requirement && Tenant.StateOf(requirement) == GraphLicenseState.Missing)
                missing[column.Name] = requirement;
        }

        return missing;
    }

    /// <summary>The message for a run that stops because <paramref name="table"/> needs <paramref name="requirement"/>.</summary>
    public static string TableMessage(GraphTable table, GraphLicenseRequirement requirement) =>
        $"{table.Name} needs {requirement.License}, which the tenant doesn't have, so it wasn't read. {requirement.Source}";
}
