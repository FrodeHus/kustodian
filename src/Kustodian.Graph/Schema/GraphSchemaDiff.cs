using System.Text;

namespace Kustodian.Graph.Schema;

/// <summary>What changed between two schemas: tables and columns added or removed, type changes, and description-only
/// changes as a count. <c>Source</c> and <c>GeneratedAt</c> are not compared.</summary>
public sealed class GraphSchemaDiff
{
    private readonly List<string> _lines;

    private readonly bool _contentDiffers;

    private GraphSchemaDiff(List<string> lines, int descriptionsChanged, bool contentDiffers)
    {
        _lines = lines;
        DescriptionsChanged = descriptionsChanged;
        _contentDiffers = contentDiffers;
    }

    public int DescriptionsChanged { get; }

    /// <summary>True when the two schemas would write identical files (apart from Source and GeneratedAt), so every
    /// persisted field counts, whether or not the summary has a line for it.</summary>
    public bool IsEmpty => !_contentDiffers && _lines.Count == 0 && DescriptionsChanged == 0;

    public string ToSummary()
    {
        if (IsEmpty)
            return "No changes.";

        var sb = new StringBuilder();
        if (_lines.Count == 0 && DescriptionsChanged == 0)
            sb.Append("Other changes to the file.\n");
        foreach (var line in _lines)
            sb.Append(line).Append('\n');
        if (DescriptionsChanged > 0)
            sb.Append(DescriptionsChanged).Append(" descriptions changed").Append('\n');
        return sb.ToString().TrimEnd('\n');
    }

    public static GraphSchemaDiff Compare(GraphSchema before, GraphSchema after)
    {
        var lines = new List<string>();
        var descriptions = 0;

        var oldTables = before.Tables.ToDictionary(t => t.Name, StringComparer.Ordinal);
        var newTables = after.Tables.ToDictionary(t => t.Name, StringComparer.Ordinal);

        foreach (var name in newTables.Keys.Except(oldTables.Keys).Order(StringComparer.Ordinal))
            lines.Add($"+ table {name}");
        foreach (var name in oldTables.Keys.Except(newTables.Keys).Order(StringComparer.Ordinal))
            lines.Add($"- table {name}");

        foreach (var name in newTables.Keys.Intersect(oldTables.Keys).Order(StringComparer.Ordinal))
        {
            var (o, n) = (oldTables[name], newTables[name]);
            if (o.Description != n.Description)
                descriptions++;
            if (o.Path != n.Path)
                lines.Add($"{name}: path {o.Path} → {n.Path}");
            if (o.EntityType != n.EntityType)
                lines.Add($"{name}: entity type {o.EntityType} → {n.EntityType}");
            if (o.DocsUrl != n.DocsUrl)
                lines.Add($"{name}: docs url {o.DocsUrl} → {n.DocsUrl}");
            if (o.DirectoryObject != n.DirectoryObject)
                lines.Add($"{name}: directoryObject {o.DirectoryObject} → {n.DirectoryObject}");
            if (!o.Permissions.SequenceEqual(n.Permissions))
                lines.Add($"{name}: permissions [{string.Join(", ", o.Permissions)}] → [{string.Join(", ", n.Permissions)}]");

            var oldColumns = o.Columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
            var newColumns = n.Columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
            foreach (var column in n.Columns.Where(c => !oldColumns.ContainsKey(c.Name)))
                lines.Add($"{name}: + column {column.Name}");
            foreach (var column in o.Columns.Where(c => !newColumns.ContainsKey(c.Name)))
                lines.Add($"{name}: - column {column.Name}");
            foreach (var column in n.Columns.Where(c => oldColumns.ContainsKey(c.Name)))
            {
                var old = oldColumns[column.Name];
                if (old.Type != column.Type)
                    lines.Add($"{name}: {column.Name} {old.Type} → {column.Type}");
                if (!old.Filter.SequenceEqual(column.Filter))
                    lines.Add($"{name}: {column.Name} filter [{string.Join(", ", old.Filter)}] → [{string.Join(", ", column.Filter)}]");
                if (old.SelectOnly != column.SelectOnly)
                    lines.Add($"{name}: {column.Name} selectOnly {old.SelectOnly} → {column.SelectOnly}");
                if (old.Collection != column.Collection)
                    lines.Add($"{name}: {column.Name} collection {old.Collection} → {column.Collection}");
                if (old.Listable != column.Listable)
                    lines.Add($"{name}: {column.Name} listable {old.Listable} → {column.Listable}");
                if (old.ComplexType != column.ComplexType)
                    lines.Add($"{name}: {column.Name} complex type {old.ComplexType ?? "none"} → {column.ComplexType ?? "none"}");
                if (old.KnownPermission != column.KnownPermission)
                    lines.Add($"{name}: {column.Name} known permission {old.KnownPermission ?? "none"} → {column.KnownPermission ?? "none"}");
                if (old.Description != column.Description)
                    descriptions++;
            }

            if (!SameOrder(o.Columns.Select(c => c.Name), n.Columns.Select(c => c.Name)))
                lines.Add($"{name}: columns reordered");
        }

        foreach (var name in after.ComplexTypes.Keys.Except(before.ComplexTypes.Keys).Order(StringComparer.Ordinal))
            lines.Add($"+ complex type {name}");
        foreach (var name in before.ComplexTypes.Keys.Except(after.ComplexTypes.Keys).Order(StringComparer.Ordinal))
            lines.Add($"- complex type {name}");

        foreach (var name in after.ComplexTypes.Keys.Intersect(before.ComplexTypes.Keys).Order(StringComparer.Ordinal))
        {
            var oldFields = before.ComplexTypes[name].ToDictionary(f => f.Name, StringComparer.Ordinal);
            var newFields = after.ComplexTypes[name].ToDictionary(f => f.Name, StringComparer.Ordinal);
            foreach (var field in after.ComplexTypes[name].Where(f => !oldFields.ContainsKey(f.Name)))
                lines.Add($"{name}: + field {field.Name}");
            foreach (var field in before.ComplexTypes[name].Where(f => !newFields.ContainsKey(f.Name)))
                lines.Add($"{name}: - field {field.Name}");
            foreach (var field in after.ComplexTypes[name].Where(f => oldFields.ContainsKey(f.Name)))
            {
                var old = oldFields[field.Name];
                if (old.Type != field.Type || old.Collection != field.Collection || old.ComplexType != field.ComplexType)
                    lines.Add($"{name}: {field.Name} {Describe(old)} → {Describe(field)}");
                if (old.Description != field.Description)
                    descriptions++;
            }

            if (!SameOrder(before.ComplexTypes[name].Select(f => f.Name), after.ComplexTypes[name].Select(f => f.Name)))
                lines.Add($"{name}: fields reordered");
        }

        return new GraphSchemaDiff(lines, descriptions, !GraphSchemaJson.SameContent(before, after));
    }

    /// <summary>Whether the names both sides share come in the same order (additions and removals don't count).</summary>
    private static bool SameOrder(IEnumerable<string> before, IEnumerable<string> after)
    {
        var (b, a) = (before.ToList(), after.ToList());
        return b.Where(a.Contains).SequenceEqual(a.Where(b.Contains));
    }

    private static string Describe(GraphField f) => (f.Collection ? "collection of " : "") + (f.ComplexType ?? f.Type);
}
