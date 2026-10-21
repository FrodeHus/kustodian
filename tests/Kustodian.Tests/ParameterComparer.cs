using Kustodian.Library;

namespace Kustodian.Tests;

/// <summary>Parameters compare by their fields, choices included.</summary>
internal sealed class ParameterComparer : IEqualityComparer<ParameterDef>
{
    public static ParameterComparer Instance { get; } = new();

    public bool Equals(ParameterDef? x, ParameterDef? y) =>
        x is not null && y is not null && x.Name == y.Name && x.Type == y.Type && x.Value == y.Value && x.Required == y.Required
        && (x.Choices is null ? y.Choices is null : y.Choices is not null && x.Choices.SequenceEqual(y.Choices));

    public int GetHashCode(ParameterDef obj) => obj.Name.GetHashCode(StringComparison.Ordinal);
}
