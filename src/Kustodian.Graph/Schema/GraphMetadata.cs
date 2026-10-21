using System.Xml.Linq;

namespace Kustodian.Graph.Schema;

/// <summary>A property of an entity or complex type, as the CSDL declares it (the type name is resolved to its full name).</summary>
public sealed record CsdlProperty(string Name, string TypeName, bool IsCollection, string Description);

/// <summary>An entity, complex or enum type. Properties include the inherited ones, base type first. The base type is its
/// full name, or null.</summary>
public sealed record CsdlType(string FullName, string Kind, IReadOnlyList<CsdlProperty> Properties, string Description,
    string? BaseType = null);

/// <summary>Something Graph lets you list: an entity set (<c>/applications</c>) or a contained collection of a singleton
/// (<c>/security/incidents</c>).</summary>
public sealed record CsdlCollection(string Path, string EntityType);

/// <summary>The parts of Graph's CSDL the schema needs, read from the msgraph-metadata "with descriptions" document.</summary>
public sealed class GraphMetadata
{
    private static readonly XNamespace Edm = "http://docs.oasis-open.org/odata/ns/edm";
    private const string DescriptionTerm = "Org.OData.Core.V1.Description";
    private const string CollectionPrefix = "Collection(";

    public required IReadOnlyDictionary<string, CsdlType> Types { get; init; }

    public required IReadOnlyList<CsdlCollection> Collections { get; init; }

    public static GraphMetadata Load(Stream csdl)
    {
        var doc = XDocument.Load(csdl);
        var schemas = doc.Descendants(Edm + "Schema").ToList();
        var aliases = schemas.Where(s => s.Attribute("Alias") is not null)
            .ToDictionary(s => (string)s.Attribute("Alias")!, s => (string)s.Attribute("Namespace")!);

        string Resolve(string name)
        {
            var dot = name.LastIndexOf('.');
            if (dot < 0)
                return name;
            return aliases.TryGetValue(name[..dot], out var full) ? $"{full}.{name[(dot + 1)..]}" : name;
        }

        // Descriptions sit either inline on the element or in <Annotations Target="ns.type/property"> blocks.
        var external = doc.Descendants(Edm + "Annotations")
            .Select(a => (Target: (string?)a.Attribute("Target"), Text: DescriptionOf(a)))
            .Where(a => a.Target is not null && a.Text.Length > 0)
            .GroupBy(a =>
            {
                var parts = a.Target!.Split('/');
                return Resolve(parts[0]) + (parts.Length > 1 ? "/" + parts[1] : "");
            })
            .ToDictionary(g => g.Key, g => g.First().Text);

        var raw = new Dictionary<string, (XElement Element, string Kind, string? Base)>();
        foreach (var schema in schemas)
        {
            var ns = (string)schema.Attribute("Namespace")!;
            foreach (var e in schema.Elements().Where(e => e.Name == Edm + "EntityType" || e.Name == Edm + "ComplexType" || e.Name == Edm + "EnumType"))
            {
                var baseType = (string?)e.Attribute("BaseType");
                raw[$"{ns}.{(string)e.Attribute("Name")!}"] = (e, e.Name.LocalName, baseType is null ? null : Resolve(baseType));
            }
        }

        var types = new Dictionary<string, CsdlType>();
        CsdlType Build(string fullName)
        {
            if (types.TryGetValue(fullName, out var done))
                return done;
            var (element, kind, baseName) = raw[fullName];
            var properties = new List<CsdlProperty>();
            if (baseName is not null && raw.ContainsKey(baseName))
                properties.AddRange(Build(baseName).Properties);
            foreach (var p in element.Elements(Edm + "Property"))
            {
                var name = (string)p.Attribute("Name")!;
                var type = (string)p.Attribute("Type")!;
                var isCollection = type.StartsWith(CollectionPrefix, StringComparison.Ordinal);
                if (isCollection)
                    type = type[CollectionPrefix.Length..^1];
                var description = DescriptionOf(p);
                if (description.Length == 0)
                    description = external.GetValueOrDefault($"{fullName}/{name}", "");
                properties.RemoveAll(x => x.Name == name);
                properties.Add(new CsdlProperty(name, Resolve(type), isCollection, description));
            }
            var typeDescription = DescriptionOf(element);
            if (typeDescription.Length == 0)
                typeDescription = external.GetValueOrDefault(fullName, "");
            return types[fullName] = new CsdlType(fullName, kind, properties, typeDescription, baseName);
        }
        foreach (var name in raw.Keys)
            Build(name);

        var container = doc.Descendants(Edm + "EntityContainer").Single();
        var collections = container.Elements(Edm + "EntitySet")
            .Select(s => new CsdlCollection((string)s.Attribute("Name")!, Resolve((string)s.Attribute("EntityType")!)))
            .ToList();
        // A singleton's contained collections (security/incidents, identityProtection/riskyUsers, ...), one level deep.
        foreach (var singleton in container.Elements(Edm + "Singleton"))
        {
            var singletonType = Resolve((string)singleton.Attribute("Type")!);
            if (!raw.TryGetValue(singletonType, out var st))
                continue;
            foreach (var nav in st.Element.Elements(Edm + "NavigationProperty"))
            {
                var type = (string)nav.Attribute("Type")!;
                if ((string?)nav.Attribute("ContainsTarget") != "true" || !type.StartsWith(CollectionPrefix, StringComparison.Ordinal))
                    continue;
                collections.Add(new CsdlCollection($"{(string)singleton.Attribute("Name")!}/{(string)nav.Attribute("Name")!}",
                    Resolve(type[CollectionPrefix.Length..^1])));
            }
        }
        return new GraphMetadata { Types = types, Collections = collections };
    }

    private static string DescriptionOf(XElement e)
        => e.Elements(Edm + "Annotation").FirstOrDefault(a => (string?)a.Attribute("Term") == DescriptionTerm)?.Attribute("String")?.Value ?? "";
}
