// src/kernel/video.ts — 逐帧（视频流）软件项目级分析
// 设计（参考 Claude 视频理解 / 多模态项目复盘）：
//   视频 = 一个软件项目的运行时间线。流程：
//   1) ffprobe 时长 → ffmpeg 密集抽帧（1 秒 1 帧，≤24 帧）
//   2) 每帧 GLM-4V 项目导向描述（界面/操作/状态/变化）
//   3) 场景变化检测（相邻帧描述文本相似度低于阈值 → 场景切换点）
//   4) GLM-4.5 文本模型综合：项目概述/功能界面/操作流程/场景时间线/
//      coding 因素（UI 结构、交互、数据流、实现要点）/改进建议
//   无 key / 无 ffmpeg 时降级为「抽帧 + 时间线描述」并给出指引
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

// 抽帧：每 intervalSec 秒 1 帧，最多 maxFrames 帧（png——mjpeg 编码在部分环境报 YUV 错误）
export function extractFrames(path: string, outDir: string, opts: { intervalSec?: number; maxFrames?: number } = {}): string[] {
  const interval = opts.intervalSec ?? 1;
  const max = opts.maxFrames ?? 24;
  rmSync(outDir, { recursive: true, force: true });
  try { mkdirSync(outDir, { recursive: true }); } catch { return []; }
  try {
    const r = spawnSync('ffmpeg', ['-y', '-i', path, '-vf', `fps=1/${interval}`, '-frames:v', String(max), join(outDir, 'f_%03d.png')], { stdio: 'pipe', timeout: 120000 });
    if (r.status !== 0) return [];
  } catch { return []; }
  try {
    return readdirSync(outDir).filter(f => f.endsWith('.png')).sort().map(f => join(outDir, f));
  } catch { return []; }
}

// 场景切换检测（纯本地确定性）：ffmpeg select scene 滤镜 → 切换时间点列表
// 无 key 降级路径的真实数据来源（不做「帧分析失败」假输出）
export function detectScenes(path: string, threshold = 0.05): number[] {
  try {
    const r = spawnSync('ffmpeg', ['-i', path, '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { stdio: 'pipe', timeout: 120000, encoding: 'utf8' });
    const stderr = String(r.stderr ?? '');
    const times: number[] = [];
    for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
      const t = parseFloat(m[1]!);
      if (Number.isFinite(t) && !times.includes(t)) times.push(t);
    }
    return times.sort((a, b) => a - b);
  } catch { return []; }
}

// 无 key 降级：场景时间线 + 帧统计（真实确定性数据）
export function localSceneTimeline(path: string): string {
  const dur = videoDuration(path);
  const scenes = detectScenes(path);
  const bounds = [0, ...scenes, dur ?? scenes.at(-1) ?? 0];
  const segs: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!, end = bounds[i + 1]!;
    if (end - start < 0.1) continue;
    segs.push(` 场景${i + 1} [${start.toFixed(1)}s - ${end.toFixed(1)}s]（${(end - start).toFixed(1)}s）`);
  }
  return [
    `本地场景分析（无 GLM key，确定性 ffmpeg 场景检测）——时长 ${dur !== null ? dur.toFixed(1) + 's' : '未知'}，场景切换点 ${scenes.length ? scenes.map(s => s.toFixed(1) + 's').join(' / ') : '无'}：`,
    ...segs,
    '',
    '配置有效 GLM key（/key set <密钥>）后重跑可升级为逐帧语义描述 + 项目级综合报告。',
  ].join('\n');
}

// 文本相似度（字符二元组重叠率）——用于场景变化检测
export function textSimilarity(a: string, b: string): number {
  const norm = (s: string) => [...s.replace(/\s+/g, '')];
  const ca = norm(a), cb = norm(b);
  if (!ca.length || !cb.length) return 0;
  const set = (arr: string[]) => { const m = new Map<string, number>(); for (const c of arr) m.set(c, (m.get(c) ?? 0) + 1); return m; };
  const ma = set(ca), mb = set(cb);
  let inter = 0, total = 0;
  for (const [c, n] of ma) { inter += Math.min(n, mb.get(c) ?? 0); total += n; }
  for (const [c, n] of mb) total += n;
  return total ? (inter * 2) / total : 0;
}

