using System.Text.RegularExpressions;

namespace Kustodian.Graph.Schema;

/// <summary>Turns the CSDL into KQL tables (spec section 4.2): structural properties only, enums as strings, complex types
/// and collections as dynamic.</summary>
public static partial class GraphSchemaBuilder
{
    private static readonly HashSet<string> FilterOperators = ["eq", "ne", "not", "ge", "le", "lt", "gt", "in", "startsWith", "endsWith"];

    /// <summary>Whether the path is a signed-in user's collection: under <c>me</c> (<c>me/messages</c>) or through a <c>me</c>
    /// segment further down (<c>education/me/assignments</c>). These mostly repeat other tables per user, so they are left out.
    /// <c>me</c> itself is a table: every sign-in Kustodian offers is delegated, so <c>GET /me</c> reads the signed-in user.</summary>
    private static bool IsUnderMe(string path) => path != "me" && path.Split('/').Contains("me");

    /// <summary>Columns left out of their table because the value is a secret or a credential's content, keyed by table name
    /// and column name. Kept by hand: <c>tools/schema</c> flags new columns that look like one for a person to add here.</summary>
    public static readonly IReadOnlySet<(string Table, string Column)> SecretColumns = new HashSet<(string Table, string Column)>
    {
        // The code-signing certificate's password and its raw certificate (with the private key).
        ("deviceAppManagement_symantecCodeSigningCertificate", "password"),
        ("deviceAppManagement_symantecCodeSigningCertificate", "content"),
        // The token that enrolls devices with Zebra's FOTA service.
        ("deviceManagement_zebraFotaConnector", "enrollmentToken"),
        // The Apple push notification certificate itself.
        ("deviceManagement_applePushNotificationCertificate", "certificate"),
    };

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

    /// <summary>The column holding each row's type: <c>@odata.type</c> without its <c>#</c>
    /// (<c>microsoft.graph.fido2AuthenticationMethodConfiguration</c>), or the table's entity type when Graph sends none.
    /// Only on tables whose entity type has derived types.</summary>
    public const string OdataTypeColumn = "odataType";

    /// <summary>Navigation properties of derived types that Graph returns inline in a list without <c>$expand</c>, keyed by table
    /// and name; they become derived columns like structural properties. Microsoft Learn's Get authenticationMethodsPolicy
    /// shows each method configuration's <c>includeTargets</c> in the list.</summary>
    public static readonly IReadOnlySet<(string Table, string Column)> InlineNavigations = new HashSet<(string Table, string Column)>
    {
        ("policies_authenticationMethodsPolicy_authenticationMethodConfigurations", "includeTargets"),
    };

    /// <summary>The most derived-type columns a table gets. Beyond it (<c>deviceManagement_deviceConfigurations</c> has 1,407,
    /// <c>directoryObjects</c> 315, where the derived types have tables of their own) the table gets only
    /// <see cref="OdataTypeColumn"/>: the schema would grow by a fifth for two tables.</summary>
    public const int MaxDerivedColumns = 200;

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
        var derived = metadata.Types.Values.Where(t => t.Kind == "EntityType" && t.BaseType is not null).ToLookup(t => t.BaseType!);
        var tables = metadata.Collections
            .Where(c => metadata.Types.ContainsKey(c.EntityType))
            .Where(c => !IsUnderMe(c.Path))
            // A single object becomes a table only when Microsoft lists a permission to read it: most singletons and many
            // contained objects are containers with nothing of their own to read.
            .Where(c => !c.Single || permissions.ContainsKey(GraphPermissions.NormalizePath("/" + c.Path)))
            .Select(c => BuildTable(metadata, derived, permissions, relationshipPermissions, relationships, c, shapes, warnings))
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

