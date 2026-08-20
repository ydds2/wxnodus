// src/kernel/computer/nativeInput.ts — W8-10：robotjs 输入兜底（user32 SendInput 系统桥）
// Windows 生态互依收尾：robotjs 原生模块加载失败时，鼠标/键盘输入走系统 user32 SendInput
// （PowerShell 桥，零原生模块）——消除最后一个 npm 原生模块单点。异步 spawn 不阻塞事件循环。
import { spawn } from 'node:child_process';
import type { CuAction } from './actionLayer.js';

const KEY_MAP: Record<string, string> = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
  space: ' ', backspace: '{BACKSPACE}', delete: '{DELETE}', home: '{HOME}', end: '{END}',
  pageup: '{PGUP}', pagedown: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}', f7: '{F7}', f8: '{F8}',
  f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}', capslock: '{CAPSLOCK}', insert: '{INSERT}',
};

const escapeSendKeys = (text: string): string => text.replace(/([{}()\[\]+^%~])/g, '{$1}');

/** 纯脚本构建器（测试锚点）：CuAction → PowerShell SendInput 脚本 */
export function buildSendInputScript(a: CuAction): string {
  const body: string[] = [];
  body.push('Add-Type -AssemblyName System.Windows.Forms');
  switch (a.type) {
    case 'click': {
      const flag = a.button === 'right' ? 'MOUSEEVENTF_RIGHTDOWN/MOUSEEVENTF_RIGHTUP' : 'MOUSEEVENTF_LEFTDOWN/MOUSEEVENTF_LEFTUP';
      const rounds = a.button === 'double' ? 2 : 1;
      body.push(
        '$sig = "[DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);"',
        'Add-Type -MemberDefinition $sig -Name Win32Input -Namespace WxN',
        `[WxN.Win32Input]::SetCursorPos(${Math.round(a.x)}, ${Math.round(a.y)}) | Out-Null`,
      );
      for (let i = 0; i < rounds; i++) {
        if (flag.includes('LEFT')) {
          body.push('[WxN.Win32Input]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)', '[WxN.Win32Input]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)');
        } else {
          body.push('[WxN.Win32Input]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)', '[WxN.Win32Input]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)');
        }
      }
      break;
    }
    case 'type': {
      body.push(`[System.Windows.Forms.SendKeys]::SendWait('${escapeSendKeys(a.text).replace(/'/g, "''")}')`);
      break;
    }
    case 'key': {
      const mapped = KEY_MAP[String(a.key).toLowerCase()] ?? escapeSendKeys(String(a.key));
      body.push(`[System.Windows.Forms.SendKeys]::SendWait('${mapped.replace(/'/g, "''")}')`);
      break;
    }
    case 'scroll': {
      body.push(
        '$sig = "[DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);"',
        'Add-Type -MemberDefinition $sig -Name Win32Input -Namespace WxN',
        `[WxN.Win32Input]::mouse_event(0x0800, 0, 0, ${Math.round(a.amount) * 120}, [UIntPtr]::Zero)`,
      );
      break;
    }
    default:
      return '';
  }
  return body.join('; ');
}

export type NativeInputResult = { ok: boolean; error?: string };

/** 系统 SendInput 执行动作（win32；异步 spawn——不阻塞事件循环；失败诚实 ok:false） */
export function nativeInput(a: CuAction): Promise<NativeInputResult> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: '原生输入兜底仅 Windows 可用（非 Windows 诚实降级）' });
      return;
    }
    const script = buildSendInputScript(a);
    if (!script) {
      resolve({ ok: false, error: `动作无系统兜底实现：${(a as { type: string }).type}` });
      return;
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr!.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      resolve({ ok: false, error: '原生输入执行超时（>15s）' });
    }, 15_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: '原生输入进程启动失败' });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `原生输入失败：${String(err.trim()).slice(0, 200) || `exit ${code}`}` });
        return;
      }
      resolve({ ok: true });
    });
  });
}
