using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Kustodian.Graph.Schema;
using Kusto.Language;
using Kusto.Language.Symbols;

namespace Kustodian.Graph.Query;

/// <summary>The Graph schema as the database Kusto.Language binds queries against. Built once per schema instance.</summary>
public static class GraphGlobals
{
    /// <summary>The database name the tables live in.</summary>
    public const string DatabaseName = "graph";

    private static readonly ConditionalWeakTable<GraphSchema, GlobalState> PlainCache = new();
    private static readonly ConditionalWeakTable<GraphSchema, ConcurrentDictionary<int, GlobalState>> TypedCache = new();

    /// <summary>Every column as its plain Kusto type: what the engine sees, and what the planner binds against.</summary>
    public static GlobalState Plain(GraphSchema schema) =>
        PlainCache.GetValue(schema, s => Globals(s, c => ScalarTypes.GetSymbol(c.Type)));

    /// <summary>Complex columns as dynamic bags whose fields are known, so <c>onPremisesPublishing.</c> completes. Graph's
    /// complex types nest (and recurse), so below <paramref name="depth"/> levels a value is plain dynamic.</summary>
    public static GlobalState Typed(GraphSchema schema, int depth = 3) =>
        TypedCache.GetValue(schema, _ => new ConcurrentDictionary<int, GlobalState>())
            .GetOrAdd(depth, (d, s) => Globals(s, c => TypedColumn(s, c, d)), schema);

    /// <summary>A collection column is an array of its element: a bag for a complex type, otherwise plain dynamic (the
    /// schema keeps a collection column's type as <c>dynamic</c>, not its element's).</summary>
    private static TypeSymbol TypedColumn(GraphSchema schema, GraphColumn column, int depth)
    {
        TypeSymbol element = column.ComplexType is { } complex ? Bag(schema, complex, depth - 1) : ScalarTypes.GetSymbol(column.Type);
        return column.Collection ? ScalarTypes.GetDynamicArray(element) : element;
    }

    private static GlobalState Globals(GraphSchema schema, Func<GraphColumn, TypeSymbol> type)
    {
        var tables = schema.Tables
            .Select(t => new TableSymbol(t.Name, t.Columns.Select(c => new ColumnSymbol(c.Name, type(c), c.Description)), t.Description))
            .ToArray();
        return GlobalState.Default.WithDatabase(new DatabaseSymbol(DatabaseName, tables));
    }

    /// <summary>A complex type as a bag of its fields, <paramref name="depth"/> more levels typed below it.</summary>
    private static TypeSymbol Bag(GraphSchema schema, string complexType, int depth)
    {
        if (depth < 0 || !schema.ComplexTypes.TryGetValue(complexType, out var fields))
            return ScalarTypes.Dynamic;
        return ScalarTypes.GetDynamicBag(fields.Select(f => new ColumnSymbol(f.Name, Field(schema, f, depth), f.Description)).ToArray());
    }

    private static TypeSymbol Field(GraphSchema schema, GraphField field, int depth)
    {
        var element = field.ComplexType is { } complex
            ? Bag(schema, complex, depth - 1)
            : ScalarTypes.GetSymbol(field.Type);
        return field.Collection ? ScalarTypes.GetDynamicArray(element) : element;
    }
}
