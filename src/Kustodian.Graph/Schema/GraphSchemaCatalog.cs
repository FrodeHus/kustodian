namespace Kustodian.Graph.Schema;

/// <summary>The schema committed as <c>graph-beta.json</c> and embedded in this assembly, read once.</summary>
public static class GraphSchemaCatalog
{
    private static readonly Lazy<GraphSchema> BetaSchema = new(Load);

    public static GraphSchema Beta => BetaSchema.Value;

    private static GraphSchema Load()
    {
        using var stream = typeof(GraphSchemaCatalog).Assembly.GetManifestResourceStream("graph-beta.json")
            ?? throw new InvalidOperationException("The embedded resource graph-beta.json is missing.");
        return GraphSchemaJson.Read(stream);
    }
}
