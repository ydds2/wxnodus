// tests/wave8/w8-02-systemdir.test.ts — W8-02：系统目录感知确认（classifier + 管线 system-touch）
// 契约：分类正确（系统目录/隐藏·系统属性/reparse/workspace/other）；管线 decide 对 system-touch
// 强制专属确认（SYSTEM_TOUCH_REQUIRES_CONFIRMATION + 分类理由透出审批）；未确认零副作用；
// 普通工作区文件不受影响；非 win32 诚实降级 other。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyWindowsPath, classifyPipelineArgs, commandTouchesSystemPath } from '../../src/infrastructure/fs/windowsPathClassifier.js';
import { createProductionToolExecution } from '../../src/application/tools/toolExecutionWiring.js';
import { openDB, closeDB } from '../../src/store/db.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';
import type { ToolId } from '../../src/domain/tools/toolIds.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const isWin = process.platform === 'win32';
// 夹具根显式放 LOCALAPPDATA：分类前提「temp 在 user-appdata 下」——CI runner 的 tmpdir 是
// D:\a\_temp（junction 且非 appdata），不强制会分类漂移（2026-08-18 CI 实测）
const appdataTempRoot = () => { const p = join(process.env.LOCALAPPDATA ?? tmpdir(), 'w8-sysdir-tmp'); mkdirSync(p, { recursive: true }); return p; };
const tmp = () => { const d = mkdtempSync(appdataTempRoot()); cleanup.push(() => { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } }); return d; };
const policyDoc = {
  version: 1 as const,
  hardRedlineKinds: [],
  rules: [
    { effectKind: 'memory.read', action: 'allow' as const },
    { effectKind: 'filesystem.read', action: 'allow' as const },
    { effectKind: 'filesystem.write', action: 'allow' as const }, // 刻意 allow——system-touch 在策略之上独立强制
    { effectKind: 'process.spawn', action: 'allow' as const },
  ],
};

