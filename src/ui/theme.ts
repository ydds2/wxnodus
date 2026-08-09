// src/ui/theme.ts — L6-2 Kimi 风格多主题（正式版）
// 配色以 shots-kimi 抓图为准：灰阶底 + 紫色 accent + 绿色状态
export interface ThemeColors {
  bg: string; text: string; muted: string; border: string;
  accent: string; ok: string; warn: string; error: string;
  userGutter: string; statusBg: string;
}

export const THEMES: Record<string, ThemeColors> = {
  kimi: {
    bg: '#0f1115', text: '#e2e8f0', muted: '#64748b', border: '#334155',
    accent: '#a78bfa', ok: '#10b981', warn: '#f59e0b', error: '#f7768e',
    userGutter: '#10b981', statusBg: '#1a1d24',
  },
  dark: {
    bg: '#000000', text: '#d4d4d8', muted: '#52525b', border: '#3f3f46',
    accent: '#8b5cf6', ok: '#22c55e', warn: '#eab308', error: '#ef4444',
    userGutter: '#22c55e', statusBg: '#18181b',
  },
  light: {
    bg: '#ffffff', text: '#18181b', muted: '#71717a', border: '#d4d4d8',
    accent: '#7c3aed', ok: '#16a34a', warn: '#d97706', error: '#dc2626',
    userGutter: '#16a34a', statusBg: '#f4f4f5',
  },
};

export type ThemeName = keyof typeof THEMES;

export function getTheme(name: string = 'kimi'): ThemeColors {
  return THEMES[name] ?? THEMES.kimi;
}

// 兼容 handlers 的着色函数（V2 语义：chalk 风格）
import chalk from 'chalk';
export const GOLD = (s: string) => chalk.hex('#f59e0b')(s);
export const VIOLET = (s: string) => chalk.hex('#a78bfa')(s);
export const CYAN2 = (s: string) => chalk.hex('#22d3ee')(s);
export const GREEN2 = (s: string) => chalk.hex('#10b981')(s);
export const ORANGE = (s: string) => chalk.hex('#f7768e')(s);
export const DIM = (s: string) => chalk.hex('#64748b')(s);
export const ui = {
  ok: (s: string) => console.log(`✓ ${s}`),
  warn: (s: string) => console.log(`⚠ ${s}`),
  err: (s: string) => console.log(`✗ ${s}`),
  dim: (s: string) => console.log(` ${s}`),
  bold: (s: string) => s,
  info: (s: string) => console.log(s),
};
export const box = (title: string, lines: string[], opts?: { color?: (s: string) => string }): void => {
  const c = opts?.color ?? ((s: string) => s);
  const w = Math.max(...lines.map(l => l.length), title.length) + 4;
  console.log([
    `┌${'─'.repeat(w)}┐`,
    `│ ${title}${' '.repeat(w - title.length - 2)} │`,
    ...lines.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`),
    `└${'─'.repeat(w)}┘`,
  ].map(l => c(l)).join('\n'));
};
export const logo = (): string => 'WxNodus';
export const versionLabel = (v: string) => `v${v}`;
export const statusBar = (s: string) => s;
export const promptLine = (s: string) => s;
export const toolLine = (s: string) => s;
export const hr = () => '─'.repeat(30);
export const output = (s: string) => s;
