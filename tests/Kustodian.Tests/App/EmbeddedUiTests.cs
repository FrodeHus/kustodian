using Kustodian.App;

namespace Kustodian.Tests.App;

public class EmbeddedUiTests
{
    // Source maps go to the GitHub release (releasing.md), never into the app.
    [Fact]
    public void Embedded_ui_has_no_source_maps()
    {
        var assembly = typeof(EmbeddedAssets).Assembly;
        var web = assembly.GetManifestResourceNames()
            .Where(n => n.Replace('\\', '/').StartsWith("wwwroot/", StringComparison.Ordinal))
            .ToList();

        Assert.NotEmpty(web);
        Assert.DoesNotContain(web, n => n.EndsWith(".map", StringComparison.OrdinalIgnoreCase));

        var pointing = new List<string>();
        foreach (var name in web.Where(n => n.EndsWith(".js", StringComparison.OrdinalIgnoreCase)))
        {
            using var reader = new StreamReader(assembly.GetManifestResourceStream(name)!);
            if (reader.ReadToEnd().Contains("sourceMappingURL", StringComparison.Ordinal))
            {
                pointing.Add(name);
            }
        }

        Assert.Empty(pointing);
    }
}
