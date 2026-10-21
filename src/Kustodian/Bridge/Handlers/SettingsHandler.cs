using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Settings;
using Kustodian.Storage;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>settings.get</c> and <c>settings.set</c>. Both answer with the stored settings, that the limits apply at
/// startup, and whether the stored limits differ from <paramref name="startup"/>, those the app started with (so a restart is
/// needed for them to apply), and <c>corrupt</c>: whether the settings file was moved aside as corrupt this session (at
/// startup), so the defaults are in use. <c>settings.set</c> fills fields missing from (or null in) its <c>settings</c> with
/// their defaults (<see cref="JsonDefaults.Fill"/>), as a file read does. Settings out of range are a <c>bad_request</c> whose
/// message names the setting.</summary>
public sealed class SettingsHandler(SettingsService settings, LimitSettings startup)
{
    private const string AppliedAtStartup = "startup";

    public void Register(Bridge bridge)
    {
        bridge.Register("settings.get", async (_, ct) => Answer(await settings.GetAsync(ct)));
        bridge.Register("settings.set", async (p, ct) =>
        {
            var wanted = Wanted(p);
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

    private SettingsAnswer Answer(AppSettings stored) => new(stored, AppliedAtStartup, stored.Limits != startup, settings.MovedAside);

    /// <summary>The <c>settings</c> of a <c>settings.set</c>, with missing fields taken from the defaults.</summary>
    private static AppSettings Wanted(JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("settings", out var element)
            || element.ValueKind != JsonValueKind.Object)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no settings.");
        }

        try
        {
            var defaults = JsonSerializer.SerializeToNode(AppSettings.Default, BridgeJson.Options)!.AsObject();
            return JsonDefaults.Fill(JsonObject.Create(element)!, defaults).Deserialize<AppSettings>(BridgeJson.Options)
                ?? throw new BridgeException(BridgeErrorCodes.BadRequest, "The request has no settings.");
        }
        catch (JsonException)
        {
            throw new BridgeException(BridgeErrorCodes.BadRequest, "The request's params are not valid.");
        }
    }

    private sealed record SettingsAnswer(AppSettings Settings, string LimitsAppliedAt, bool RestartNeeded, bool Corrupt);
}
