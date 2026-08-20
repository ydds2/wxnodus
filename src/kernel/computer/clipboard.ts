// src/kernel/computer/clipboard.ts — 剪贴板（Windows PowerShell 基类；中文输入强制走此路径）
import { execFile } from 'node:child_process';

export function pasteText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // PowerShell Set-Clipboard（base64 防编码问题）
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const ps = `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | Set-Clipboard`;
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 5000 }, err => {
      if (err) reject(err); else resolve();
    });
  });
}

export function getClipboard(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))'], { timeout: 5000 }, (err, stdout) => {
      if (err) { reject(err); return; }
      try { resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8')); } catch { resolve(''); }
    });
  });
}
