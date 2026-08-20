// src/kernel/offlineModel.ts — manifest-verified offline model packs and isolated inference workers
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveDataDir } from './paths.js';

export interface OfflineModelInfo {
  id: string;
  revision: string;
  sizeGB: string;
  speed: string;
  note: string;
}

/**
 * The downloaded byte set is pinned by the generated manifest. Upstream commit SHAs can replace
 * `main` here without changing the manifest contract when approved immutable revisions are known.
 */
export const OFFLINE_MODELS: Record<string, OfflineModelInfo> = {
  'offline:Qwen2.5-1.5B': {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    revision: 'main',
    sizeGB: '~1.2GB',
    speed: 'CPU ~15-30 tok/s',
    note: '中文优先，对话/规格化/摘要够用',
  },
  'offline:Qwen2.5-3B': {
    id: 'onnx-community/Qwen2.5-3B-Instruct',
    revision: 'main',
    sizeGB: '~2.5GB',
    speed: 'CPU ~8-15 tok/s',
    note: '质量更高，慢一档',
  },
};

const MANIFEST_NAME = '.wxnodus-offline-manifest.json';
const MANIFEST_VERSION = 1;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

interface OfflineManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface OfflineModelManifest {
  version: typeof MANIFEST_VERSION;
  model: string;
  modelId: string;
  revision: string;
  contentSha256: string;
  files: OfflineManifestFile[];
}

interface WorkerMessage {
  type: 'token' | 'reasoning' | 'progress' | 'result';
  text?: string;
  progress?: OfflineDownloadProgress;
  result?: OfflineChatResult | { ok: boolean; message: string };
}

