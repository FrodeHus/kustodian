using System.Text.Json.Nodes;

namespace Kustodian.Storage;

/// <summary>
/// The rule for user data read from a file or the UI: a field that is missing, or null, takes its default. <see cref="Fill"/>
/// lays a JSON object over its defaults (the defaults serialized with the same options) before it is deserialized, so a
/// missing number is its default rather than 0 and a missing object is its default rather than null.
/// </summary>
public static class JsonDefaults
{
    /// <summary>A new object: <paramref name="value"/> with every property of <paramref name="defaults"/> it lacks (or holds as
    /// null) added from the defaults, object properties filled in the same way at every level. Names match ignoring case, as
    /// the web serializer options read them; arrays and other values in <paramref name="value"/> are kept whole. Properties
    /// only in <paramref name="value"/> are kept. Neither input is changed.</summary>
    public static JsonObject Fill(JsonObject value, JsonObject defaults)
    {
        var filled = value.DeepClone().AsObject();
        foreach (var (name, fallback) in defaults)
        {
            var key = filled.Select(p => p.Key).FirstOrDefault(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase));
            var current = key is null ? null : filled[key];
            if (current is null)
            {
                filled[key ?? name] = fallback?.DeepClone();
            }
            else if (current is JsonObject inner && fallback is JsonObject innerDefaults)
            {
                filled[key!] = Fill(inner, innerDefaults);
            }
        }

        return filled;
    }

    /// <summary>A new object: <paramref name="value"/> with each object in its array <paramref name="property"/> (named ignoring
    /// case) filled from <paramref name="elementDefaults"/> (<see cref="Fill"/>), so a field missing from an element takes its
    /// default. Elements that aren't objects, and a missing or non-array property, are kept as they are.</summary>
    public static JsonObject FillElements(JsonObject value, string property, JsonObject elementDefaults)
    {
        var filled = value.DeepClone().AsObject();
        var key = filled.Select(p => p.Key).FirstOrDefault(k => string.Equals(k, property, StringComparison.OrdinalIgnoreCase));
        if (key is not null && filled[key] is JsonArray elements)
        {
            for (var i = 0; i < elements.Count; i++)
            {
                if (elements[i] is JsonObject element)
                {
                    elements[i] = Fill(element, elementDefaults);
                }
            }
        }

        return filled;
    }
}
