using Kustodian.Graph.Fetch;

namespace Kustodian.Graph.Tests.Fetch;

public sealed class GraphFetchBudgetTests
{
    [Fact]
    public async Task Concurrent_adds_to_one_lease_never_take_more_than_it_may()
    {
        var budget = new GraphFetchBudget(maxBytes: 3000);
        using var lease = budget.Lease();

        var adds = await Task.WhenAll(Enumerable.Range(0, 10).Select(_ => Task.Run(async () =>
        {
            try
            {
                await lease.AddAsync(300, CancellationToken.None);
                return (GraphReadFailure?)null;
            }
            catch (GraphReadException e)
            {
                return e.Failure;
            }
        })));

        Assert.Equal(3, adds.Count(a => a is null));
        Assert.Equal(7, adds.Count(a => a == GraphReadFailure.TooLarge));
        Assert.Equal(2700, budget.Used);
    }

    [Fact]
    public async Task An_add_that_waits_too_long_takes_nothing()
    {
        var budget = new GraphFetchBudget(maxBytes: 3000, patience: TimeSpan.FromMilliseconds(10));
        var other = budget.Lease();
        await other.AddAsync(900, CancellationToken.None);
        using var lease = budget.Lease();

        var busy = await Assert.ThrowsAsync<GraphReadException>(() => lease.AddAsync(300, CancellationToken.None));
        other.Dispose();
        await lease.AddAsync(1000, CancellationToken.None);

        Assert.Equal(GraphReadFailure.Busy, busy.Failure);
        Assert.Equal(3000, budget.Used);
    }
}
