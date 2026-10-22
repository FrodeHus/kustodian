using Kustodian.App;
using Kustodian.Engine;

namespace Kustodian;

internal static class Program
{
    /// <summary>With <c>--engine</c> the process is an engine worker and nothing of the window is loaded: the host's services
    /// and Photino live in <see cref="AppHost"/>, which is only compiled and loaded when the window opens.</summary>
    [STAThread]
    private static int Main(string[] args) => EntryPoint.Dispatch(args,
        () => EngineMain.Run(Console.OpenStandardInput(), Console.OpenStandardOutput()),
        AppHost.Run,
        () =>
        {
            Console.Out.WriteLine($"Kustodian {AppVersion.Text}");
            return 0;
        });
}
