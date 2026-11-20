using Kustodian.App;

namespace Kustodian.Tests.App;

public sealed class WindowsTitleBarTests
{
    [Theory]
    [InlineData("#161a20", 0x00201a16)]
    [InlineData("#ff0000", 0x000000ff)]
    [InlineData("#0000FF", 0x00ff0000)]
    public void A_hex_colour_becomes_a_colorref_in_bgr_order(string hex, int expected) =>
        Assert.Equal(expected, WindowsTitleBar.ColorRef(hex));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("161a20")]
    [InlineData("#fff")]
    [InlineData("#16 a20")]
    [InlineData("#gggggg")]
    [InlineData("rgba(1, 2, 3, 0.5)")]
    public void Anything_else_is_no_colour(string? hex) => Assert.Null(WindowsTitleBar.ColorRef(hex));
}
