using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json.Nodes;
using Kustodian.App;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Kustodian.Telemetry;

/// <summary>
/// Sends events to Application Insights, and nothing else. It posts the event envelope itself instead of using the SDK, so no
/// request, dependency, machine name, user or session is ever collected: an event holds its name, its time, the app's version
/// and the properties <see cref="TrackEventAsync"/> is given. The client IP is sent as <c>0.0.0.0</c>, so Application Insights
/// derives no location from it. A send that fails is dropped; telemetry never fails or slows what the user is doing.
/// </summary>
public sealed class AppInsightsTelemetry(HttpClient http, string connectionString, TimeProvider time,
    ILogger<AppInsightsTelemetry>? logger = null)
{
    /// <summary>Kustodian's Application Insights resource, built in by the release workflow (<c>TelemetryConnectionString</c>
    /// assembly metadata). Empty, as in a local build or a fork's, sends nothing.</summary>
    public static string ConnectionString { get; } = typeof(AppInsightsTelemetry).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(a => a.Key == "TelemetryConnectionString")?.Value ?? "";

    private const string DefaultEndpoint = "https://dc.services.visualstudio.com/";

    private readonly (string Key, Uri Endpoint)? _target = Parse(connectionString);
    private readonly ILogger<AppInsightsTelemetry> _log = logger ?? NullLogger<AppInsightsTelemetry>.Instance;

    /// <summary>Whether a connection string is set, so events go somewhere.</summary>
    public bool Configured => _target is not null;

    /// <summary>Sends one event. Never throws: a failure is logged and the event dropped.</summary>
    public async Task TrackEventAsync(string name, IReadOnlyDictionary<string, string> properties, CancellationToken ct = default)
    {
        if (_target is not { } target)
            return;

        var envelope = new JsonObject
        {
            ["name"] = "Microsoft.ApplicationInsights.Event",
            ["time"] = time.GetUtcNow().ToString("O"),
            ["iKey"] = target.Key,
            ["tags"] = new JsonObject { ["ai.application.ver"] = AppVersion.Text, ["ai.location.ip"] = "0.0.0.0" },
            ["data"] = new JsonObject
            {
                ["baseType"] = "EventData",
                ["baseData"] = new JsonObject
                {
                    ["ver"] = 2,
                    ["name"] = name,
                    ["properties"] = new JsonObject(properties.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
                },
            },
        };

        try
        {
            using var response = await http.PostAsJsonAsync(new Uri(target.Endpoint, "v2/track"), new JsonArray(envelope), ct);
            if (!response.IsSuccessStatusCode)
                _log.LogDebug("Telemetry event {Name} was refused ({Status})", name, (int)response.StatusCode);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            _log.LogDebug("Telemetry event {Name} was not sent ({Error})", name, ex.GetType().Name);
        }
    }

    /// <summary>The instrumentation key and ingestion endpoint of <paramref name="text"/>, or null without a key.</summary>
    private static (string Key, Uri Endpoint)? Parse(string text)
    {
        var parts = text.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(p => p.Split('=', 2))
            .Where(p => p.Length == 2)
            .DistinctBy(p => p[0], StringComparer.OrdinalIgnoreCase)
            .ToDictionary(p => p[0], p => p[1], StringComparer.OrdinalIgnoreCase);
        if (!parts.TryGetValue("InstrumentationKey", out var key) || key.Length == 0)
            return null;
        var endpoint = parts.TryGetValue("IngestionEndpoint", out var e) ? e : DefaultEndpoint;
        return (key, new Uri(endpoint.EndsWith('/') ? endpoint : endpoint + "/"));
    }
}
