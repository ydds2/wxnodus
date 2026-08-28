// src/application/tools/toolExecutors.ts — W1-08 生产 executor：pipeline 的 execute/verifyPostcondition 真实实现
// 全部经真实守卫：workspace.* 走 pathBoundary（lexical+realpath 双检）、network.fetch 走 safeFetchText
// （P0-08 SSRF：DNS fail-closed/私网拒绝）、process.spawn 超时强杀、memory 走 MemoryService（session scope）。
// 未接线的 toolId → TOOL_EXECUTOR_UNWIRED fail-closed（绝不假执行）。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSupervisedProcess } from '../../infrastructure/process/processSupervisor.js';
import type { ToolId } from '../../domain/tools/toolIds.js';
import type { MemoryRepository } from '../../domain/memory/memoryRepository.js';
import { safeFetchText } from '../../kernel/ssrf.js';
import { safeWorkspaceRead, safeWorkspaceWrite, WorkspaceFsError } from '../../infrastructure/fs/safeWorkspaceFs.js';
import { createMemoryService } from '../memoryService.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const workspacePath = (workspaceRoot: string, input: string): string => resolve(workspaceRoot, input);

export interface ToolExecutorDeps {
  workspaceRoot: string;
  memoryRepository: MemoryRepository;
  /** A-S3（2026-08-28）MCP surfaces 数据源（build/evidence 查询；缺省 → 诚实降级说明） */
  db?: import('better-sqlite3').Database;
  dataDir?: string;
}

export interface ToolExecuteValue {
  path?: string;
  bytes?: number;
  bytesWritten?: number;
  sha256?: string;
  status?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  records?: readonly unknown[];
  /** A-S3 MCP surfaces 载荷 */
  builds?: readonly unknown[];
  note?: string;
  chainOk?: boolean;
  chainCount?: number;
  recentEvidence?: readonly unknown[];
}

const workspaceFailure = (operation: 'read' | 'write', cause: unknown): OperationResult<never> => {
  const message = `workspace.${operation} 失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}`;
  return cause instanceof WorkspaceFsError
    ? err(gatewayError(cause.code, message, 'tool.path.boundary'))
    : err(gatewayError('TOOL_EXECUTE_FAILED', message, 'tool.execute.failed'));
};

const unwired = (toolId: string): OperationResult<never> =>
  err(gatewayError('TOOL_EXECUTOR_UNWIRED', `tool 执行器未接线：${toolId}`, 'tool.executor.unwired'));

