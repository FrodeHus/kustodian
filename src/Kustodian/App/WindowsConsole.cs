using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Kustodian.App;

/// <summary>The Windows build is a GUI executable (no console window beside the app), so it starts without a console, and a
/// terminal doesn't hand it one. Command-line output (<c>--version</c>) attaches to the console of the terminal that started
/// it first.</summary>
[SupportedOSPlatform("windows")]
internal static partial class WindowsConsole
{
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private const uint AttachParentProcess = unchecked((uint)-1);
    private const uint FileTypeDisk = 1;
    private const uint FileTypePipe = 3;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareReadWrite = 3;
    private const uint OpenExisting = 3;

    /// <summary>When stdout isn't redirected to a file or pipe, attaches to the parent's console and points stdout and stderr
    /// at it. A redirected stdout is kept as it is, and with no parent console nothing changes. Call it before anything uses
    /// <see cref="Console"/>.</summary>
    public static void AttachToParentUnlessRedirected()
    {
        var output = GetStdHandle(StdOutputHandle);
        if (IsValid(output) && GetFileType(output) is FileTypeDisk or FileTypePipe)
            return;
        if (!AttachConsole(AttachParentProcess))
            return;
        // The handles a GUI process starts with don't refer to the console it attached to; the console's own output does.
        var console = CreateFile("CONOUT$", GenericRead | GenericWrite, FileShareReadWrite, IntPtr.Zero, OpenExisting, 0,
            IntPtr.Zero);
        if (!IsValid(console))
            return;
        SetStdHandle(StdOutputHandle, console);
        SetStdHandle(StdErrorHandle, console);
    }

    private static bool IsValid(IntPtr handle) => handle != IntPtr.Zero && handle != new IntPtr(-1);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AttachConsole(uint processId);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial IntPtr GetStdHandle(int handle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetStdHandle(int handle, IntPtr value);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial uint GetFileType(IntPtr handle);

    [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags,
        IntPtr template);
}
