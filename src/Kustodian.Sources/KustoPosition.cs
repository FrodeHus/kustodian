using System.Globalization;
using System.Text.RegularExpressions;

namespace Kustodian.Sources;

/// <summary>The position a Kusto error message names, for the two clients that run KQL on the server.</summary>
internal static partial class KustoPosition
{
    /// <summary>The position a query error names: Kusto's <c>line [L,C]</c>, or <c>line L, column C</c> (also <c>position</c>
    /// or <c>pos</c>). Null when it names none. See <c>Fixtures/hunting-run-400.json</c>: no real body with a position has been
    /// recorded, so these are the forms Kusto writes.</summary>
    public static (int Line, int Column)? Of(string message)
    {
        var match = BracketPosition().Match(message);
        if (!match.Success)
        {
            match = WordPosition().Match(message);
        }

        return match.Success
            && int.TryParse(match.Groups["line"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var line)
            && int.TryParse(match.Groups["column"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var column)
            && line > 0 && column > 0
            ? (line, column)
            : null;
    }

    [GeneratedRegex(@"\bline\s*\[\s*(?<line>[0-9]{1,6})\s*,\s*(?<column>[0-9]{1,6})\s*\]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BracketPosition();

    [GeneratedRegex(@"\bline\s+(?<line>[0-9]{1,6})\s*,?\s*(?:column|col|position|pos)\s+(?<column>[0-9]{1,6})\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex WordPosition();
}
