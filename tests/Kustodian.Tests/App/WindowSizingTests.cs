using System.Drawing;
using Kustodian.App;

namespace Kustodian.Tests.App;

public sealed class WindowSizingTests
{
    [Fact]
    public void At_100_percent_the_window_keeps_its_logical_size_centred_in_the_work_area()
    {
        var (bounds, min) = WindowSizing.ForMonitor(1.0, new Rectangle(0, 0, 1920, 1040));

        Assert.Equal(new Rectangle(240, 70, 1440, 900), bounds);
        Assert.Equal(new Size(1024, 640), min);
    }

    [Fact]
    public void At_200_percent_sizes_double()
    {
        var (bounds, min) = WindowSizing.ForMonitor(2.0, new Rectangle(0, 0, 3840, 2080));

        Assert.Equal(new Rectangle(480, 140, 2880, 1800), bounds);
        Assert.Equal(new Size(2048, 1280), min);
    }

    [Fact]
    public void Fractional_scales_round_to_whole_pixels()
    {
        var (bounds, min) = WindowSizing.ForMonitor(1.5, new Rectangle(0, 0, 2560, 1400));

        Assert.Equal(new Size(2160, 1350), bounds.Size);
        Assert.Equal(new Size(1536, 960), min);
    }

    [Fact]
    public void Never_larger_than_the_work_area_and_the_minimum_fits_it_too()
    {
        var (bounds, min) = WindowSizing.ForMonitor(1.25, new Rectangle(0, 0, 1366, 728));

        Assert.Equal(new Rectangle(0, 0, 1366, 728), bounds);
        Assert.Equal(new Size(1280, 728), min);
    }

    [Fact]
    public void Centres_within_a_work_area_that_does_not_start_at_the_origin()
    {
        var (bounds, _) = WindowSizing.ForMonitor(1.0, new Rectangle(1920, 48, 1920, 1032));

        Assert.Equal(new Rectangle(2160, 114, 1440, 900), bounds);
    }

    [Theory]
    [InlineData(0.0)]
    [InlineData(-2.0)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void An_unusable_scale_counts_as_100_percent(double scale)
    {
        var (bounds, min) = WindowSizing.ForMonitor(scale, new Rectangle(0, 0, 1920, 1040));

        Assert.Equal(new Size(1440, 900), bounds.Size);
        Assert.Equal(new Size(1024, 640), min);
    }
}
