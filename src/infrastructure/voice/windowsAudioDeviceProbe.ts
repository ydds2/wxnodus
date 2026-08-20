// src/infrastructure/voice/windowsAudioDeviceProbe.ts — 非交互 PowerShell 探针：稳定 MMDevice 端点 ID 为持久身份
// 友好名只作展示数据；默认设备以端点 ID 比对标记。真实 Win10/Win11 枚举/选择/热拔插契约在 W3-10 真实验收执行。
import { execFile } from 'node:child_process';
import type { AudioDeviceSnapshot } from '../../domain/voice/audioDevice.js';

// 无 shell 拼接：executable + argv 逐项传参（Global Constraints）
const PS_SCRIPT = [
  'try { Import-Module AudioDeviceCmdlets -ErrorAction SilentlyContinue } catch {}',
  'if (Get-Command Get-AudioDevice -ErrorAction SilentlyContinue) {',
  '  $def = $null; try { $def = (Get-AudioDevice -Recording).ID } catch {}',
  '  $items = Get-AudioDevice -List | Where-Object { $_.Type -eq "Recording" } |',
  '    ForEach-Object { [pscustomobject]@{ id = [string]$_.ID; name = [string]$_.Name; active = $true; default = ([string]$_.ID -eq [string]$def) } }',
  '} else {',
  '  $items = Get-CimInstance Win32_SoundDevice |',
  '    ForEach-Object { [pscustomobject]@{ id = [string]$_.PNPDeviceID; name = [string]$_.Name; active = ([string]$_.Status -eq "OK"); default = $false } }',
  '}',
  'if ($null -eq $items) { [pscustomobject]@{ id = "none"; name = ""; active = $false; default = $false } } else { $items } | ConvertTo-Json -Compress',
].join('; ');

interface ProbeItem { id?: string; name?: string; active?: boolean; default?: boolean }

export class WindowsAudioDeviceProbe {
  constructor(private readonly probeTimeoutMs = 10_000) {}

  enumerate(): Promise<AudioDeviceSnapshot[]> {
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
        windowsHide: true,
        timeout: this.probeTimeoutMs,
        maxBuffer: 1024 * 1024,
      }, (error, stdout) => {
        if (error) { reject(error); return; }
        try {
          const parsed = JSON.parse(stdout.trim() || '[]') as ProbeItem[] | ProbeItem | null;
          const list = parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed];
          const devices = list
            .filter(item => typeof item.id === 'string' && item.id && item.id !== 'none')
            .map<AudioDeviceSnapshot>(item => ({
              id: item.id!,
              name: typeof item.name === 'string' ? item.name : item.id!,
              kind: 'input',
              backend: 'windows-mmdevice',
              state: item.active === false ? 'disabled' : 'active',
              isDefault: item.default === true,
            }));
          resolve(devices);
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
  }
}
