using System.Text.Json.Nodes;
using Kustodian.Storage;

namespace Kustodian.Tests.Storage;

/// <summary>The rule every user data file follows: fields missing from the file load with their defaults.</summary>
public sealed class UserDataFileTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "kustodian-tests-" + Guid.NewGuid().ToString("N"));
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private sealed record Inner(int Count, string? Label);

    private sealed record Sample(int Version, string Name, Inner Inner, IReadOnlyList<string> Tags);

    private static readonly Sample Defaults = new(1, "default", new Inner(7, "seven"), ["a", "b"]);

    private UserDataFile<Sample> File(Func<Sample, bool>? isValid = null)
        => new(new JsonFileStore(_dir), "sample.json", () => Defaults, isValid ?? (_ => true));

    private async Task WriteAsync(string content)
    {
        Directory.CreateDirectory(_dir);
        await System.IO.File.WriteAllTextAsync(Path.Combine(_dir, "sample.json"), content, Ct);
    }

    [Fact]
    public async Task Missing_fields_load_with_defaults_at_every_level()
    {
        await WriteAsync("""{"name":"mine","inner":{"label":"own"}}""");

        var read = await File().ReadAsync(Ct);

        Assert.False(read.Corrupt);
        Assert.Equal(new Sample(1, "mine", new Inner(7, "own"), Defaults.Tags), read.Value with { Tags = Defaults.Tags });
        Assert.Equal(["a", "b"], read.Value.Tags);
    }

    [Fact]
    public async Task Null_takes_the_default_names_match_in_any_case_and_arrays_are_replaced_whole()
    {
        await WriteAsync("""{"Name":null,"INNER":{"Count":3},"tags":["z"]}""");

        var read = await File().ReadAsync(Ct);

        Assert.False(read.Corrupt);
        Assert.Equal("default", read.Value.Name);
        Assert.Equal(new Inner(3, "seven"), read.Value.Inner);
        Assert.Equal(["z"], read.Value.Tags);
    }

    [Theory]
    [InlineData("[1]")]
    [InlineData("""{"inner":{"count":"three"}}""")]
    public async Task Content_that_is_not_an_object_or_of_the_wrong_type_is_moved_aside(string content)
    {
        await WriteAsync(content);

        var read = await File().ReadAsync(Ct);

        Assert.True(read.Corrupt);
        Assert.Equal(Defaults, read.Value);
        Assert.True(System.IO.File.Exists(Path.Combine(_dir, "sample.json.corrupt")));
    }

    [Fact]
    public async Task Validity_is_checked_after_the_defaults_are_filled_in()
    {
        await WriteAsync("""{"name":"mine"}""");

        var read = await File(s => s.Inner.Count == 7).ReadAsync(Ct);

        Assert.False(read.Corrupt);
        Assert.Equal("mine", read.Value.Name);
    }

    [Fact]
    public void Fill_leaves_the_inputs_alone()
    {
        var value = JsonNode.Parse("""{"inner":{}}""")!.AsObject();
        var defaults = JsonNode.Parse("""{"inner":{"count":1},"name":"x"}""")!.AsObject();

        var filled = JsonDefaults.Fill(value, defaults);

        Assert.Equal("""{"inner":{"count":1},"name":"x"}""", filled.ToJsonString());
        Assert.Equal("""{"inner":{}}""", value.ToJsonString());
        Assert.Equal("""{"inner":{"count":1},"name":"x"}""", defaults.ToJsonString());
    }
}
