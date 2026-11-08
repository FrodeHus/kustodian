using System.Text.RegularExpressions;

namespace Kustodian.Graph.Schema;

/// <summary>Turns the CSDL into KQL tables (spec section 4.2): structural properties only, enums as strings, complex types
/// and collections as dynamic.</summary>
public static partial class GraphSchemaBuilder
{
    private static readonly HashSet<string> FilterOperators = ["eq", "ne", "not", "ge", "le", "lt", "gt", "in", "startsWith", "endsWith"];

    /// <summary>Singletons whose collections only exist for a signed-in user (delegated access): an application-token reader reads
    /// with an application token, so they are left out.</summary>
    private static readonly string[] DelegatedOnlySingletons = ["me"];

    /// <summary>Whether the path is a signed-in user's: under a delegated-only singleton, or through a <c>me</c> segment
    /// further down (<c>education/me/assignments</c>).</summary>
    private static bool IsDelegatedOnly(string path)
    {
        var segments = path.Split('/');
        return DelegatedOnlySingletons.Contains(segments[0]) || segments.Contains("me");
    }

    /// <summary>Columns Graph returns only on a single object's GET although the metadata doesn't say so, keyed by table name
    /// and column name. Microsoft Learn's List users: the SharePoint profile properties and <c>mailboxSettings</c> "are only
    /// supported when retrieving a single user"; selected in a list, Graph refuses the whole list (in a tenant without
    /// SharePoint Online, "Tenant does not have a SPO license"). Learn's group resource: the unseen counters are "Supported
    /// only on the Get group API", which their beta descriptions leave out.</summary>
    public static readonly IReadOnlySet<(string Table, string Column)> KnownGetOnly = new HashSet<(string Table, string Column)>
    {
        ("users", "aboutMe"), ("users", "birthday"), ("users", "hireDate"), ("users", "interests"), ("users", "mySite"),
        ("users", "pastProjects"), ("users", "preferredName"), ("users", "responsibilities"), ("users", "schools"),
        ("users", "skills"), ("users", "mailboxSettings"),
        ("groups", "unseenConversationsCount"), ("groups", "unseenMessagesCount"),
    };

    /// <summary>Builds the schema with no relationship columns.</summary>
    public static GraphSchema Build(GraphMetadata metadata, IReadOnlyDictionary<string, IReadOnlyList<string>> permissions,
        string source, DateTimeOffset generatedAt)
        => Build(metadata, permissions, new Dictionary<string, IReadOnlyList<string>>(),
            new Dictionary<string, IReadOnlyList<GraphRelationship>>(), source, generatedAt);