    private static GraphTable BuildTable(GraphMetadata metadata, ILookup<string, CsdlType> derived,
        IReadOnlyDictionary<string, IReadOnlyList<string>> permissions,
        IReadOnlyDictionary<string, IReadOnlyList<string>> relationshipPermissions,
        IReadOnlyDictionary<string, IReadOnlyList<GraphRelationship>> relationships, CsdlCollection collection,
        Dictionary<string, string> shapes, ICollection<string>? warnings)
    {
        var type = metadata.Types[collection.EntityType];
        var name = collection.Path.Replace('/', '_');
        var columns = type.Properties.Where(p => !SecretColumns.Contains((name, p.Name))).Select(p =>
        {
            var kusto = KustoType(metadata, p);
            return new GraphColumn(p.Name, kusto, p.Description, FilterOf(p.Description), SelectOnlyRegex().IsMatch(p.Description),
                ComplexOf(metadata, p), p.IsCollection,
                // A stream (application.logo) is media read from its own URL; selecting it in a list makes Graph answer 404.
                // A single object's read is a single GET, so what Graph returns only on one is listed there.
                Listable: p.TypeName != "Edm.Stream"
                    && (collection.Single || !GetOnlyRegex().IsMatch(p.Description) && !KnownGetOnly.Contains((name, p.Name))))
            {
                KnownPermission = GraphPermissions.KnownColumns.GetValueOrDefault((name, p.Name)),
            };
        }).ToList();
        columns.AddRange(DerivedColumns(metadata, derived, type, name, columns.Select(c => c.Name).ToHashSet(StringComparer.Ordinal)));
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
            Single = collection.Single,
        };
    }

    /// <summary>The columns of the types derived from <paramref name="type"/> (at any depth): each derived type's own structural
    /// properties, and its <see cref="InlineNavigations"/>, then <see cref="OdataTypeColumn"/>; none when nothing derives from it, only
    /// <see cref="OdataTypeColumn"/> past <see cref="MaxDerivedColumns"/>.
    /// A name sibling types share is one column, typed as they type it, or <c>dynamic</c> when their types differ (and then
    /// without a complex type). A name the table already has, a stream, and a property Graph returns only on a single GET are
    /// left out: none can be read in a list without <c>$select</c>.</summary>
    private static List<GraphColumn> DerivedColumns(GraphMetadata metadata, ILookup<string, CsdlType> derived, CsdlType type,
        string table, HashSet<string> taken)
    {
        var descendants = new List<CsdlType>();
        var seen = new HashSet<string>(StringComparer.Ordinal) { type.FullName };
        var pending = new Queue<CsdlType>([type]);
        while (pending.TryDequeue(out var current))
        {
            foreach (var child in derived[current.FullName].OrderBy(t => t.FullName, StringComparer.Ordinal))
            {
                if (!seen.Add(child.FullName))
                    continue;
                descendants.Add(child);
                pending.Enqueue(child);
            }
        }
        if (descendants.Count == 0)
            return [];

        var properties = descendants.SelectMany(d => d.Properties
                .Where(p => !taken.Contains(p.Name) && p.TypeName != "Edm.Stream" && !GetOnlyRegex().IsMatch(p.Description))
                .Select(p => (Type: d, Property: p))
            .Concat(d.Navigations.Where(n => !taken.Contains(n.Name) && InlineNavigations.Contains((table, n.Name)))
                .Select(n => (Type: d, Property: new CsdlProperty(n.Name, n.TypeName, n.IsCollection, n.Description)))))
            // A property a descendant inherits from another descendant counts once, for the type that declares it.
            .GroupBy(x => x.Property.Name, StringComparer.Ordinal);
        var columns = new List<GraphColumn>();
        foreach (var group in properties)
        {
            var declared = group.Where(x => !group.Any(y => y.Type != x.Type && Inherits(x.Type, y.Type))).ToList();
            var kusto = declared.Select(x => KustoType(metadata, x.Property)).Distinct().ToList();
            var complex = declared.Select(x => ComplexOf(metadata, x.Property)).Distinct().ToList();
            var first = declared[0].Property;
            var on = string.Join(", ", declared.Select(x => ShortName(x.Type.FullName)));
            var description = declared.Select(x => x.Property.Description).FirstOrDefault(d => d.Length > 0) ?? "";
            columns.Add(new GraphColumn(first.Name, kusto.Count == 1 ? kusto[0] : "dynamic",
                $"Only on {on}." + (description.Length > 0 ? " " + description : ""), [], false,
                complex.Count == 1 && kusto.Count == 1 ? complex[0] : null,
                kusto.Count == 1 && declared.All(x => x.Property.IsCollection))
            {
                Derived = true,
            });
        }
        if (columns.Count > MaxDerivedColumns)
            columns.Clear();
        if (!taken.Contains(OdataTypeColumn))
            columns.Add(new GraphColumn(OdataTypeColumn, "string",
                $"The object's type: @odata.type without #, such as {descendants[0].FullName}; {type.FullName} when Graph sends none.",
                [], false, null)
            {
                Derived = true,
            });
        return columns;

        bool Inherits(CsdlType child, CsdlType ancestor)
        {
            var steps = new HashSet<string>(StringComparer.Ordinal);
            for (var b = child.BaseType; b is not null && steps.Add(b); b = metadata.Types.GetValueOrDefault(b)?.BaseType)
            {
                if (b == ancestor.FullName)
                    return true;
            }
            return false;
        }
    }

    private static string ShortName(string fullName)
        => fullName.StartsWith("microsoft.graph.", StringComparison.Ordinal) ? fullName["microsoft.graph.".Length..] : fullName;

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
