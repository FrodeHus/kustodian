using System.Text.Json.Serialization;
using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>arm.subscriptions</c> (<c>{subscriptions}</c>), <c>arm.managementGroups</c> (<c>{groups, note?}</c>) and
/// <c>arm.resourceTypes</c> (<c>{types}</c>) for the active account, from <see cref="ArmDirectory"/>. Nobody signed in, or an ARM
/// sign-in that has to be renewed, is <c>signInNeeded</c>; an ARM token that needs the user's consent is <c>consentNeeded</c>
/// (the UI offers <c>account.consent</c>); anything else that fails is <c>failed</c> with Azure's message.</summary>
public sealed class ArmHandler(ArmDirectory directory, Func<Task<string?>> activeAccount)
{
    public const string SignInMessage = "Sign in again to list your Azure subscriptions and resources.";

    public void Register(Bridge bridge)
    {
        bridge.Register("arm.subscriptions", async (_, ct) =>
            new SubscriptionsAnswer(await CallAsync(account => directory.SubscriptionsAsync(account, ct))));
        bridge.Register("arm.managementGroups", async (_, ct) =>
        {
            var groups = await CallAsync(account => directory.ManagementGroupsAsync(account, ct));
            return new GroupsAnswer(groups.Groups, groups.Note);
        });
        bridge.Register("arm.resourceTypes", async (_, ct) =>
            new TypesAnswer(await CallAsync(account => directory.ResourceTypesAsync(account, ct))));
    }

    private async Task<T> CallAsync<T>(Func<string, Task<T>> read)
    {
        if (await activeAccount() is not { } account)
        {
            throw new BridgeException(BridgeErrorCodes.SignInNeeded, SignInMessage);
        }

        try
        {
            return await read(account);
        }
        catch (Exception ex) when (ConsentRequiredException.FindIn(ex) is { } consent)
        {
            throw new BridgeException(BridgeErrorCodes.ConsentNeeded, consent.Message);
        }
        catch (Exception ex) when (SignInRequiredException.IsIn(ex))
        {
            throw new BridgeException(BridgeErrorCodes.SignInNeeded, SignInMessage);
        }
        catch (ArmDirectoryException ex)
        {
            throw new BridgeException(BridgeErrorCodes.Failed, ex.Message);
        }
    }

    private sealed record SubscriptionsAnswer(IReadOnlyList<ArmSubscription> Subscriptions);

    private sealed record GroupsAnswer(
        IReadOnlyList<ArmManagementGroup> Groups,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Note);

    private sealed record TypesAnswer(IReadOnlyList<string> Types);
}