interface OfflineWorkerLike {
  on(event: 'message', listener: (message: WorkerMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  off(event: 'message', listener: (message: WorkerMessage) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export interface OfflineDownloadProgress {
  status: string;
  file?: string;
  /** 0-100（progress 字段优先；缺省按 loaded/total 估算） */
  percent: number;
}

export interface OfflineChatOpts {
  messages: Array<{ role: string; content: unknown }>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onToken?: (t: string) => void;
  onReasoning?: (t: string) => void;
}

export type OfflineChatResult =
  | { ok: true; content: string; usage?: { promptTokens: number; completionTokens: number } }
  | { ok: false; error: string };

export function offlineModelId(model: string | undefined | null): string | null {
  return OFFLINE_MODELS[String(model ?? '')]?.id ?? null;
}

function modelCacheRoot(dataDir: string): string {
  return join(dataDir, 'models');
}

function modelDirectory(model: string, dataDir: string): string | null {
  const info = OFFLINE_MODELS[model];
  if (!info) return null;
  const base = join(modelCacheRoot(dataDir), ...info.id.split('/'));
  return info.revision === 'main' ? base : join(base, info.revision);
}

function normalizeManifestPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function listPackFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === MANIFEST_NAME || name === `${MANIFEST_NAME}.tmp`) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`离线模型包不允许符号链接：${normalizeManifestPath(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(path);
    }
  };
  walk(root);
  return files;
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = openSync(path, 'r');
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function contentHash(files: OfflineManifestFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  return hash.digest('hex');
}

function hasRequiredFiles(files: OfflineManifestFile[]): boolean {
  const paths = new Set(files.map(file => file.path));
  return paths.has('config.json') && paths.has('tokenizer.json') && files.some(file => file.path.toLowerCase().endsWith('.onnx'));
}

function buildManifest(model: string, dataDir: string): OfflineModelManifest {
  const info = OFFLINE_MODELS[model];
  const root = modelDirectory(model, dataDir);
  if (!info || !root || !statSync(root).isDirectory()) throw new Error(`离线模型目录不存在：${model}`);
  const files = listPackFiles(root).map(path => ({
    path: normalizeManifestPath(root, path),
    bytes: statSync(path).size,
    sha256: sha256File(path),
  }));
  if (!hasRequiredFiles(files)) throw new Error('离线模型包缺少 config.json、tokenizer.json 或 ONNX 权重');
  return {
    version: MANIFEST_VERSION,
    model,
    modelId: info.id,
    revision: info.revision,
    contentSha256: contentHash(files),
    files,
  };
}

export function createOfflineModelManifest(
  model: string,
  dataDir = resolveDataDir(process.cwd()),
): { ok: true; manifest: OfflineModelManifest } | { ok: false; error: string } {
  const root = modelDirectory(model, dataDir);
  if (!root) return { ok: false, error: `未知离线模型：${model}` };
  try {
    const manifest = buildManifest(model, dataDir);
    const target = join(root, MANIFEST_NAME);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    renameSync(temporary, target);
    return { ok: true, manifest };
  } catch (error) {
    try { unlinkSync(join(root, `${MANIFEST_NAME}.tmp`)); } catch { /* no temporary manifest */ }
    return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 300) };
  }
}

function parseManifest(raw: string): OfflineModelManifest | null {
  try {
    const value = JSON.parse(raw) as Partial<OfflineModelManifest>;
    if (value.version !== MANIFEST_VERSION || typeof value.model !== 'string' ||
        typeof value.modelId !== 'string' || typeof value.revision !== 'string' ||
        typeof value.contentSha256 !== 'string' || !Array.isArray(value.files)) return null;
    if (value.files.some(file => !file || typeof file.path !== 'string' || file.path.includes('..') ||
        typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))) return null;
    return value as OfflineModelManifest;
  } catch {
    return null;
  }
}

/** Readiness means the complete, expected byte set matches its versioned manifest. */
export function isOfflineModelReady(
  model: string | undefined | null,
  dataDir = resolveDataDir(process.cwd()),
): boolean {
  const name = String(model ?? '');
  const info = OFFLINE_MODELS[name];
  const root = modelDirectory(name, dataDir);
  if (!info || !root) return false;
  try {
    const manifest = parseManifest(readFileSync(join(root, MANIFEST_NAME), 'utf8'));
    if (!manifest || manifest.model !== name || manifest.modelId !== info.id || manifest.revision !== info.revision ||
        !hasRequiredFiles(manifest.files) || manifest.contentSha256 !== contentHash(manifest.files)) return false;
    const actualPaths = listPackFiles(root).map(path => normalizeManifestPath(root, path));
    if (actualPaths.length !== manifest.files.length || actualPaths.some((path, index) => path !== manifest.files[index]?.path)) return false;
    return manifest.files.every(file => {
      const path = join(root, ...file.path.split('/'));
      const stat = statSync(path);
      return stat.isFile() && stat.size === file.bytes && sha256File(path) === file.sha256;
    });
  } catch {
    return false;
  }
}

export function normalizePipelineProgress(raw: unknown): OfflineDownloadProgress {
  const p = (raw ?? {}) as Record<string, unknown>;
  const loaded = Number(p.loaded ?? 0);
  const total = Number(p.total ?? 0);
  const percent = typeof p.progress === 'number'
    ? Math.max(0, Math.min(100, p.progress))
    : total > 0
      ? Math.max(0, Math.min(100, (loaded / total) * 100))
      : 0;
  return {
    status: String(p.status ?? 'progress'),
    file: typeof p.file === 'string' ? p.file : undefined,
    percent: Math.round(percent * 10) / 10,
  };
}

/** Resolve only after isolated work has stopped; late worker output is fenced. */
export function runOfflineWorkerTask(
  worker: OfflineWorkerLike,
  opts: {
    signal?: AbortSignal;
    timeoutMs: number;
    onToken?: (text: string) => void;
    onReasoning?: (text: string) => void;
    onProgress?: (progress: OfflineDownloadProgress) => void;
  },
): Promise<OfflineChatResult | { ok: boolean; message: string }> {
  return new Promise(resolve => {
    let terminal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const stop = async (result: OfflineChatResult | { ok: boolean; message: string }): Promise<void> => {
      if (terminal) return;
      terminal = true;
      cleanup();
      try { await worker.terminate(); } catch { /* the worker may already have exited */ }
      resolve(result);
    };
    const onAbort = (): void => { void stop({ ok: false, error: '已中断' }); };
    const onMessage = (message: WorkerMessage): void => {
      if (terminal) return;
      if (message.type === 'token' && message.text) opts.onToken?.(message.text);
      else if (message.type === 'reasoning' && message.text) opts.onReasoning?.(message.text);
      else if (message.type === 'progress' && message.progress) opts.onProgress?.(message.progress);
      else if (message.type === 'result' && message.result) void stop(message.result);
    };
    const onError = (error: Error): void => {
      void stop({ ok: false, error: `本地推理 worker 失败：${error.message.slice(0, 150)}` });
    };
    const onExit = (code: number): void => {
      if (!terminal) void stop({ ok: false, error: `本地推理 worker 提前退出（code ${code}）` });
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      void stop({ ok: false, error: `离线推理超时（>${opts.timeoutMs / 1000}s）` });
    }, opts.timeoutMs);
  });
}

function createWorker(data: Record<string, unknown>): Worker {
  return new Worker(new URL('./offlineModelWorker.js', import.meta.url), { workerData: data });
}

export async function callOfflineLlm(model: string, opts: OfflineChatOpts): Promise<OfflineChatResult> {
  const info = OFFLINE_MODELS[model];
  if (!info) return { ok: false, error: `未知离线模型：${model}` };
  const dataDir = resolveDataDir(process.cwd());
  if (!isOfflineModelReady(model, dataDir)) {
    return { ok: false, error: '离线模型完整性校验失败——请用 /offline pack download 重新下载' };
  }
  const worker = createWorker({
    task: 'infer',
    modelId: info.id,
    revision: info.revision,
    cacheDir: modelCacheRoot(dataDir),
    messages: opts.messages,
  });
  const result = await runOfflineWorkerTask(worker, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 180_000,
    onToken: opts.onToken,
    onReasoning: opts.onReasoning,
  });
  if ('message' in result) return { ok: false, error: result.message };
  return result;
}

export async function downloadOfflineModel(
  model: string,
  onProgress?: (p: OfflineDownloadProgress) => void,
): Promise<{ ok: boolean; message: string }> {
  const info = OFFLINE_MODELS[model];
  if (!info) return { ok: false, message: `未知离线模型：${model}` };
  const dataDir = resolveDataDir(process.cwd());
  const worker = createWorker({
    task: 'download',
    modelId: info.id,
    revision: info.revision,
    cacheDir: modelCacheRoot(dataDir),
  });
  const result = await runOfflineWorkerTask(worker, {
    timeoutMs: 30 * 60_000,
    onProgress,
  });
  if (!('message' in result)) {
    const error = result.ok ? 'worker 返回了非下载结果' : result.error;
    return { ok: false, message: `下载失败：${error}（需要网络；成功后断网可用）` };
  }
  if (!result.ok) {
    return { ok: false, message: `下载失败：${result.message}（需要网络；成功后断网可用）` };
  }
  const manifest = createOfflineModelManifest(model, dataDir);
  if (!manifest.ok) return { ok: false, message: `下载完成但完整性清单创建失败：${manifest.error}` };
  return {
    ok: true,
    message: `离线模型已就绪：${model}（缓存 ${modelCacheRoot(dataDir)}，SHA-256 ${manifest.manifest.contentSha256.slice(0, 12)}…）——断网可用`,
  };
}

export async function ensureOfflineModelReady(
  model: string,
  onProgress?: (p: OfflineDownloadProgress) => void,
): Promise<{ ok: boolean; message: string; already?: boolean }> {
  if (isOfflineModelReady(model)) return { ok: true, message: `${model} 已就绪——断网可用`, already: true };
  const result = await downloadOfflineModel(model, onProgress);
  return { ...result, already: false };
}

export function offlineCacheBytes(): number {
  try {
    const root = modelCacheRoot(resolveDataDir(process.cwd()));
    let total = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        try {
          const stat = statSync(path);
          if (stat.isDirectory()) walk(path);
          else total += stat.size;
        } catch { /* ignore concurrently removed cache entries */ }
      }
    };
    walk(root);
    return total;
  } catch {
    return 0;
  }
}

export function offlineManifestName(): string {
  return basename(MANIFEST_NAME);
}

export function offlineManifestDirectory(model: string, dataDir = resolveDataDir(process.cwd())): string | null {
  const root = modelDirectory(model, dataDir);
  return root ? dirname(join(root, MANIFEST_NAME)) : null;
}
