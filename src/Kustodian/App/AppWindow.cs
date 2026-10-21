using System.Drawing;
using Kustodian.Messaging;
using Microsoft.Extensions.Logging;
using Photino.NET;

namespace Kustodian.App;

/// <summary>The app's one window: a native web view showing the embedded UI from its <see cref="AppOrigin"/>, talking to the
/// host through Photino's message channel. There is no HTTP server and no open port.</summary>
public static class AppWindow
{
    public const string Title = "Kustodian";

    /// <summary>Opens the window on the calling thread (the process's main thread) and returns when it closes.
    /// <paramref name="register"/> adds the bridge's handlers before the UI can send anything.</summary>
    public static void Run(EmbeddedAssets assets, Action<Bridge> register, ILogger<Bridge> logger)
    {
        var closed = 0;
        // Verbosity 0 from construction, so nothing is logged: Photino logs every call, and every message it sends, at
        // verbosity 1 and above, and messages carry query results. (Its SetLogVerbosity logs the call itself.)
        var window = new PhotinoWindow { LogVerbosity = 0 }
            .SetTitle(Title)
            // Without this Photino ignores the size and opens at the OS default.
            .SetUseOsDefaultSize(false)
            .SetSize(WindowSizing.Default.Width, WindowSizing.Default.Height)
            .SetMinSize(WindowSizing.Minimum.Width, WindowSizing.Minimum.Height)
            .Center();

        // On Windows those sizes reach Win32 as physical pixels, so at 200 % the page would get half of them. The monitor's DPI
        // is only known once the native window exists, so it is resized and re-centred then, before the message loop runs.
        if (OperatingSystem.IsWindows())
        {
            window.WindowCreated += (_, _) => FitToMonitor(window);
        }

        // Photino's SendWebMessage marshals to the UI thread itself (through its Invoke), so replies and events produced on
        // worker threads can be sent from there. After the window closes nothing is sent.
        void Send(string message)
        {
            if (Volatile.Read(ref closed) != 0)
            {
                return;
            }

            try
            {
                window.SendWebMessage(message);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Couldn't send a message to the UI");
            }
        }

        var bridge = new Bridge(Send, logger);
        register(bridge);

        async Task ReplyAsync(string message)
        {
            try
            {
                if (await bridge.HandleAsync(message) is { } reply)
                {
                    Send(reply);
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "A message from the UI couldn't be handled");
            }
        }

        // Messages arrive on the UI thread; the pump hands them on in order, off it, so the window never waits on a query.
        var pump = new MessagePump(ReplyAsync);
        window
            .RegisterCustomSchemeHandler(assets.Origin.Scheme, (object _, string _, string url, out string contentType) =>
                assets.Open(url, out contentType))
            .RegisterWebMessageReceivedHandler((_, message) => pump.Post(message))
            .Load(assets.Origin.StartUrl);

        window.WaitForClose();
        Volatile.Write(ref closed, 1);
        bridge.Close();
        pump.CompleteAsync().GetAwaiter().GetResult();
    }

    /// <summary>Sizes the window for the monitor it opened on: the one holding its centre, else the first one.</summary>
    private static void FitToMonitor(PhotinoWindow window)
    {
        var monitors = window.Monitors;
        if (monitors.Count == 0)
        {
            return;
        }

        var centre = new Point(window.Left + (window.Width / 2), window.Top + (window.Height / 2));
        var monitor = monitors.FirstOrDefault(m => m.MonitorArea.Contains(centre), monitors[0]);
        var (bounds, min) = WindowSizing.ForMonitor(monitor.Scale, monitor.WorkArea);
        window.MinSize = new Point(min.Width, min.Height);
        window.Size = bounds.Size;
        window.Location = bounds.Location;
    }
}
