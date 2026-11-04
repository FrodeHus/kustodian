using Kustodian.Telemetry;

namespace Kustodian.Messaging.Handlers;

/// <summary>The "Send details" dialog's methods. <c>errors.details {reportId}</c> answers <c>{report, canSend}</c>: the full report
/// (<see cref="FullReport"/>), or null when it is unknown or no longer kept, and whether this build can send at all (a build
/// without an Application Insights connection string can't). <c>errors.send {reportId, sections: {key: text}}</c> sends the full
/// report and answers <c>{sent: true}</c>; a changed section that isn't editable, a malformed ID or a build that can't send are a
/// <c>bad_request</c>. <c>errors.report {name, message, stack, source}</c> captures a UI error (<c>source</c> is
/// <c>boundary</c>, <c>error</c> or <c>rejection</c>) as an unexpected one and answers <c>{reportId}</c>: its automatic report
/// holds the name and the bundle's frames only (<see cref="ErrorScrubber.OfJs"/>); the message and stack go into the full report.
/// A report ID may be given as shown (<c>XXXX-XXXX</c>).</summary>
public sealed class ErrorHandler(ErrorReporter reporter, ErrorTrail? trail = null)
{
    private static readonly string[] UiSources = ["boundary", "error", "rejection"];

    public void Register(Bridge bridge)
    {
        bridge.Register("errors.details", (p, _) =>
        {
            var id = Id(BridgeJson.Params<DetailsParams>(p).ReportId);
            return Task.FromResult<object?>(new DetailsAnswer(reporter.Details(id), reporter.CanSend));
        });
        bridge.Register("errors.send", async (p, ct) =>
        {
            var request = BridgeJson.Params<SendParams>(p);
            if (!reporter.CanSend)
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "This build can't send error reports.");
            }

            if (!await reporter.SendAsync(Id(request.ReportId), request.Sections ?? new Dictionary<string, string>(), ct))
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "The report can't be sent as it is.");
            }

            return new SendAnswer(true);
        });
        bridge.Register("errors.report", (p, _) =>
        {
            var request = BridgeJson.Params<ReportParams>(p);
            if (request.Source is not { } source || !UiSources.Contains(source))
            {
                throw new BridgeException(BridgeErrorCodes.BadRequest, "A UI error's source is boundary, error or rejection.");
            }

            trail?.Add($"ui.error({source})");
            var id = reporter.Capture(new ErrorCapture($"ui.{source}", true, ErrorScrubber.OfJs(request.Name ?? "", request.Stack),
                new ErrorFacts(Source: "ui"),
                [
                    new FullReportSection("message", "Message", request.Message ?? "", false),
                    new FullReportSection("uiStack", "Stack", request.Stack ?? "", false),
                ]));
            return Task.FromResult<object?>(new ReportAnswer(id));
        });
    }

    /// <summary>The plain 8-character ID of one given as shown, with its dash.</summary>
    private static string Id(string? reportId) => (reportId ?? "").Replace("-", "", StringComparison.Ordinal);

    private sealed record DetailsParams(string? ReportId);

    private sealed record SendParams(string? ReportId, Dictionary<string, string>? Sections);

    private sealed record ReportParams(string? Name, string? Message, string? Stack, string? Source);

    private sealed record DetailsAnswer(FullReport? Report, bool CanSend);

    private sealed record SendAnswer(bool Sent);

    private sealed record ReportAnswer(string ReportId);
}