function fixture(approver: (req: { toolId: unknown; args: unknown; effect: unknown; reasonCode?: string; obligations?: unknown[] }) => Promise<boolean> = async () => false) {
  const dir = mkdtempSync(appdataTempRoot());
  const db = openDB(dir);
  const memoryRepository = openMemoryRepository(db, { now: () => Date.now(), idFactory: p => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
  cleanup.push(() => { try { closeDB(db); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  const pipeline = createProductionToolExecution({
    db, dataDir: dir, workspaceRoot: dir, memoryRepository,
    policy: { id: 'policy-1', document: policyDoc },
    budget: { id: 'budget-1', limits: { externalWrites: 4, networkRequests: 2, processSpawns: 4 } },
    approver,
  });
  let seq = 0;
  const context = (): OperationContext => ({
    actorId: 'actor:test', sessionId: 's1', runId: 'r1', correlationId: `corr-${++seq}`,
    policySnapshotId: 'unused', locale: 'zh-CN', source: 'cli',
    capabilities: [], timestamp: '2026-08-15T00:00:00.000Z',
  });
  return { dir, db, pipeline, context };
}

describe('W8-02 系统路径分类器', () => {
  it('win32 分类表：系统目录/ProgramData/AppData/工作区/其他', () => {
    if (!isWin) { expect(classifyWindowsPath('C:/x', { workspaceRoot: 'C:/work', platform: 'linux' }).class).toBe('other'); return; }
    const env = process.env;
    expect(classifyWindowsPath(`${env.WINDIR ?? 'C:\\Windows'}\\System32\\cmd.exe`, { workspaceRoot: 'C:/work' }).class).toBe('system-windows');
    expect(classifyWindowsPath(`${env.ProgramFiles ?? 'C:\\Program Files'}\\App\\x.exe`, { workspaceRoot: 'C:/work' }).class).toBe('system-programs');
    expect(classifyWindowsPath(`${env.ProgramData ?? 'C:\\ProgramData'}\\x`, { workspaceRoot: 'C:/work' }).class).toBe('system-programdata');
    if (env.LOCALAPPDATA) {
      expect(classifyWindowsPath(`${env.LOCALAPPDATA}\\x`, { workspaceRoot: 'C:/work' }).class).toBe('user-appdata');
    }
    // 工作区判定：env 覆盖去掉 appdata 根（测试 temp 目录在 LOCALAPPDATA 下——会被如实分类
    // user-appdata，这是分类器正确行为；此处显式声明干净 env 验证 workspace/other 分支）
    const cleanEnv = { WINDIR: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' };
    const ws = tmp();
    const inside = join(ws, 'app.txt');
    writeFileSync(inside, 'x');
    expect(classifyWindowsPath(inside, { workspaceRoot: ws, env: cleanEnv }).class).toBe('workspace');
    expect(classifyWindowsPath('D:\\projects\\普通目录\\file.txt', { workspaceRoot: ws, env: cleanEnv }).class).toBe('other');
    rmSync(ws, { recursive: true, force: true });
  });

  it('隐藏+系统属性文件 → hidden-or-system-attribute（真实 attrib +H +S）', () => {
    if (!isWin) return; // 非 win32 诚实跳过（分类器返回 other 已在表测试覆盖）
    const ws = tmp();
    const f = join(ws, 'secret.txt');
    writeFileSync(f, 'x');
    const r = spawnSync('attrib', ['+H', '+S', f], { encoding: 'utf8', windowsHide: true });
    expect(r.status).toBe(0);
    try {
      expect(classifyWindowsPath(f, { workspaceRoot: ws, env: { WINDIR: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' } }).class).toBe('hidden-or-system-attribute');
    } finally {
      spawnSync('attrib', ['-H', '-S', f], { windowsHide: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('命令引用系统根 → system-touch 命中；普通命令不命中', () => {
    if (!isWin) return;
    expect(commandTouchesSystemPath('dir C:\\Windows\\System32')).toBeTruthy();
    expect(commandTouchesSystemPath('node server.js')).toBeNull();
  });
});

describe('W8-02 管线 system-touch 强制确认', () => {
  it('fs_write 到 system-touch 路径：审批被请求且携带分类理由；拒绝 → 零副作用', async () => {
    if (!isWin) return;
    // fixture 工作区在 LOCALAPPDATA\Temp 下 → 分类器如实判 user-appdata → system-touch 确认
    // （隐藏属性分支已由分类器单元测试覆盖；此处验证管线确认门 + 理由透出 + 零副作用）
    const seen: Array<Record<string, unknown>> = [];
    const { pipeline, context, dir } = fixture(async (req) => {
      seen.push({ toolId: String(req.toolId), reasonCode: req.reasonCode ?? '', obligations: req.obligations ?? [] });
      return false; // 未确认 → 拒绝
    });
    const target = join(dir, 'touch.txt');
    writeFileSync(target, 'original');
    try {
      const result = await pipeline.pipeline.execute(
        { id: 'eff-hid', toolId: 'builtin:workspace.write' as ToolId, args: { path: target, bytesBase64: Buffer.from('overwrite').toString('base64') } },
        context(), new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('POLICY_DENIED');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]!.reasonCode).toBe('SYSTEM_TOUCH_REQUIRES_CONFIRMATION');
      expect(seen[0]!.obligations).toBeTruthy();
      // 零副作用：内容未被覆盖
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(target, 'utf8')).toBe('original');
    } finally {
      // 目录清理归 fixture 的 afterEach（先 closeDB 再删——测试内提前删会 EBUSY）
    }
  });

  it('确认后放行：决策理由进入审批链，写操作真实执行', async () => {
    if (!isWin) return;
    const seen: string[] = [];
    const { pipeline, context, dir } = fixture(async (req) => { seen.push(req.reasonCode ?? ''); return true; });
    const target = join(dir, 'touch2.txt');
    writeFileSync(target, 'original');
    try {
      const result = await pipeline.pipeline.execute(
        { id: 'eff-hid2', toolId: 'builtin:workspace.write' as ToolId, args: { path: target, bytesBase64: Buffer.from('approved').toString('base64') } },
        context(), new AbortController().signal,
      );
      expect(result.ok).toBe(true);
      expect(seen).toContain('SYSTEM_TOUCH_REQUIRES_CONFIRMATION');
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(target, 'utf8')).toBe('approved');
    } finally {
      // 目录清理归 fixture 的 afterEach（先 closeDB 再删——测试内提前删会 EBUSY）
    }
  });
});
