using System.Text.RegularExpressions;

namespace Kustodian.Graph.Schema;

/// <summary>Turns the CSDL into KQL tables (spec section 4.2): structural properties only, enums as strings, complex types
/// and collections as dynamic.</summary>
public static partial class GraphSchemaBuilder
{
    private static readonly HashSet<string> FilterOperators = ["eq", "ne", "not", "ge", "le", "lt", "gt", "in", "startsWith"];

    /// <summary>Singletons whose collections only exist for a signed-in user (delegated access): an application-token reader reads
    /// with an application token, so they are left out.</summary>
    private static readonly string[] DelegatedOnlySingletons = ["me"];

    /// <summary>Columns Graph returns only on a single object's GET although the metadata doesn't say so, keyed by table name
    /// and column name. Microsoft Learn's List users: the SharePoint profile properties and <c>mailboxSettings</c> "are only
    /// supported when retrieving a single user"; selected in a list, Graph refuses the whole list (in a tenant without
    /// SharePoint Online, "Tenant does not have a SPO license").</summary>
    public static readonly IReadOnlySet<(string Table, string Column)> KnownGetOnly = new HashSet<(string Table, string Column)>
    {
        ("users", "aboutMe"), ("users", "birthday"), ("users", "hireDate"), ("users", "interests"), ("users", "mySite"),
        ("users", "pastProjects"), ("users", "preferredName"), ("users", "responsibilities"), ("users", "schools"),
        ("users", "skills"), ("users", "mailboxSettings"),
    };

    public static GraphSchema Build(GraphMetadata metadata, IReadOnlyDictionary<string, IReadOnlyList<string>> permissions,
        string source, DateTimeOffset generatedAt)
    {
        var tables = metadata.Collections
            .Where(c => metadata.Types.ContainsKey(c.EntityType))
            .Where(c => !DelegatedOnlySingletons.Any(s => c.Path.StartsWith(s + "/", StringComparison.Ordinal)))
            .Select(c => BuildTable(metadata, permissions, c))
            .GroupBy(t => t.Name)
            .Select(g => g.First())
            .ToList();

        var complexTypes = new SortedDictionary<string, IReadOnlyList<GraphField>>(StringComparer.Ordinal);
        var pending = new Stack<string>(tables.SelectMany(t => t.Columns).Select(c => c.ComplexType).OfType<string>());
        while (pending.TryPop(out var name))
        {
            if (complexTypes.ContainsKey(name))
                continue;
            var fields = metadata.Types[name].Properties.Select(p => ToField(metadata, p)).ToList();
            complexTypes[name] = fields;
            foreach (var field in fields)
                if (field.ComplexType is not null)
                    pending.Push(field.ComplexType);
        }

        return new GraphSchema(source, generatedAt, tables, complexTypes);
    }

