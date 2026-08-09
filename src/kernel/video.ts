// src/kernel/video.ts — 逐帧（视频流）分析
// 流程：ffprobe 取时长 → ffmpeg 按采样间隔抽帧 → GLM-4V 逐帧描述 → 时间线汇总
// 参考：Claude 视频分析 / 多模态视频摘要的「抽帧 + 逐帧描述 + 时间线拼接」方案
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function hasFfmpeg(): boolean {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe', timeout: 10000 });
    return r.status === 0;
  } catch { return false; }
}

export function videoDuration(path: string): number | null {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { stdio: 'pipe', timeout: 30000 });
    if (r.status !== 0) return null;
    const d = parseFloat(String(r.stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch { return null; }
}

// 抽帧：每 intervalSec 秒 1 帧，最多 maxFrames 帧（jpg）
export function extractFrames(path: string, outDir: string, opts: { intervalSec?: number; maxFrames?: number } = {}): string[] {
  const interval = opts.intervalSec ?? 2;
  const max = opts.maxFrames ?? 12;
  rmSync(outDir, { recursive: true, force: true });
  try { mkdirSync(outDir, { recursive: true }); } catch { return []; }
  try {
    const r = spawnSync('ffmpeg', ['-y', '-i', path, '-vf', `fps=1/${interval}`, '-frames:v', String(max), join(outDir, 'f_%03d.jpg')], { stdio: 'pipe', timeout: 120000 });
    if (r.status !== 0) return [];
  } catch { return []; }
  try {
    return readdirSync(outDir).filter(f => f.endsWith('.jpg')).sort().map(f => join(outDir, f));
  } catch { return []; }
}

export interface VideoAnalysisResult { frames: number; analyzed: number; timeline: string[]; summary: string }

// 逐帧分析：采样最多 6 帧送 GLM-4V，输出时间线描述
export async function analyzeVideo(target: string, apiKeyEnc: string | null, opts?: { intervalSec?: number; maxFrames?: number }): Promise<string> {
  if (!apiKeyEnc) return '视频分析需要 GLM key（/key set <key> 配置后使用）';
  if (!hasFfmpeg()) return '未检测到 ffmpeg——请先安装（winget install ffmpeg 或 choco install ffmpeg）后重试';
  const dur = videoDuration(target);
  const outDir = join(tmpdir(), `wxnodus-frames-${Date.now().toString(36)}`);
  const frames = extractFrames(target, outDir, opts ?? {});
  if (!frames.length) {
    rmSync(outDir, { recursive: true, force: true });
    return '帧提取失败（文件不是视频、ffmpeg 解码出错或路径无效）';
  }
  // 时间线采样：均匀取 ≤6 帧（含首尾）
  const want = Math.min(frames.length, 6);
  const idxs: number[] = [];
  for (let i = 0; i < want; i++) idxs.push(Math.round((i / Math.max(want - 1, 1)) * (frames.length - 1)));
  const uniq = [...new Set(idxs)];
  const { describeImage } = await import('./vision.js');
  const timeline: string[] = [];
  for (const i of uniq) {
    const t = dur !== null ? `${Math.round((i / Math.max(frames.length - 1, 1)) * dur)}s` : `帧${i + 1}`;
    const desc = await describeImage(frames[i]!, apiKeyEnc);
    timeline.push(` [${t}] ${desc ?? '（该帧分析失败，可能超出单次限制）'}`);
  }
  rmSync(outDir, { recursive: true, force: true });
  return [
    `逐帧分析完成：共抽取 ${frames.length} 帧，采样分析 ${uniq.length} 帧${dur !== null ? `（时长 ${Math.round(dur)}s）` : ''}`,
    ...timeline,
  ].join('\n');
}
