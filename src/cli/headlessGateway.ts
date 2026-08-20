// src/cli/headlessGateway.ts — W2-03：headless Wire Gateway（禁止 React/Ink 依赖）
// --prompt --wire 模式下 GatewayClient(TUI) 不装配，此前 gateway 恒为 null：
//   · wire 双向化（stdin 帧 → RPC）从不工作
//   · createWireFrontend(null) 被跳过，wire 终态比对失效
// 本模块提供真实 headless 网关：createGatewayService 分派器 + 共享 wire adapter +
// approval/clarify/sudo/secret/form responder 等待 stdin 帧；无帧时超时 fail-closed（deny/''/null）。
import { randomUUID } from 'node:crypto';
import { createGatewayService, type GatewayMethodHandler } from '../application/createGatewayService.js';
import type { GatewayService } from '../application/gatewayService.js';
import { createSharedAdapter } from '../presentation/shared/inProcessAdapter.js';

interface WireFrame {
  method: string;
  params: Record<string, unknown>;
}

interface PendingApproval {
  resolve: (v: 'allow' | 'session' | 'deny') => void;
  timer: NodeJS.Timeout;
}

interface PendingText {
  resolve: (v: string) => void;
  timer: NodeJS.Timeout;
}

interface PendingForm {
  resolve: (v: Record<string, string> | null) => void;
  timer: NodeJS.Timeout;
}

export interface HeadlessWireGateway {
  request(method: string, params: Record<string, unknown>): ReturnType<GatewayService['request']>;
  subscribe: GatewayService['subscribe'];
  bindSession(next: string): void;
  /** stdin JSONL 帧入口：responder 帧解析 pending promise，其余走分派器 */
  handleFrame(frame: WireFrame | null): Promise<unknown>;
  /** stdin 关闭/进程退出：全部 pending fail-closed 释放 */
  abortPending(): void;
  requestApproval(name: string, args: Record<string, unknown>): Promise<'allow' | 'session' | 'deny'>;
  requestClarify(question: string, choices?: string[]): Promise<string>;
  requestSecretInput(kind: 'sudo' | 'secret', prompt: string, name?: string): Promise<string | null>;
  requestCredentialForm(fields: Array<{ name: string; label?: string; kind: string }>, prompt?: string): Promise<Record<string, string> | null>;
}