/** execute 端口：toolId → 真实执行（返回值必须 OperationResult 形状——pipeline 拒绝裸字符串假成功） */
export async function executeToolId(toolId: ToolId, args: unknown, context: OperationContext, deps: ToolExecutorDeps, signal: AbortSignal): Promise<unknown> {
  const input = (args ?? {}) as Record<string, unknown>;
  switch (toolId as string) {
    case 'builtin:workspace.read': {
      const path = String(input.path ?? '');
      if (!path) return err(gatewayError('TOOL_ARGS_INVALID', 'workspace.read 需要 path', 'tool.args.invalid'));
      try {
        const target = workspacePath(deps.workspaceRoot, path);
        const content = await safeWorkspaceRead(deps.workspaceRoot, target);
        return ok({ path: target, bytes: content.length, sha256: sha256(content) } satisfies ToolExecuteValue);
      } catch (cause) {
        return workspaceFailure('read', cause);
      }
    }
    case 'builtin:workspace.write': {
      const path = String(input.path ?? '');
      const bytesBase64 = String(input.bytesBase64 ?? '');
      if (!path || !bytesBase64) return err(gatewayError('TOOL_ARGS_INVALID', 'workspace.write 需要 path 与 bytesBase64', 'tool.args.invalid'));
      try {
        const target = workspacePath(deps.workspaceRoot, path);
        const content = Buffer.from(bytesBase64, 'base64');
        const written = await safeWorkspaceWrite(deps.workspaceRoot, target, content);
        return ok({ path: target, bytesWritten: written.bytes, sha256: written.sha256 } satisfies ToolExecuteValue);
      } catch (cause) {
        return workspaceFailure('write', cause);
      }
    }
    case 'builtin:network.fetch': {
      const url = String(input.url ?? '');
      if (!/^https?:\/\//.test(url)) return err(gatewayError('TOOL_ARGS_INVALID', 'network.fetch 需要 http(s) URL', 'tool.args.invalid'));
      const result = await safeFetchText(url, { maxBytes: 1_000_000, timeoutMs: 20_000, method: String(input.method ?? 'GET') === 'POST' ? 'POST' : 'GET' });
      if ('error' in result) return err(gatewayError('OUTBOUND_HTTP_REJECTED', result.error, 'outbound.http.rejected'));
      return ok({ status: result.status, bytes: Buffer.byteLength(result.text), sha256: sha256(result.text) } satisfies ToolExecuteValue);
    }
    case 'builtin:process.spawn': {
      const executable = String(input.executable ?? '');
      const argsList = Array.isArray(input.args) ? input.args.map(String) : [];
      if (!executable) return err(gatewayError('TOOL_ARGS_INVALID', 'process.spawn 需要 executable', 'tool.args.invalid'));
      const result = await runSupervisedProcess({
        command: executable,
        args: argsList,
        cwd: deps.workspaceRoot,
        timeoutMs: 30_000,
        signal,
      });
      if (!result.ok) return result;
      return ok({
        exitCode: result.value.exitCode ?? undefined,
        stdoutBytes: Buffer.byteLength(result.value.stdout),
        stderrBytes: Buffer.byteLength(result.value.stderr),
      } satisfies ToolExecuteValue);
    }
    case 'builtin:memory': {
      const service = createMemoryService(deps.memoryRepository, { sessionId: context.sessionId });
      const list = service.list({ limit: 20 });
      if (!list.ok) return list;
      return ok({ records: list.value.map(record => ({ id: record.id, role: record.role, content: record.content, salience: record.salience, updatedAt: record.updatedAt })) } satisfies ToolExecuteValue);
    }
    // ── A-S3（2026-08-28）MCP surfaces：build/verify/evidence 交付面（只读查询语义）──
    case 'builtin:build': {
      // 构建产物清单：dataDir/projects 目录（名称/mtime/文件数）——外部 agent 消费 wxnodus 构建体系产出
      const dataDir = deps.dataDir;
      if (!dataDir) return ok({ builds: [], note: 'dataDir 未注入——本执行器实例无构建产物可查' } satisfies ToolExecuteValue);
      try {
        const projectsRoot = resolve(dataDir, 'projects');
        if (!existsSync(projectsRoot)) return ok({ builds: [] } satisfies ToolExecuteValue);
        const builds = readdirSync(projectsRoot, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => {
            const dir = resolve(projectsRoot, e.name);
            let fileCount = 0;
            try { fileCount = readdirSync(dir, { recursive: true }).length; } catch { /* 无权限计 0 */ }
            return { name: e.name, mtimeMs: statSync(dir).mtimeMs, fileCount };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 50);
        return ok({ builds } satisfies ToolExecuteValue);
      } catch (e) {
        return err(gatewayError('TOOL_EXECUTE_FAILED', `构建产物清单读取失败：${String((e as Error)?.message ?? e).slice(0, 120)}`, 'tool.execute.failed'));
      }
    }
    case 'builtin:verify': {
      // 读回校验（verifyPostcondition 同族）：给定工作区相对路径 → bytes+sha256（产物完整性核对）
      const path = typeof input.path === 'string' ? input.path : '';
      if (!path) return err(gatewayError('TOOL_ARGS_INVALID', 'verify 需要 path（工作区相对路径）', 'tool.args.invalid'));
      try {
        // 边界契约：safeWorkspaceRead 期望绝对/已锚定路径——相对路径先锚定工作区根（resolve 独立于 root，防 cwd 逃逸）
        const target = resolve(deps.workspaceRoot, path);
        const content = await safeWorkspaceRead(deps.workspaceRoot, target);
        return ok({ path, bytes: content.length, sha256: createHash('sha256').update(String(content), 'utf8').digest('hex') } satisfies ToolExecuteValue);
      } catch (e) {
        return err(gatewayError('TOOL_EXECUTE_FAILED', `读回校验失败：${String((e as Error)?.message ?? e).slice(0, 120)}`, 'tool.verify.failed'));
      }
    }
    case 'builtin:evidence': {
      // 审计哈希链证据：计数 + 最近 5 条事件 + 链完整性校验（tamper-evident 证明）
      if (!deps.db) return ok({ records: [], note: 'db 未注入——本执行器实例无审计链可查' } satisfies ToolExecuteValue);
      try {
        const { verifyAudit } = await import('../../kernel/audit.js');
        const chain = verifyAudit(deps.db);
        const recent = (deps.db.prepare('SELECT id, event, ts FROM audit ORDER BY id DESC LIMIT 5').all() as Array<{ id: number; event: string; ts: number }>).reverse();
        return ok({ chainOk: chain.ok, chainCount: chain.ok ? chain.count : -1, recentEvidence: recent } satisfies ToolExecuteValue);
      } catch (e) {
        return err(gatewayError('TOOL_EXECUTE_FAILED', `审计链查询失败：${String((e as Error)?.message ?? e).slice(0, 120)}`, 'tool.execute.failed'));
      }
    }
    default:
      return unwired(toolId);
  }
}

/** verifyPostcondition 端口：workspace 结果经同一安全边界读回并核对内容哈希。 */
export async function verifyToolPostcondition(toolId: ToolId, value: unknown, _context: OperationContext, deps: ToolExecutorDeps): Promise<OperationResult<void>> {
  const observed = value as ToolExecuteValue | null | undefined;
  if (!observed || typeof observed !== 'object') return err(gatewayError('TOOL_RESULT_INVALID', '工具返回值形状非法', 'tool.result.invalid'));
  switch (toolId as string) {
    case 'builtin:workspace.write': {
      if (typeof observed.path !== 'string' || typeof observed.bytesWritten !== 'number' || typeof observed.sha256 !== 'string') {
        return err(gatewayError('TOOL_RESULT_INVALID', 'workspace.write 返回值形状非法', 'tool.result.invalid'));
      }
      try {
        const content = await safeWorkspaceRead(deps.workspaceRoot, observed.path);
        if (content.length !== observed.bytesWritten || sha256(content) !== observed.sha256) {
          return err(gatewayError('TOOL_POSTCONDITION_FAILED', `写后校验失败：${observed.path}`, 'tool.postcondition.failed'));
        }
        return ok(undefined);
      } catch { return err(gatewayError('TOOL_POSTCONDITION_FAILED', `写后校验失败：${observed.path}`, 'tool.postcondition.failed')); }
    }
    case 'builtin:workspace.read': {
      if (typeof observed.path !== 'string' || typeof observed.bytes !== 'number' || typeof observed.sha256 !== 'string') {
        return err(gatewayError('TOOL_RESULT_INVALID', 'workspace.read 返回值形状非法', 'tool.result.invalid'));
      }
      try {
        const content = await safeWorkspaceRead(deps.workspaceRoot, observed.path);
        return content.length === observed.bytes && sha256(content) === observed.sha256
          ? ok(undefined)
          : err(gatewayError('TOOL_POSTCONDITION_FAILED', `读后校验失败：${observed.path}`, 'tool.postcondition.failed'));
      } catch { return err(gatewayError('TOOL_POSTCONDITION_FAILED', `读后校验失败：${observed.path}`, 'tool.postcondition.failed')); }
    }
    case 'builtin:network.fetch':
      return typeof observed.status === 'number'
        ? ok(undefined)
        : err(gatewayError('TOOL_RESULT_INVALID', 'network.fetch 返回值形状非法', 'tool.result.invalid'));
    case 'builtin:process.spawn':
      return typeof observed.exitCode === 'number'
        ? ok(undefined)
        : err(gatewayError('TOOL_RESULT_INVALID', 'process.spawn 返回值形状非法', 'tool.result.invalid'));
    case 'builtin:memory':
      return Array.isArray(observed.records)
        ? ok(undefined)
        : err(gatewayError('TOOL_RESULT_INVALID', 'memory 返回值形状非法', 'tool.result.invalid'));
    default:
      return unwired(toolId);
  }
}

/** normalize 用：effect.resource 从 args 确定性实例化（file:// 绝对路径 / 原始 URL / process:// 可执行名） */
export function instantiateEffectResource(toolId: ToolId, args: unknown, context: OperationContext, workspaceRoot: string): string {
  const input = (args ?? {}) as Record<string, unknown>;
  switch (toolId as string) {
    case 'builtin:workspace.read':
    case 'builtin:workspace.write': {
      const raw = String(input.path ?? '');
      return raw ? pathToFileURL(workspacePath(workspaceRoot, raw)).href : 'file://';
    }
    case 'builtin:network.fetch': return String(input.url ?? '');
    case 'builtin:process.spawn': return `process://${String(input.executable ?? '')}`;
    case 'builtin:memory': return `memory://${context.sessionId}`;
    default: return 'unknown://';
  }
}
