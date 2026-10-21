using Kustodian.Graph.Schema;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Language.Symbols;
using Kusto.Language.Syntax;

namespace Kustodian.Graph.Query;

/// <summary>A field offered after a dot: its name, Kusto.Language's completion kind, its Kusto type and its description.</summary>
public sealed record GraphCompletionItem(string Label, string Kind, string Type, string Description);

/// <summary>
/// Completion inside complex values (spec §6.2), which the browser's editor can't do: the query is bound against the schema
/// with complex types as typed bags (<see cref="GraphGlobals.Typed"/>, three levels deep), so the real binder resolves the
/// value before the dot, aliases included (<c>mv-expand c = passwordCredentials | where c.</c>). Only the fields of that
/// value are offered, with their type and description; after a dot on anything else (a plain value, or a value below the
/// depth cap) nothing is.
/// </summary>
public static class GraphCompletion
{
    public static IReadOnlyList<GraphCompletionItem> Complete(GraphSchema schema, string kql, int position)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(position);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(position, kql.Length);
        var code = KustoCode.ParseAndAnalyze(kql, GraphGlobals.Typed(schema));
        if (BagBeforeDot(code, position) is not { } bag)
            return [];

        var fields = bag.Properties.GroupBy(p => p.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        return new KustoCodeService(code).GetCompletionItems(position).Items
            .Where(i => fields.ContainsKey(i.DisplayText))
            .Select(i => (Item: i, Field: fields[i.DisplayText]))
            .Select(x => new GraphCompletionItem(x.Item.DisplayText, x.Item.Kind.ToString(), TypeName(x.Field.Type), x.Field.Description ?? ""))
            .DistinctBy(i => i.Label, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>The typed bag left of the dot the position completes after (<c>x.</c>, or <c>x.par</c> while typing), if it is
    /// one.</summary>
    private static DynamicBagSymbol? BagBeforeDot(KustoCode code, int position)
    {
        var token = code.Syntax.GetTokenAt(Math.Max(0, position - 1));
        for (var node = token?.Parent; node is not null; node = node.Parent)
            if (node is PathExpression path && path.Dot.End <= position)
                return path.Expression.ResultType as DynamicBagSymbol;
        return null;
    }

    private static string TypeName(TypeSymbol type) => type is DynamicSymbol ? ScalarTypes.Dynamic.Name : type.Name;
}
