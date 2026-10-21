using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Graph.Run;

namespace Kustodian.Storage;

/// <summary>The defaults rule (<see cref="JsonDefaults"/>) for a nested <see cref="QueryOptions"/>: absent or null options stay
/// null, and options that are there have their missing fields filled, a scope's too (<see cref="ArgScope.Default"/>), so a
/// scope without ids has none.</summary>
public static class QueryOptionsDefaults
{
    private const string OptionsName = "options";

    /// <summary>A new object: <paramref name="owner"/> with its <c>options</c> object (named ignoring case) filled.</summary>
    public static JsonObject Fill(JsonObject owner, JsonSerializerOptions serializer)
    {
        var filled = owner.DeepClone().AsObject();
        var key = KeyOf(filled, OptionsName);
        if (key is not null && filled[key] is JsonObject options)
        {
            var withDefaults = JsonDefaults.Fill(options, JsonSerializer.SerializeToNode(QueryOptions.Default, serializer)!.AsObject());
            var scopeKey = KeyOf(withDefaults, nameof(QueryOptions.Scope));
            if (scopeKey is not null && withDefaults[scopeKey] is JsonObject scope)
            {
                withDefaults[scopeKey] = JsonDefaults.Fill(scope, JsonSerializer.SerializeToNode(ArgScope.Default, serializer)!.AsObject());
            }

            filled[key] = withDefaults;
        }

        return filled;
    }

    /// <summary>Whether <paramref name="options"/> has every part a reader relies on: a scope, when there is one, has a kind and
    /// ids, none of them null (a null in an array arrives as null, whatever the types say).</summary>
    public static bool IsComplete(QueryOptions? options) =>
        options?.Scope is not { } scope || (scope.Kind is not null && scope.Ids is not null && scope.Ids.All(id => id is not null));

    private static string? KeyOf(JsonObject value, string name) =>
        value.Select(p => p.Key).FirstOrDefault(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase));
}