    private static GraphTable BuildTable(GraphMetadata metadata, IReadOnlyDictionary<string, IReadOnlyList<string>> permissions,
        CsdlCollection collection)
    {
        var type = metadata.Types[collection.EntityType];
        var name = collection.Path.Replace('/', '_');
        var columns = type.Properties.Select(p =>
        {
            var kusto = KustoType(metadata, p);
            return new GraphColumn(p.Name, kusto, p.Description, FilterOf(p.Description), SelectOnlyRegex().IsMatch(p.Description),
                ComplexOf(metadata, p), p.IsCollection,
                // A stream (application.logo) is media read from its own URL; selecting it in a list makes Graph answer 404.
                Listable: p.TypeName != "Edm.Stream" && !GetOnlyRegex().IsMatch(p.Description) && !KnownGetOnly.Contains((name, p.Name)))
            {
                KnownPermission = GraphPermissions.KnownColumns.GetValueOrDefault((name, p.Name)),
            };
        }).ToList();
        var tablePermissions = permissions.GetValueOrDefault(GraphPermissions.NormalizePath("/" + collection.Path)) ?? [];
        return new GraphTable(name, collection.Path, type.FullName, type.Description,
            DocsUrl(type.FullName), columns, IsDirectoryObject(metadata, type))
        {
            Permissions = [.. tablePermissions.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)],
        };
    }

    private const string DirectoryObjectType = "microsoft.graph.directoryObject";

    /// <summary>Whether the type is <c>directoryObject</c> or derives from it, walking the base chain (guarded against a
    /// cycle in the metadata).</summary>
    private static bool IsDirectoryObject(GraphMetadata metadata, CsdlType type)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (CsdlType? current = type; current is not null && seen.Add(current.FullName);
             current = current.BaseType is { } b ? metadata.Types.GetValueOrDefault(b) : null)
        {
            if (current.FullName == DirectoryObjectType)
                return true;
        }
        return false;
    }

    private static GraphField ToField(GraphMetadata metadata, CsdlProperty p)
    {
        var complex = ComplexOf(metadata, p);
        var type = KustoType(metadata, p with { IsCollection = false });
        return new GraphField(p.Name, type, p.IsCollection, complex, p.Description);
    }

    /// <summary>The complex type behind a property, or null for primitives and enums.</summary>
    private static string? ComplexOf(GraphMetadata metadata, CsdlProperty p)
        => metadata.Types.TryGetValue(p.TypeName, out var t) && t.Kind == "ComplexType" ? p.TypeName : null;

    private static string KustoType(GraphMetadata metadata, CsdlProperty p)
    {
        if (p.IsCollection)
            return "dynamic";
        return p.TypeName switch
        {
            "Edm.String" or "Edm.Binary" or "Edm.TimeOfDay" or "Edm.Stream" => "string",
            "Edm.Boolean" => "bool",
            "Edm.Byte" or "Edm.SByte" or "Edm.Int16" or "Edm.Int32" => "int",
            "Edm.Int64" => "long",
            "Edm.Single" or "Edm.Double" => "real",
            "Edm.Decimal" => "decimal",
            "Edm.DateTimeOffset" or "Edm.Date" => "datetime",
            "Edm.Duration" => "timespan",
            "Edm.Guid" => "guid",
            _ when metadata.Types.TryGetValue(p.TypeName, out var t) && t.Kind == "EnumType" => "string",
            _ => "dynamic",
        };
    }

    /// <summary>Reads both phrasings Graph uses: <c>Supports $filter (eq, ne, and eq on null values)</c> and
    /// <c>Supports $filter operator 'eq'</c>. Each token's leading word is the operator; unknown words are ignored.</summary>
    private static IReadOnlyList<string> FilterOf(string description)
    {
        var operators = new List<string>();
        void Add(string token)
        {
            var words = token.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (words.Length > 0 && words[0] == "and")
                words = words[1..];
            if (words.Length > 0 && FilterOperators.Contains(words[0]) && !operators.Contains(words[0]))
                operators.Add(words[0]);
        }

        var match = FilterRegex().Match(description);
        if (match.Success)
            foreach (var token in match.Groups[1].Value.Split(','))
                Add(token);
        foreach (Match single in OperatorRegex().Matches(description))
            Add(single.Groups[1].Value);
        return operators;
    }

    /// <summary><c>microsoft.graph.application</c> documents at <c>.../resources/application</c>; the security namespace's
    /// types are <c>security-incident</c>.</summary>
    private static string DocsUrl(string entityType)
    {
        var name = entityType.Replace("microsoft.graph.security.", "security-", StringComparison.Ordinal)
            .Replace("microsoft.graph.", "", StringComparison.Ordinal)
            .ToLowerInvariant();
        return $"https://learn.microsoft.com/graph/api/resources/{name}?view=graph-rest-beta";
    }

    [GeneratedRegex(@"Supports \$filter \(([^)]*)\)")]
    private static partial Regex FilterRegex();

    [GeneratedRegex(@"Supports \$filter operator '(\w+)'")]
    private static partial Regex OperatorRegex();

    [GeneratedRegex(@"(Requires|Returned only on|only returned on)\s+\$select", RegexOptions.IgnoreCase)]
    private static partial Regex SelectOnlyRegex();

    /// <summary>The phrasings the beta metadata uses for a property returned only on a single object's GET: "Supported only
    /// on the Get group API", "available only when reading this bookingAppointment by its ID", "You can get the value only
    /// when you read this … by its ID", "Individual get call with select query options is needed", "only available for
    /// single object requests", "returned only on a single GET".</summary>
    [GeneratedRegex(@"Supported only on the Get \w+ API|only when (you read|reading) this \w+ by its ID|Individual get call with select query options is needed|only available for single object requests|returned only on a single GET",
        RegexOptions.IgnoreCase)]
    private static partial Regex GetOnlyRegex();
}