    /// <summary>Builds the schema. <paramref name="permissions"/> (from <see cref="GraphPermissions.ReadDelegated"/>) gives the
    /// tables' permissions, <paramref name="relationshipPermissions"/> (from
    /// <see cref="GraphPermissions.ReadRelationshipDelegated"/>) the relationship columns'. <paramref name="relationships"/>
    /// maps a table name to the relationships that become relationship columns; a path segment or table the metadata doesn't
    /// have throws <see cref="GraphRelationshipException"/>. A relationship Microsoft lists no delegated permission for is
    /// added to <paramref name="warnings"/>. A relationship to directory objects has <c>kustodian.directoryObjectRef</c>
    /// entries; one to other entities has their properties (and their derived types') plus <c>objectType</c>, as
    /// <c>kustodian.{type}</c>; one to a complex-typed property has that complex type.</summary>
    public static GraphSchema Build(GraphMetadata metadata, IReadOnlyDictionary<string, IReadOnlyList<string>> permissions,
        IReadOnlyDictionary<string, IReadOnlyList<string>> relationshipPermissions,
        IReadOnlyDictionary<string, IReadOnlyList<GraphRelationship>> relationships, string source, DateTimeOffset generatedAt,
        ICollection<string>? warnings = null)
    {
        var shapes = new Dictionary<string, string>(StringComparer.Ordinal);
        var tables = metadata.Collections
            .Where(c => metadata.Types.ContainsKey(c.EntityType))
            .Where(c => !IsDelegatedOnly(c.Path))
            .Select(c => BuildTable(metadata, permissions, relationshipPermissions, relationships, c, shapes, warnings))
            .GroupBy(t => t.Name)
            .Select(g => g.First())
            .ToList();

        foreach (var table in relationships.Keys)
        {
            if (!tables.Any(t => t.Name == table))
                throw new GraphRelationshipException($"The curated relationships name the table {table}, which the metadata doesn't have.");
        }

        var complexTypes = new SortedDictionary<string, IReadOnlyList<GraphField>>(StringComparer.Ordinal);
        if (tables.Any(t => t.Columns.Any(c => c.ComplexType == GraphSchemaJson.DirectoryObjectRef)))
            complexTypes[GraphSchemaJson.DirectoryObjectRef] = DirectoryObjectRefFields;
        foreach (var (shape, entityType) in shapes)
            complexTypes[shape] = EntityShape(metadata, entityType);
        var pending = new Stack<string>(tables.SelectMany(t => t.Columns).Select(c => c.ComplexType)
            .Concat(complexTypes.Values.SelectMany(f => f).Select(f => f.ComplexType)).OfType<string>());
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

    /// <summary>The shape every relationship column's entries share: a directory object reduced to what identifies and names it.
    /// Fields that don't apply to an object's type are absent.</summary>
    private static readonly IReadOnlyList<GraphField> DirectoryObjectRefFields =
    [
        RefField("id", "The object's ID."),
        RefField("objectType", "The object's type: @odata.type without #microsoft.graph."),
        RefField("displayName", "The object's display name."),
        RefField("userPrincipalName", "The user principal name; users only."),
        RefField("mail", "The primary email address; users and groups."),
        RefField("appId", "The application (client) ID; applications and service principals."),
        RefField("deviceId", "The device ID; devices."),
    ];

    private static GraphField RefField(string name, string description) => new(name, "string", false, null, description);

    /// <summary>The entries of a relationship to entities that aren't directory objects: <c>objectType</c>, then the entity
    /// type's properties, then those its derived types add (FIDO2's <c>aaGuid</c>), each name once. A field that doesn't
    /// apply to an entry's type is absent from it.</summary>
    private static IReadOnlyList<GraphField> EntityShape(GraphMetadata metadata, string entityType)
    {
        var derived = metadata.Types.Values.Where(t => t.FullName != entityType && DerivesFrom(metadata, t, entityType))
            .OrderBy(t => t.FullName, StringComparer.Ordinal);
        var fields = new List<GraphField> { RefField("objectType", "The entry's type: @odata.type without #microsoft.graph.") };
        foreach (var p in new[] { metadata.Types[entityType] }.Concat(derived).SelectMany(t => t.Properties))
            if (!fields.Any(f => f.Name == p.Name))
                fields.Add(ToField(metadata, p));
        return fields;
    }

    /// <summary>The type a relationship's path ends at, read from the table's type one segment at a time: a navigation
    /// property, or a complex-typed property as the last segment. Segments before the last must be single-valued.</summary>
    private static (CsdlType Type, bool Collection, string Description) Resolve(GraphMetadata metadata, CsdlType type,
        string table, GraphRelationship relationship)
    {
        var segments = relationship.ReadPath.Split('/');
        for (var i = 0; ; i++)
        {
            var last = i == segments.Length - 1;
            var nav = type.Navigations.FirstOrDefault(n => n.Name == segments[i]);
            var property = last && nav is null
                ? type.Properties.FirstOrDefault(p => p.Name == segments[i] && ComplexOf(metadata, p) is not null)
                : null;
            var (typeName, collection, description) = nav is not null ? (nav.TypeName, nav.IsCollection, nav.Description)
                : property is not null ? (property.TypeName, property.IsCollection, property.Description)
                : throw new GraphRelationshipException(
                    $"The curated relationship {table}.{relationship.Name} reads {segments[i]}, which isn't a navigation property of {type.FullName}.");
            if (!metadata.Types.TryGetValue(typeName, out var next) || (!last && collection))
                throw new GraphRelationshipException(
                    $"The curated relationship {table}.{relationship.Name} goes through {segments[i]}, which isn't a single entity.");
            if (last)
                return (next, collection, description);
            type = next;
        }
    }

    private static GraphTable BuildTable(GraphMetadata metadata, IReadOnlyDictionary<string, IReadOnlyList<string>> permissions,
        IReadOnlyDictionary<string, IReadOnlyList<string>> relationshipPermissions,
        IReadOnlyDictionary<string, IReadOnlyList<GraphRelationship>> relationships, CsdlCollection collection,
        Dictionary<string, string> shapes, ICollection<string>? warnings)
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
        foreach (var relationship in relationships.GetValueOrDefault(name) ?? [])
        {
            var (target, isCollection, description) = Resolve(metadata, type, name, relationship);
            string shape;
            if (target.Kind == "ComplexType")
                shape = target.FullName;
            else if (IsDirectoryObject(metadata, target))
                shape = GraphSchemaJson.DirectoryObjectRef;
            else
                shapes[shape = "kustodian." + target.FullName[(target.FullName.LastIndexOf('.') + 1)..]] = target.FullName;
            var path = $"/{collection.Path}/{{id}}/{relationship.ReadPath}";
            // Already least-privileged first, then ordinal; kept in that order.
            var columnPermissions = relationshipPermissions.GetValueOrDefault(GraphPermissions.NormalizePath(path)) ?? [];
            if (columnPermissions.Count == 0)
                warnings?.Add($"{name}.{relationship.Name}: Microsoft lists no delegated permission for GET {path}.");
            columns.Add(new GraphColumn(relationship.Name, "dynamic", description, [], false, shape, isCollection, Listable: false)
            {
                Relationship = true,
                RelationshipPath = relationship.Path,
                Permissions = columnPermissions,
            });
        }

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
    private static bool IsDirectoryObject(GraphMetadata metadata, CsdlType type) => DerivesFrom(metadata, type, DirectoryObjectType);

    /// <summary>Whether the type is <paramref name="baseType"/> or derives from it, walking the base chain (guarded against a
    /// cycle in the metadata).</summary>
    private static bool DerivesFrom(GraphMetadata metadata, CsdlType type, string baseType)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (CsdlType? current = type; current is not null && seen.Add(current.FullName);
             current = current.BaseType is { } b ? metadata.Types.GetValueOrDefault(b) : null)
        {
            if (current.FullName == baseType)
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