export interface FrameNote { tSec: number; desc: string }

// 逐帧描述（项目导向 prompt：界面/操作/状态/变化）
export async function describeFrames(frames: string[], dur: number | null, apiKeyEnc: string): Promise<FrameNote[]> {
  const { describeImage } = await import('./vision.js');
  const notes: FrameNote[] = [];
  const prompt = '这是一个命令行终端（CLI）界面截图。请识别并简要描述：1) 界面区域类型（启动欢迎页/对话消息流/命令建议列表/模型选择器/会话列表/输入框/底部状态栏/输出面板）；2) 可见的关键文字原样转述（标题、命令如 /status、模型名、路径、数字）；3) 正在进行的操作或状态（输入中/执行命令/显示结果/思考中）。只描述终端界面本身，不要猜测业务应用。';
  for (let i = 0; i < frames.length; i++) {
    const tSec = dur !== null ? Math.round((i / Math.max(frames.length - 1, 1)) * dur) : i;
    const desc = await describeImage(frames[i]!, apiKeyEnc, prompt);
    notes.push({ tSec, desc: desc ?? '（帧分析失败）' });
  }
  return notes;
}

// 场景分段：相邻帧相似度低于阈值 → 新场景
// 归一化：GLM-4V 描述常带模板前缀（「这是一个命令行界面的截图」），
// 去前缀+标点后再算相似度，避免模板化导致全片 1 段
const stripTemplate = (s: string) =>
  s.replace(/^(这是(一(个|张|种))?(命令行|终端|软件|程序|截图|界面)[^，。]*[，。])?/g, '').replace(/[，。；：、！？·「」"'（）()]/g, '').trim();

export function segmentScenes(notes: FrameNote[], threshold = 0.12): Array<{ startSec: number; endSec: number; frames: FrameNote[] }> {
  if (!notes.length) return [];
  const scenes: Array<{ startSec: number; endSec: number; frames: FrameNote[] }> = [{ startSec: notes[0]!.tSec, endSec: notes[0]!.tSec, frames: [notes[0]!] }];
  for (let i = 1; i < notes.length; i++) {
    const sim = textSimilarity(stripTemplate(notes[i - 1]!.desc), stripTemplate(notes[i]!.desc));
    if (sim < threshold) {
      scenes.push({ startSec: notes[i]!.tSec, endSec: notes[i]!.tSec, frames: [notes[i]!] });
    } else {
      const cur = scenes[scenes.length - 1]!;
      cur.frames.push(notes[i]!);
      cur.endSec = notes[i]!.tSec;
    }
  }
  return scenes;
}

// 项目级综合分析报告（GLM-4.5 文本模型）
export async function synthesizeProjectReport(notes: FrameNote[], scenes: Array<{ startSec: number; endSec: number; frames: FrameNote[] }>, apiKeyEnc: string): Promise<string | null> {
  const { analyzeText } = await import('./vision.js');
  const timeline = notes.map(n => `[${n.tSec}s] ${n.desc}`).join('\n');
  const sceneLines = scenes.map((s, i) => `场景${i + 1}（${s.startSec}s-${s.endSec}s，${s.frames.length} 帧）：${s.frames.map(f => f.desc).join('；')}`).join('\n');
  const prompt = [
    '你是一名资深软件项目分析专家。下面是一段软件「使用过程视频」的逐帧观察记录（时间线）和自动分段的场景信息。',
    '请把这段视频当作「一个软件项目的完整运行演示」进行项目级分析，输出结构化报告：',
    '',
    '## 1. 项目概述',
    '这是什么软件/项目？核心定位？',
    '## 2. 功能与界面',
    '展示了哪些功能？界面布局（导航/内容区/状态区）？',
    '## 3. 动态操作流程',
    '用户的操作序列：进入 → 操作 → 结果 → 反馈，逐步描述',
    '## 4. 场景变化时间线',
    '按场景分段列出各阶段发生的事（使用前/使用中/使用后场景变化）',
    '## 5. Coding 因素分析',
    '从开发者视角：UI 结构、交互设计、状态管理、数据流、潜在实现要点、可复用模式',
    '## 6. 问题与改进建议',
    '观察到的问题（布局/交互/反馈缺失等）与改进建议',
    '',
    '【逐帧时间线】',
    timeline,
    '',
    '【场景分段】',
    sceneLines,
  ].join('\n');
  return analyzeText(prompt, apiKeyEnc);
}

// 完整项目级分析入口（/video 调用）
export async function analyzeVideoAsProject(target: string, apiKeyEnc: string | null, opts?: { intervalSec?: number; maxFrames?: number }): Promise<string> {
  if (!hasFfmpeg()) return '未检测到 ffmpeg——请先安装（winget install ffmpeg 或 choco install ffmpeg）后重试';
  // 无 key：本地确定性场景分析（真实数据，不做「帧分析失败」假输出）
  if (!apiKeyEnc) return localSceneTimeline(target);
  const dur = videoDuration(target);
  const outDir = join(tmpdir(), `wxnodus-frames-${Date.now().toString(36)}`);
  const frames = extractFrames(target, outDir, opts ?? { intervalSec: 1, maxFrames: 24 });
  if (!frames.length) {
    rmSync(outDir, { recursive: true, force: true });
    return '帧提取失败（文件不是视频、ffmpeg 解码出错或路径无效）';
  }
  // 逐帧描述
  // 预检：先分析前 2 帧——key 无效/模型不可用时立即降级本地场景分析，
  // 避免 24 次无效调用空转（实测无效 key 每次 401 约 0.3s）
  const { describeImage } = await import('./vision.js');
  const probe: Array<string | null> = [];
  for (const f of frames.slice(0, 2)) probe.push(await describeImage(f, apiKeyEnc));
  if (probe.every(p => !p)) {
    rmSync(outDir, { recursive: true, force: true });
    return localSceneTimeline(target);
  }
  const notes = await describeFrames(frames, dur, apiKeyEnc);
  // 全部帧描述失败（key 无效/模型不可用）→ 同样降级为本地场景分析
  if (notes.every(n => n.desc.includes('帧分析失败'))) {
    rmSync(outDir, { recursive: true, force: true });
    return localSceneTimeline(target);
  }
  // 场景分段
  const scenes = segmentScenes(notes);
  // 项目级综合报告
  const report = await synthesizeProjectReport(notes, scenes, apiKeyEnc);
  rmSync(outDir, { recursive: true, force: true });
  if (report) return report;
  // 降级：时间线 + 场景
  return [
    `逐帧分析（${frames.length} 帧${dur !== null ? ` / ${Math.round(dur)}s` : ''}），场景 ${scenes.length} 段，综合报告生成失败——输出原始时间线：`,
    ...notes.map(n => ` [${n.tSec}s] ${n.desc}`),
  ].join('\n');
}

// 兼容旧接口：基础逐帧分析（时间线描述）
export async function analyzeVideo(target: string, apiKeyEnc: string | null, opts?: { intervalSec?: number; maxFrames?: number }): Promise<string> {
  if (!apiKeyEnc) return '视频分析需要 GLM key（/key set <key> 配置后使用）';
  if (!hasFfmpeg()) return '未检测到 ffmpeg——请先安装（winget install ffmpeg 或 choco install ffmpeg）后重试';
  const dur = videoDuration(target);
  const outDir = join(tmpdir(), `wxnodus-frames-${Date.now().toString(36)}`);
  const frames = extractFrames(target, outDir, opts ?? { intervalSec: 2, maxFrames: 12 });
  if (!frames.length) {
    rmSync(outDir, { recursive: true, force: true });
    return '帧提取失败（文件不是视频、ffmpeg 解码出错或路径无效）';
  }
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
