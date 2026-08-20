// WxNodus.Win32Fixture — 标准 Win32 控件（BUTTON→Invoke / LISTBOX→Selection / EDIT→Value / STATIC→status）
using System;
using System.Runtime.InteropServices;

internal static class Native
{
    public const int WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_OVERLAPPEDWINDOW = 0x00CF0000;
    public const int WM_CREATE = 0x0001, WM_COMMAND = 0x0111, WM_DESTROY = 0x0002, WM_CLOSE = 0x0010;
    public const int LBS_NOTIFY = 0x0001;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASS { public uint style; public WndProc lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName; }
    public delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern ushort RegisterClassW(ref WNDCLASS lpWndClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(int dwExStyle, string lpClassName, string lpWindowName, int dwStyle, int x, int y, int w, int h, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);
    [DllImport("user32.dll")] public static extern int GetMessageW(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern void PostQuitMessage(int nExitCode);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetWindowTextW(IntPtr hWnd, string lpString);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandleW(string? lpModuleName);

    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int pt_x; public int pt_y; }
}

internal static class Program
{
    private static IntPtr invokeButton, selectionList, valueEdit, statusText;

    private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == Native.WM_CREATE)
        {
            invokeButton = Native.CreateWindowExW(0, "BUTTON", "Invoke Me", Native.WS_CHILD | Native.WS_VISIBLE, 20, 20, 160, 32, hWnd, (IntPtr)101, IntPtr.Zero, IntPtr.Zero);
            selectionList = Native.CreateWindowExW(0, "LISTBOX", null, Native.WS_CHILD | Native.WS_VISIBLE | Native.LBS_NOTIFY, 20, 70, 160, 96, hWnd, (IntPtr)102, IntPtr.Zero, IntPtr.Zero);
            for (int i = 0; i < 3; i++) { _ = Native.SendMessageW(selectionList, 0x0180 /*LB_ADDSTRING*/, IntPtr.Zero, System.Runtime.InteropServices.Marshal.StringToHGlobalUni("item-" + (i + 1))); }
            valueEdit = Native.CreateWindowExW(0, "EDIT", null, Native.WS_CHILD | Native.WS_VISIBLE, 200, 20, 180, 24, hWnd, (IntPtr)103, IntPtr.Zero, IntPtr.Zero);
            statusText = Native.CreateWindowExW(0, "STATIC", "status:ready", Native.WS_CHILD | Native.WS_VISIBLE, 200, 70, 180, 24, hWnd, (IntPtr)104, IntPtr.Zero, IntPtr.Zero);
            return IntPtr.Zero;
        }
        if (msg == Native.WM_COMMAND)
        {
            int id = (int)((long)wParam & 0xFFFF);
            if (id == 101) Native.SetWindowTextW(statusText, "invoked");
            return IntPtr.Zero;
        }
        if (msg == Native.WM_DESTROY) { Native.PostQuitMessage(0); return IntPtr.Zero; }
        return Native.DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    [STAThread]
    public static int Main()
    {
        var wc = new Native.WNDCLASS
        {
            lpfnWndProc = WndProc,
            hInstance = Native.GetModuleHandleW(null),
            lpszClassName = "WxNodusUiaFixtureWindow",
        };
        _ = Native.RegisterClassW(ref wc);
        IntPtr hWnd = Native.CreateWindowExW(0, "WxNodusUiaFixtureWindow", "WxNodus UIA Fixture", Native.WS_OVERLAPPEDWINDOW | Native.WS_VISIBLE, 100, 100, 420, 260, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        Native.MSG msg;
        while (Native.GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) { Native.TranslateMessage(ref msg); _ = Native.DispatchMessageW(ref msg); }
        return 0;
    }
}

internal static class NativeExtra
{
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
