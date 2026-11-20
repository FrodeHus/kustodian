using Kustodian.Graph.Run;
using Kustodian.Sources.Arg;

namespace Kustodian.Sources;

/// <summary>The account's own entry for a workspace, or the reason the run is blocked.</summary>
public union WorkspaceAccess(ArmWorkspace, string);

/// <summary>Whether a workspace the run names is one the account can see: its own list (<see cref="ArmDirectory.WorkspacesAsync"/>)
/// is the authority, never the request's. Shared by the sources that run on a workspace.</summary>
public static class WorkspaceCheck
{
    /// <summary>The account's own entry for <paramref name="workspace"/>, or the reason the run is blocked (the copy to show, or
    /// the directory's own message when the list can't be read). Sign-in and consent exceptions propagate.</summary>
    public static async Task<WorkspaceAccess> RunAsync(ArmDirectory directory, string accountKey,
        QueryWorkspace workspace, CancellationToken ct)
    {
        try
        {
            var visible = await directory.WorkspacesAsync(accountKey, ct);
            var match = visible.FirstOrDefault(w => string.Equals(w.CustomerId, workspace.CustomerId, StringComparison.OrdinalIgnoreCase));
            return match is null
                ? $"{(string.IsNullOrEmpty(workspace.Name) ? ShortId(workspace.CustomerId) : workspace.Name)} isn't available to this account. Pick a workspace."
                : match;
        }
        catch (ArmDirectoryException ex)
        {
            return ex.Message;
        }
    }

    /// <summary>An id as the pickers show it: the first and last 4 characters.</summary>
    public static string ShortId(string id) => id.Length > 12 ? $"{id[..4]}…{id[^4..]}" : id;
}
