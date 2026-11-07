using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Kustodian.App;

/// <summary>Prints the page on macOS. WKWebView ignores <c>window.print()</c> unless the app's UI delegate answers WebKit's
/// private print call, and Photino's doesn't, so this asks the web view for a print operation (macOS 11's
/// <c>printOperationWithPrintInfo:</c>) and runs it as a sheet on its window: the system dialog, with Save as PDF.</summary>
[SupportedOSPlatform("macos")]
internal static partial class MacPrint
{
    private const string ObjC = "/usr/lib/libobjc.A.dylib";

    /// <summary>Starts printing the first window's web view and returns once the sheet is up. Call it on the UI thread.</summary>
    public static void Print()
    {
        var app = Send(Class("NSApplication"), "sharedApplication");
        var windows = Send(app, "windows");
        var webViewClass = Class("WKWebView");
        for (nuint i = 0, n = (nuint)Send(windows, "count"); i < n; i++)
        {
            var window = SendIndex(windows, Sel("objectAtIndex:"), i);
            if (Find(Send(window, "contentView"), webViewClass) is not 0 and var webView)
            {
                var info = Send(Class("NSPrintInfo"), "sharedPrintInfo");
                var operation = SendPtr(webView, Sel("printOperationWithPrintInfo:"), info);
                // Without a frame the operation's view is empty, and every page comes out blank.
                SendRect(Send(operation, "view"), Sel("setFrame:"), Bounds(webView));
                SendSheet(operation, Sel("runOperationModalForWindow:delegate:didRunSelector:contextInfo:"), window, 0, 0, 0);
                return;
            }
        }

        throw new InvalidOperationException("The window's web view wasn't found.");
    }

    private static nint Find(nint view, nint webViewClass)
    {
        if (view == 0 || SendBool(view, Sel("isKindOfClass:"), webViewClass) != 0)
            return view;
        var subviews = Send(view, "subviews");
        for (nuint i = 0, n = (nuint)Send(subviews, "count"); i < n; i++)
        {
            if (Find(SendIndex(subviews, Sel("objectAtIndex:"), i), webViewClass) is not 0 and var found)
                return found;
        }

        return 0;
    }

    // An NSRect is 32 bytes: x86-64 returns it through memory (objc_msgSend_stret), arm64 in registers.
    private static Rect Bounds(nint view)
    {
        if (RuntimeInformation.ProcessArchitecture != Architecture.X64)
            return SendRectResult(view, Sel("bounds"));
        SendStret(out var rect, view, Sel("bounds"));
        return rect;
    }

    private static nint Class(string name) => objc_getClass(name);

    private static nint Sel(string name) => sel_registerName(name);

    private static nint Send(nint target, string selector) => SendPtr(target, Sel(selector));

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public double X;
        public double Y;
        public double Width;
        public double Height;
    }

    [LibraryImport(ObjC, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint objc_getClass(string name);

    [LibraryImport(ObjC, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint sel_registerName(string name);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial nint SendPtr(nint target, nint selector);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial nint SendPtr(nint target, nint selector, nint arg);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial nint SendIndex(nint target, nint selector, nuint index);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial byte SendBool(nint target, nint selector, nint arg);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial void SendRect(nint target, nint selector, Rect rect);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial Rect SendRectResult(nint target, nint selector);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend_stret")]
    private static partial void SendStret(out Rect result, nint target, nint selector);

    [LibraryImport(ObjC, EntryPoint = "objc_msgSend")]
    private static partial void SendSheet(nint target, nint selector, nint window, nint del, nint didRun, nint context);
}
