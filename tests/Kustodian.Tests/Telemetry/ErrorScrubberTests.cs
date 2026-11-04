using System.Runtime.CompilerServices;
using System.Text.Json;
using Kustodian.Telemetry;

namespace Kustodian.Tests.Telemetry;

/// <summary>What <see cref="ErrorScrubber"/> lets into an automatic report.</summary>
public sealed class ErrorScrubberTests
{
    private static readonly string[] Leaky =
    [
        "adele.vance@contoso.com", "10.20.30.40", "2001:db8::1", "0f8fee3c-12ab-4c3d-9e8f-1234567890ab",
        @"C:\Users\adele\AppData", "/Users/adele/Library", "users | where displayName == \"Adele\"",
    ];

    private static readonly string LeakyText = string.Join(" ", Leaky);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Throw()
    {
        var inner = new InvalidOperationException(LeakyText);
        inner.Data["leak"] = LeakyText;
        var outer = new ArgumentException(LeakyText, inner);
        outer.Data["leak"] = LeakyText;
        throw outer;
    }

    private static void AssertClean(object scrubbed)
    {
        var json = JsonSerializer.Serialize(scrubbed);
        foreach (var leak in Leaky)
        {
            Assert.DoesNotContain(leak, json);
            Assert.DoesNotContain(JsonSerializer.Serialize(leak).Trim('"'), json);
        }
    }

    [Fact]
    public void Of_keeps_type_names_and_frames_and_nothing_else()
    {
        var ex = Assert.ThrowsAny<Exception>(Throw);

        var result = ErrorScrubber.Of(ex);

        AssertClean(result);
        Assert.Equal(["System.ArgumentException", "System.InvalidOperationException"], result.Select(r => r.TypeName));
        Assert.Contains(result[0].Frames, f => f.Method == "Kustodian.Tests.Telemetry.ErrorScrubberTests.Throw" && f.Assembly == "Kustodian.Tests");
    }

    [Fact]
    public void Frames_outside_known_assemblies_are_external()
    {
        Assert.Equal(new ErrorFrame("<external>", ""), ErrorScrubber.Frame("Xunit.Foo.Bar", "xunit.v3.core"));
        Assert.Equal(new ErrorFrame("<external>", ""), ErrorScrubber.Frame(null, null));
        Assert.Equal(new ErrorFrame("A.B", "KustoLoco.Core"), ErrorScrubber.Frame("A.B", "KustoLoco.Core"));

        // Consecutive external frames collapse into one (xunit's frames sit between a test and the runner).
        var frames = ErrorScrubber.OfJs("E", "at https://a.invalid/x.js:1:1\nat https://b.invalid/y.js:2:2")[0].Frames;
        Assert.Equal([new ErrorFrame("<external>", "")], frames);
    }

    [Fact]
    public void Of_caps_inner_exceptions_at_ten()
    {
        var aggregate = new AggregateException(Enumerable.Range(0, 15).Select(_ => new Exception(LeakyText)));

        Assert.Equal(10, ErrorScrubber.Of(aggregate).Count);
    }

    [Fact]
    public void OfJs_keeps_function_names_and_bundle_positions()
    {
        const string stack = "TypeError: x is undefined\n    at Qe (app://localhost/assets/index-abc123.js:1:48213)\n"
                             + "    at https://kustodian.invalid/assets/index-abc123.js:2:10";

        var result = Assert.Single(ErrorScrubber.OfJs("TypeError", stack));

        Assert.Equal("TypeError", result.TypeName);
        Assert.Equal([new ErrorFrame("Qe", "index-abc123.js:1:48213"), new ErrorFrame("<anonymous>", "index-abc123.js:2:10")], result.Frames);
        Assert.DoesNotContain("undefined", JsonSerializer.Serialize(result));
    }

    [Fact]
    public void OfJs_drops_anything_but_bundle_positions()
    {
        var stack = $"Error: {LeakyText}\n    at {Leaky[0]} (https://x.invalid/{Leaky[4]}/a.js:1:2)\n    at {LeakyText} (app://localhost/other/a.js:3:4)\n"
                    + $"    at app://localhost/{Leaky[5]}/assets/x.js?{Leaky[1]}:5:6";

        var result = Assert.Single(ErrorScrubber.OfJs($"Bad {LeakyText}", stack));

        AssertClean(result);
        Assert.Equal("Error", result.TypeName);
        Assert.Equal([new ErrorFrame("<external>", "")], result.Frames);
    }
}
