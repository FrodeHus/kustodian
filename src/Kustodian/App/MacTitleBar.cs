using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Kustodian.App;

/// <summary>The macOS window's title bar: transparent, with the page drawn under it, so the page's own top bar is the title bar
/// and the traffic lights sit on it. An empty toolbar in the compact style makes the title bar as tall as the page's top bar
/// (38px) and centres the traffic lights in it. The page can't mark areas that move the window (WKWebView has no
/// <c>-webkit-app-region</c>), so it asks the host to drag or zoom the window from its top bar.</summary>
[SupportedOSPlatform("macos")]
internal static partial class MacTitleBar
{
    private const string ObjC = "/usr/lib/libobjc.A.dylib";
    private const nuint FullSizeContentView = 1 << 15;
    private const nint TitleHidden = 1;
    private const nint ToolbarStyleUnifiedCompact = 4;
    private const nint SeparatorNone = 1;

    /// <summary>Lets the page fill the title bar. Call it on the UI thread once the window exists.</summary>
    public static void Apply()
    {
        var window = MacPrint.WebViewWindow(out _);
        SendUInt(window, Sel("setStyleMask:"), (nuint)Send(window, "styleMask") | FullSizeContentView);
        SendBool(window, Sel("setTitlebarAppearsTransparent:"), 1);
        SendInt(window, Sel("setTitleVisibility:"), TitleHidden);
        SendPtr(window, Sel("setToolbar:"), Send(Send(Class("NSToolbar"), "alloc"), "init"));
        SendInt(window, Sel("setToolbarStyle:"), ToolbarStyleUnifiedCompact);
        SendInt(window, Sel("setTitlebarSeparatorStyle:"), SeparatorNone);
    }

    /// <summary>Moves the window with the mouse from the mouse-down that is being handled, as a press on a title bar does.
    /// Call it on the UI thread.</summary>
    public static void Drag()
    {
        var window = MacPrint.WebViewWindow(out _);
        // The page's message arrives after its mouse-down: with no event left, there is nothing to drag with.
        if (Send(Send(Class("NSApplication"), "sharedApplication"), "currentEvent") is not 0 and var mouseDown)
        {
            SendPtr(window, Sel("performWindowDragWithEvent:"), mouseDown);
        }
    }

    /// <summary>Zooms the window, as a double-click on a title bar does. Call it on the UI thread.</summary>
    // shortcut: always zooms, ignoring the "double-click a window's title bar to" setting (minimise / do nothing); read
    // AppleActionOnDoubleClick from NSUserDefaults if anyone uses the other choices.
    public static void Zoom() => SendPtr(MacPrint.WebViewWindow(out _), Sel("performZoom:"), 0);

    private static nint Class(string name) => objc_getClass(name);

    private static nint Sel(string name) => sel_registerName(name);

    private static nint Send(nint target, string selector) => SendPtr(target, Sel(selector));

    [LibraryImport(ObjC, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint objc_getClass(string name);

    [LibraryImport(ObjC, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint sel_registerName(string name);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial nint SendPtr(nint target, nint selector);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial nint SendPtr(nint target, nint selector, nint arg);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial void SendUInt(nint target, nint selector, nuint arg);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial void SendInt(nint target, nint selector, nint arg);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial void SendBool(nint target, nint selector, byte arg);
}