export function createHeadlessWireGateway(input: { sessionId: string; timeoutMs?: number; onRequest?: (ev: { type: string } & Record<string, unknown>) => void }): HeadlessWireGateway {
  const timeoutMs = input.timeoutMs ?? 60_000;
  // supremacy 2.1 修复：pending 请求必须把 request_id 广播给 wire 事件流——
  // 否则外部前端（IDE 插件/桌面端）无法应答审批/澄清/密码（此前 id 只存在于内存 Map，
  // wire 流上无对应事件——approval.respond 帧无从写起，示例 responder 只能示意）。
  const onRequest = input.onRequest ?? (() => {});
  const approvals = new Map<string, PendingApproval>();
  const clarifies = new Map<string, PendingText>();
  const secrets = new Map<string, PendingText>();
  const forms = new Map<string, PendingForm>();

  const clearTimer = (timer: NodeJS.Timeout) => clearTimeout(timer);

  const settleApproval = (map: Map<string, PendingApproval>, id: string, answer: 'allow' | 'session' | 'deny') => {
    const pending = map.get(id);
    if (!pending) {
      return false;
    }
    map.delete(id);
    clearTimer(pending.timer);
    pending.resolve(answer);
    return true;
  };

  const settleText = (map: Map<string, PendingText>, id: string, value: string) => {
    const pending = map.get(id);
    if (!pending) {
      return false;
    }
    map.delete(id);
    clearTimer(pending.timer);
    pending.resolve(value);
    return true;
  };

  const settleForm = (map: Map<string, PendingForm>, id: string, value: Record<string, string> | null) => {
    const pending = map.get(id);
    if (!pending) {
      return false;
    }
    map.delete(id);
    clearTimer(pending.timer);
    pending.resolve(value);
    return true;
  };

  const parseFormValue = (raw: unknown): Record<string, string> | null => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') {
          out[k] = v;
        }
      }
      return out;
    }
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        return parseFormValue(parsed);
      } catch {
        return null;
      }
    }
    return null;
  };

  const handlers: Record<string, GatewayMethodHandler> = {
    'approval.respond': async req => {
      const id = String(req.params.request_id ?? '');
      const answer = String(req.params.answer ?? req.params.choice ?? '');
      const settled = settleApproval(approvals, id, answer === 'allow' || answer === 'session' ? answer : 'deny');
      return { ok: true as const, value: { handled: settled } };
    },
    'clarify.respond': async req => {
      const id = String(req.params.request_id ?? '');
      const settled = settleText(clarifies, id, String(req.params.answer ?? ''));
      return { ok: true as const, value: { handled: settled } };
    },
    'sudo.respond': async req => {
      const id = String(req.params.request_id ?? '');
      const settled = settleText(secrets, id, String(req.params.password ?? req.params.value ?? ''));
      return { ok: true as const, value: { handled: settled } };
    },
    'secret.respond': async req => {
      const id = String(req.params.request_id ?? '');
      const settled = settleText(secrets, id, String(req.params.value ?? ''));
      return { ok: true as const, value: { handled: settled } };
    },
    'credential_form.respond': async req => {
      const id = String(req.params.request_id ?? '');
      const settled = settleForm(forms, id, parseFormValue(req.params.value ?? req.params.json));
      return { ok: true as const, value: { handled: settled } };
    },
  };

  const service = createGatewayService(handlers);
  const adapter = createSharedAdapter(service, 'wire', input.sessionId);

  const textTimeout = (id: string, map: Map<string, PendingText>, resolve: (v: string) => void) =>
    setTimeout(() => {
      map.delete(id);
      resolve('');
    }, timeoutMs);

  const approvalTimeout = (id: string, map: Map<string, PendingApproval>, resolve: (v: 'allow' | 'session' | 'deny') => void) =>
    setTimeout(() => {
      map.delete(id);
      resolve('deny');
    }, timeoutMs);

  const formTimeout = (id: string, map: Map<string, PendingForm>, resolve: (v: Record<string, string> | null) => void) =>
    setTimeout(() => {
      map.delete(id);
      resolve(null);
    }, timeoutMs);

  return {
    request: (method, params) => adapter.request(method, params),
    subscribe: adapter.subscribe,
    bindSession: next => adapter.bindSession(next),
    handleFrame: frame => {
      if (!frame || typeof frame.method !== 'string') {
        return Promise.resolve(null);
      }
      return adapter.request(frame.method, frame.params ?? {});
    },
    abortPending: () => {
      for (const [id, p] of [...approvals]) {
        approvals.delete(id);
        clearTimer(p.timer);
        p.resolve('deny');
      }
      for (const [id, p] of [...clarifies]) {
        clarifies.delete(id);
        clearTimer(p.timer);
        p.resolve('');
      }
      for (const [id, p] of [...secrets]) {
        secrets.delete(id);
        clearTimer(p.timer);
        p.resolve('');
      }
      for (const [id, p] of [...forms]) {
        forms.delete(id);
        clearTimer(p.timer);
        p.resolve(null);
      }
    },
    requestApproval: (name, args) =>
      new Promise(resolve => {
        const id = randomUUID();
        const timer = approvalTimeout(id, approvals, resolve);
        approvals.set(id, { resolve, timer });
        onRequest({ type: 'approval.request', request_id: id, tool: name, args });
      }),
    requestClarify: (question, choices) =>
      new Promise(resolve => {
        const id = randomUUID();
        const timer = textTimeout(id, clarifies, resolve);
        clarifies.set(id, { resolve, timer });
        onRequest({ type: 'clarify.request', request_id: id, question, choices: choices ?? [] });
      }),
    requestSecretInput: (kind, prompt, name) =>
      new Promise(resolve => {
        const id = randomUUID();
        const timer = textTimeout(id, secrets, resolve);
        secrets.set(id, { resolve, timer });
        onRequest({ type: 'secret.request', request_id: id, kind, prompt, name: name ?? '' });
      }),
    requestCredentialForm: (fields, prompt) =>
      new Promise(resolve => {
        const id = randomUUID();
        const timer = formTimeout(id, forms, resolve);
        forms.set(id, { resolve, timer });
        onRequest({ type: 'form.request', request_id: id, fields, prompt: prompt ?? '' });
      }),
  };
}
