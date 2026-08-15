// src/application/ecosystemStatus.ts — W8-11：Windows 生态互依状态面板（/eco）
// 用户方向「积极依靠 Windows 生态」：把互依关系可视化——每项系统能力真实探测
// （结果缓存，面板反复打开不反复 spawn）；非 Windows 全部 false（诚实降级）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { probeSapiTtsAvailable, probeSapiStt } from '../kernel/voice.js';
import { probeWindowsOcr } from '../kernel/computer/ocr.js';

const requireCjs = createRequire(import.meta.url);

export interface EcosystemProbe {
  capability: string;
  channel: string;
  available: boolean;
  detail: string;
}

const cache = new Map<string, EcosystemProbe>();

function cached(key: string, probe: () => EcosystemProbe): EcosystemProbe {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = probe();
  cache.set(key, value);
  return value;
}

const psProbe = (ps: string, expectZero = true): boolean => {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'pipe', timeout: 8000, windowsHide: true, encoding: 'utf8',
    });
    return expectZero ? r.status === 0 : String(r.stdout ?? '').trim().length > 0;
  } catch { return false; }
};

const fileOrDir = (p: string): boolean => { try { return existsSync(p); } catch { return false; } };

/** 真实探测全部互依能力（结果缓存——面板/状态栏高频读） */
export function probeEcosystem(dataDir: string): EcosystemProbe[] {
  if (process.platform !== 'win32') {
    return [
      { capability: 'platform', channel: 'Windows', available: false, detail: '非 Windows——互依面板仅 Windows 适用（诚实降级）' },
    ];
  }
  const whisperBin = fileOrDir(join(dataDir, 'voice', 'bin', 'Release', 'whisper-cli.exe'))
    || fileOrDir(join(dataDir, '..', 'data', 'voice', 'bin', 'Release', 'whisper-cli.exe'));
  const whisperModel = fileOrDir(join(dataDir, 'voice', 'models', 'ggml-small.bin'))
    || fileOrDir(join(dataDir, '..', 'data', 'voice', 'models', 'ggml-small.bin'));
  return [
    cached('edge', () => {
      const ok = psProbe("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe' -ErrorAction SilentlyContinue) -ne $null");
      return { capability: '浏览器', channel: '系统 Edge（playwright channel=msedge，不下载 Chromium）', available: ok, detail: ok ? 'Edge 已安装' : '未检测到 Edge（回退 Chrome）' };
    }),
    cached('sapi-tts', () => {
      const ok = probeSapiTtsAvailable();
      return { capability: '语音合成', channel: 'SAPI TTS（System.Speech）', available: ok, detail: ok ? '可用' : '不可用' };
    }),
    cached('sapi-stt', () => {
      const ok = probeSapiStt();
      return { capability: '语音识别兜底', channel: 'SAPI 8.0 Recognizer（whisper 缺失时兜底）', available: ok, detail: ok ? '可用（zh-CN/en-US）' : '不可用' };
    }),
    cached('whisper', () => ({
      capability: '语音识别主通道', channel: 'whisper.cpp（本地资产）', available: Boolean(whisperBin && whisperModel),
      detail: whisperBin && whisperModel ? 'bin + 模型就绪' : `缺失：${whisperBin ? '' : 'bin '}${whisperModel ? '' : 'model '}`.trim(),
    })),
    cached('ffmpeg', () => {
      const ok = psProbe('ffmpeg -version', true);
      return { capability: '录音采集', channel: 'ffmpeg（dshow 麦克风）', available: ok, detail: ok ? '可用' : '未安装' };
    }),
    cached('ocr', () => {
      const ok = probeWindowsOcr();
      return { capability: '图像文字识别', channel: 'Windows.Media.Ocr（WinRT，零模型下载）', available: ok, detail: ok ? '可用（zh-Hans-CN/en-US）' : '不可用' };
    }),
    cached('clipboard', () => {
      const ok = psProbe('(Get-Clipboard -Raw) -ne $null', true);
      return { capability: '剪贴板', channel: 'PowerShell Get/Set-Clipboard', available: ok, detail: ok ? '可用' : '不可用' };
    }),
    cached('uia', () => {
      const ok = psProbe('Add-Type -AssemblyName UIAutomationClient; [System.Windows.Automation.AutomationElement]::RootElement -ne $null');
      return { capability: '桌面元素控制', channel: 'System.Windows.Automation（UIA）', available: ok, detail: ok ? '可用' : '不可用' };
    }),
    cached('dotnet', () => {
      let ok = false;
      try { ok = spawnSync('dotnet', ['--version'], { stdio: 'pipe', timeout: 8000, windowsHide: true }).status === 0; } catch { ok = false; }
      return { capability: '验收 fixture 构建', channel: '.NET SDK（UIA fixture 供给）', available: ok, detail: ok ? '已安装' : '缺失（uia 验收场景 blocked）' };
    }),
    cached('robotjs', () => {
      let ok = true;
      try { requireCjs('robotjs'); } catch { ok = false; }
      return { capability: '输入主通道', channel: 'robotjs（原生模块）', available: ok, detail: ok ? '已加载' : '失败——系统 SendInput 兜底生效' };
    }),
    cached('shot', () => {
      let ok = true;
      try { requireCjs('node-screenshots'); } catch { ok = false; }
      return { capability: '截屏主通道', channel: 'node-screenshots（原生模块）', available: ok, detail: ok ? '已加载' : '失败——系统 CopyFromScreen 兜底生效' };
    }),
  ];
}

/** 面板文本（/eco） */
export function renderEcosystem(dataDir: string): string {
  const probes = probeEcosystem(dataDir);
  const available = probes.filter(p => p.available).length;
  return [
    ' Windows 生态互依（系统能力承担 / npm 原生模块仅兜底外的主通道） ',
    ...probes.map(p => `  ${p.available ? '✅' : '⬛'} ${p.capability} — ${p.channel}${p.available ? '' : `（${p.detail}）`}`),
    '',
    ` 就绪 ${available}/${probes.length}——方向：积极依靠 Windows 生态，减轻自带重量`,
  ].join('\n');
}
