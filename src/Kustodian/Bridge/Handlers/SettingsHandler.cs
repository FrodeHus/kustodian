using System.Text.Json;
using System.Text.Json.Nodes;
using Kustodian.Settings;
using Kustodian.Storage;
using Kustodian.Telemetry;

namespace Kustodian.Messaging.Handlers;

/// <summary><c>settings.get</c> and <c>settings.set</c>. Both answer with the stored settings, that the limits apply at
/// startup, and whether the stored limits differ from <paramref name="startup"/>, those the app started with (so a restart is
/// needed for them to apply), and <c>corrupt</c>: whether the settings file was moved aside as corrupt this session (at
/// startup), so the defaults are in use, and <c>unreadable</c>: whether the settings file couldn't be read (or moved aside) at
/// all this session, so the defaults are in use. <c>settings.set</c> fills fields missing from (or null in) its <c>settings</c> with
/// their defaults (<see cref="JsonDefaults.Fill"/>), as a file read does. Settings out of range are a <c>bad_request</c> whose
/// message names the setting. The <paramref name="trail"/> hears <c>settings.change(&lt;name&gt;)</c> for each setting changed, by
/// its name only.</summary>
public sealed class SettingsHandler(SettingsService settings, LimitSettings startup, ErrorTrail? trail = null)
{
    private const string AppliedAtStartup = "startup";

    /// <summary>The settings' names, the only ones the trail hears, each with how to read it.</summary>
    private static readonly (string Name, Func<AppSettings, object?> Of)[] Named =
    [
        ("theme", s => s.Theme), ("rawDefaultVersion", s => s.RawDefaultVersion), ("signIn", s => s.SignIn), ("limits", s => s.Limits),
        ("telemetry", s => s.Telemetry), ("skippedVersion", s => s.SkippedVersion), ("telemetryConsent", s => s.TelemetryConsent),
        ("errorReports", s => s.ErrorReports), ("errorReportsConsent", s => s.ErrorReportsConsent),
    ];

    public void Register(Bridge bridge)
    {
        bridge.Register("settings.get", async (_, ct) => Answer(await settings.GetAsync(ct)));
        bridge.Register("settings.set", async (p, ct) =>
        {
            var wanted = Wanted(p);
            try
            {
                var before = trail is null ? null : await settings.GetAsync(ct);
                var stored = await settings.SetAsync(wanted, ct);
                foreach (var (name, of) in Named)
                {
                    if (before is not null && !Equals(of(before), of(stored)))
                    {
                        trail?.Add($"settings.change({name})");
                    }
                }

                return Answer(stored);
            }
            catch (SettingsRejectedException ex)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, ex.Message);
            }
        });
    }

    private SettingsAnswer Answer(AppSettings stored) => new(stored, AppliedAtStartup, stored.Limits != startup, settings.MovedAside, settings.Unreadable);

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

    private sealed record SettingsAnswer(AppSettings Settings, string LimitsAppliedAt, bool RestartNeeded, bool Corrupt, bool Unreadable);
}
