using Kustodian.Settings;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>settings.get</c> and <c>settings.set</c>. Both answer with the stored settings, that the limits apply at
/// startup, and whether the stored limits differ from <paramref name="startup"/>, those the app started with (so a restart is
/// needed for them to apply). Settings out of range are a <c>bad_request</c> whose message names the setting.</summary>
public sealed class SettingsHandler(SettingsService settings, LimitSettings startup)
{
    private const string AppliedAtStartup = "startup";

    public void Register(Bridge bridge)
    {
        bridge.Register("settings.get", async (_, ct) => Answer(await settings.GetAsync(ct)));
        bridge.Register("settings.set", async (p, ct) =>
        {
            var wanted = BridgeJson.Params<SetParams>(p).Settings
                ?? throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no settings.");
            try
            {
                return Answer(await settings.SetAsync(wanted, ct));
            }
            catch (SettingsRejectedException ex)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, ex.Message);
            }
        });
    }

    private SettingsAnswer Answer(AppSettings stored) => new(stored, AppliedAtStartup, stored.Limits != startup);

    private sealed record SetParams(AppSettings? Settings);

    private sealed record SettingsAnswer(AppSettings Settings, string LimitsAppliedAt, bool RestartNeeded);
}
