// src/kernel/versionChange.ts — 版本变更检测（升级后首启提示的数据源）
// 背景（用户实测报告 2026-08-21）：npm link 切到 4.0 后进入 TUI 零版本反馈——
// 用户不知道升级是否生效。机制：dataDir/last-version.json 记上次运行版本，
// 不一致即返回提示文案并落盘新版本；一致返回 null（零输出）。
// 对齐：claude code/codex 启动显版本 + 更新后 release notes 可见——本模块是
// 「已更新 x→y」一行的判定器（纯 IO，可单测）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WXNODUS_VERSION } from './version.js';

const LAST_VERSION_FILE = 'last-version.json';

/** 检测版本变更：变更返回提示文案（并落盘当前版本）；未变更/首启落盘后返回 null */
export function detectVersionChange(dataDir: string, currentVersion: string = WXNODUS_VERSION): string | null {
  const file = join(dataDir, LAST_VERSION_FILE);
  let prev: string | null = null;
  try {
    prev = String((JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version ?? '') || null;
  } catch { /* 首启/损坏——prev=null */ }
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: currentVersion, at: Date.now() }, null, 2), 'utf8');
  } catch { /* 落盘失败不阻断（下次再提示） */ }
  if (!prev || prev === currentVersion) return null;
  return `↻ wxnodus 已更新 ${prev} → ${currentVersion}（/version 查看 · 重启后生效的变更见 CHANGELOG）`;
}
