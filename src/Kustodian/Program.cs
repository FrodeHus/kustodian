using Kustodian.App;
using Kustodian.Engine;

namespace Kustodian;

internal static class Program
{
    /// <summary>With <c>--engine</c> the process is an engine worker and nothing of the window is loaded: the host's services
    /// and Photino live in <see cref="AppHost"/>, which is only compiled and loaded when the window opens. Before it does, a
    /// missing Linux library (WebKitGTK, libsecret) ends the app with a message that names the packages.</summary>
    [STAThread]
    private static int Main(string[] args) => EntryPoint.Dispatch(args,
        () => EngineMain.Run(Console.OpenStandardInput(), Console.OpenStandardOutput()),
        () =>
        {
            if (NativeCheck.Missing(NativeCheck.CanLoad) is { Count: > 0 } missing)
            {
                Console.Error.WriteLine(NativeCheck.Message(missing));
                return NativeCheck.ExitCode;
            }
            return AppHost.Run();
        },
        () =>
        {
            if (OperatingSystem.IsWindows())
                WindowsConsole.AttachToParentUnlessRedirected();
            Console.Out.WriteLine($"Kustodian {AppVersion.Text}");
            return 0;
        });
}
