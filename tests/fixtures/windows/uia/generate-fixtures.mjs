#!/usr/bin/env node
// tests/fixtures/windows/uia/generate-fixtures.mjs — 唯一的 isomorphic fixture 生成源（Win32/WPF/WinUI/Electron）
// 确定性契约：UTF-8/LF、路径排序、无时间戳/绝对路径/随机值、目标 allowlist、第二次干净生成字节一致。
// 运行：node generate-fixtures.mjs <outputDir>（默认 tests/fixtures/windows/uia）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODEL = {
  windowTitle: 'WxNodus UIA Fixture',
  controls: [
    { automationId: 'invoke', type: 'button', patterns: ['Invoke'] },
    { automationId: 'selection', type: 'list', patterns: ['Selection'] },
    { automationId: 'value', type: 'textbox', patterns: ['Value'] },
    { automationId: 'status', type: 'text', patterns: [] },
  ],
  transitions: ['invoke->invoked', 'selection:item-2->selected:item-2', 'value:text->value:text'],
};

const TARGETS = ['win32', 'wpf', 'winui', 'electron'];

// ── 各框架模板（同构控制模型：invoke 按钮 / selection 列表 / value 文本框 / status 文本） ──
const templates = {
  win32: {
    'WxNodus.Win32Fixture.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>WxNodus.Win32Fixture</AssemblyName>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
  </PropertyGroup>
</Project>
`,
    'Program.cs': `// WxNodus.Win32Fixture — 标准 Win32 控件（BUTTON→Invoke / LISTBOX→Selection / EDIT→Value / STATIC→status）
using System;
using System.Runtime.InteropServices;

internal static class Native
{
    public const int WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_OVERLAPPEDWINDOW = 0x00CF0000;
    public const int WM_CREATE = 0x0001, WM_COMMAND = 0x0111, WM_DESTROY = 0x0002, WM_CLOSE = 0x0010;
    public const int LBS_NOTIFY = 0x0001;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASS { public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName; }
    public delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern ushort RegisterClassW(ref WNDCLASS lpWndClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(int dwExStyle, string lpClassName, string lpWindowName, int dwStyle, int x, int y, int w, int h, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);
    [DllImport("user32.dll")] public static extern int GetMessageW(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern void PostQuitMessage(int nExitCode);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetWindowTextW(IntPtr hWnd, string lpString);
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
`,
  },
  wpf: {
    'WxNodus.WpfFixture.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <Nullable>enable</Nullable>
    <UseWPF>true</UseWPF>
    <AssemblyName>WxNodus.WpfFixture</AssemblyName>
  </PropertyGroup>
</Project>
`,
    'App.xaml': `<Application x:Class="WxNodus.WpfFixture.App" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" StartupUri="MainWindow.xaml" />\n`,
    'App.xaml.cs': `using System.Windows;

namespace WxNodus.WpfFixture
{
    public partial class App : Application { }
}
`,
    'MainWindow.xaml': `<Window x:Class="WxNodus.WpfFixture.MainWindow" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="WxNodus UIA Fixture" Width="420" Height="260">
  <StackPanel Margin="20">
    <Button x:Name="invoke" AutomationProperties.AutomationId="invoke" Content="Invoke Me" Click="Invoke_OnClick" />
    <ListBox x:Name="selection" AutomationProperties.AutomationId="selection" Height="96">
      <ListBoxItem>item-1</ListBoxItem>
      <ListBoxItem>item-2</ListBoxItem>
      <ListBoxItem>item-3</ListBoxItem>
    </ListBox>
    <TextBox x:Name="value" AutomationProperties.AutomationId="value" Width="180" />
    <TextBlock x:Name="status" AutomationProperties.AutomationId="status" Text="status:ready" />
  </StackPanel>
</Window>
`,
    'MainWindow.xaml.cs': `using System.Windows;

namespace WxNodus.WpfFixture
{
    public partial class MainWindow : Window
    {
        public MainWindow()
        {
            InitializeComponent();
        }

        private void Invoke_OnClick(object sender, RoutedEventArgs e)
        {
            status.Text = "invoked";
        }
    }
}
`,
  },
  winui: {
    'WxNodus.WinUiFixture.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>
    <TargetPlatformMinVersion>10.0.17763.0</TargetPlatformMinVersion>
    <RootNamespace>WxNodus.WinUiFixture</RootNamespace>
    <ApplicationManifest>app.manifest</ApplicationManifest>
    <Platforms>x86;x64;ARM64</Platforms>
    <RuntimeIdentifiers>win-x86;win-x64;win-arm64</RuntimeIdentifiers>
    <UseWinUI>true</UseWinUI>
    <EnableMsixTooling>true</EnableMsixTooling>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.WindowsAppSDK" Version="1.6.240923002" />
    <PackageReference Include="Microsoft.Windows.SDK.BuildTools" Version="10.0.26100.1742" />
  </ItemGroup>
</Project>
`,
    'app.manifest': `<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity version="1.0.0.0" name="WxNodus.WinUiFixture.app"/>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
`,
    'App.xaml': `<Application x:Class="WxNodus.WinUiFixture.App" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" />\n`,
    'App.xaml.cs': `using Microsoft.UI.Xaml;

namespace WxNodus.WinUiFixture
{
    public partial class App : Application
    {
        private Window? window;

        public App()
        {
            InitializeComponent();
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            window = new MainWindow();
            window.Activate();
        }
    }
}
`,
    'MainWindow.xaml': `<Window x:Class="WxNodus.WinUiFixture.MainWindow" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="WxNodus UIA Fixture">
  <StackPanel Margin="20" Spacing="8">
    <Button x:Name="invoke" AutomationProperties.AutomationId="invoke" Content="Invoke Me" Click="Invoke_OnClick" />
    <ListBox x:Name="selection" AutomationProperties.AutomationId="selection" Height="96">
      <ListBoxItem>item-1</ListBoxItem>
      <ListBoxItem>item-2</ListBoxItem>
      <ListBoxItem>item-3</ListBoxItem>
    </ListBox>
    <TextBox x:Name="value" AutomationProperties.AutomationId="value" Width="180" />
    <TextBlock x:Name="status" AutomationProperties.AutomationId="status" Text="status:ready" />
  </StackPanel>
</Window>
`,
    'MainWindow.xaml.cs': `using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace WxNodus.WinUiFixture
{
    public sealed partial class MainWindow : Window
    {
        public MainWindow()
        {
            InitializeComponent();
        }

        private void Invoke_OnClick(object sender, RoutedEventArgs e)
        {
            status.Text = "invoked";
        }
    }
}
`,
  },
  electron: {
    'package.json': `{
  "name": "wxnodus-uia-electron-fixture",
  "version": "31.7.7",
  "private": true,
  "main": "main.cjs",
  "scripts": {
    "start": "electron .",
    "build": "electron-packager . \"WxNodus Electron Fixture\" --platform=win32 --arch=x64 --out=dist --overwrite --prune"
  },
  "devDependencies": {
    "electron": "31.7.7",
    "electron-packager": "17.1.2"
  }
}
`,
    'main.cjs': `// WxNodus Electron Fixture — 同构控制模型（invoke 按钮/selection 列表/value 文本框/status 文本）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({ width: 420, height: 300, title: 'WxNodus UIA Fixture' });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('invoke', () => { console.log('invoked'); });
`,
    'preload.cjs': `const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('fixture', {
  reportInvoke: () => { /* renderer 侧状态翻转；状态文本由 DOM 更新 */ },
});
`,
    'index.html': `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8" /><title>WxNodus UIA Fixture</title></head>
<body>
  <button id="invoke" aria-label="invoke">Invoke Me</button>
  <select id="selection" aria-label="selection"><option>item-1</option><option>item-2</option><option>item-3</option></select>
  <input id="value" aria-label="value" type="text" />
  <div id="status" role="status">status:ready</div>
  <script>
    document.getElementById('invoke').addEventListener('click', () => {
      document.getElementById('status').textContent = 'invoked';
    });
  </script>
</body>
</html>
`,
  },
};

const filesOf = target => templates[target] ?? {};
const render = (target, name) => {
  const content = filesOf(target)[name];
  if (content === undefined) throw new Error(`unknown file ${target}/${name}`);
  return content.replace(/\r\n/g, '\n');
};

export function generateFixtures(outputDir) {
  const root = resolve(outputDir);
  const manifest = { schemaVersion: 1, model: MODEL, files: [] };
  const paths = [];
  for (const target of TARGETS) {
    for (const name of Object.keys(filesOf(target)).sort()) {
      paths.push({ target, name });
    }
  }
  for (const { target, name } of paths.sort((a, b) => `${a.target}/${a.name}`.localeCompare(`${b.target}/${b.name}`))) {
    const dir = join(root, target);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, name);
    writeFileSync(filePath, render(target, name), { encoding: 'utf8', flag: 'w' });
    manifest.files.push({ path: `${target}/${name}`, content: render(target, name) });
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? join(process.cwd(), 'tests', 'fixtures', 'windows', 'uia');
  const manifest = generateFixtures(out);
  console.log(`generated ${manifest.files.length} files into ${out}`);
}
