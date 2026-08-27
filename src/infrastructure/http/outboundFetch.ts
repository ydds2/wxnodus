// src/infrastructure/http/outboundFetch.ts — A2（2026-08-27）：统一出站 fetch（企业代理面）
// 设计：
//   · 模型调用（llmStream/llmOnce/vision）与工具网络（safeFetchText/http 工具）共用同一代理语义；
//   · 代理来源 = 环境变量 HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy（含 Basic 认证 URL）
//     + NO_PROXY/no_proxy——undici EnvHttpProxyAgent 原生实现，零新依赖；
//   · 私网直连红线：fetch 包装层对私网/回环/链路本地/ULA 字面目标直连（不挂 dispatcher）——
//     undici noProxy 不支持 CIDR，且私网判定必须在包装层（数据不出机红线的网络面延伸）；
//   · SSRF 判定仍在调用方（URL 层）先行，代理只是传输——「经代理绕过 SSRF」不成立。
import { EnvHttpProxyAgent, ProxyAgent } from 'undici';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** WinINET ProxyOverride 条目匹配：精确主机 / *.后缀 通配 / `<local>`（无点号主机名——内网短名直连） */
export function matchProxyOverride(host: string, overrideList: string | undefined): boolean {
  if (!overrideList) return false;
  const h = host.toLowerCase();
  for (const raw of overrideList.split(';')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '<local>') {
      if (!h.includes('.')) return true; // WinINET 语义：仅单标签主机名
      continue;
    }
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // '.example.com'
      if (h === suffix.slice(1) || h.endsWith(suffix)) return true;
      continue;
    }
    if (entry.startsWith('*') && h.endsWith(entry.slice(1))) return true;
    if (entry === h) return true;
  }
  return false;
}

/** 私网/回环/链路本地/ULA 字面主机判定（IPv4 三类私网+回环+链路本地；IPv6 回环/ULA/链路本地；localhost） */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (IPV4.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || a === 10 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (h.includes(':')) {
    return h === '::1'
      || h.startsWith('fc') || h.startsWith('fd')   // ULA fc00::/7
      || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'); // 链路本地 fe80::/10
  }
  return false;
}

/** 用户 NO_PROXY 归一化（去重保序、小写）——原样交给 undici（其支持精确主机/后缀通配，不支持 CIDR） */
export function mergeNoProxy(userNoProxy: string | undefined): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of userNoProxy?.split(',') ?? []) {
    const p = raw.trim().toLowerCase();
    if (p && !seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  }
  return parts.join(',');
}

const proxyEnvNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;

/** 环境是否配置了任意代理 */
export function hasEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return proxyEnvNames.some(n => Boolean(env[n]));
}

export interface OutboundFetch {
  /** 与全局 fetch 同形（私网目标直连；其余注入代理 dispatcher） */
  fetch: typeof fetch;
  /** doctor 展示用：代理来源描述（未配置 → null） */
  proxyDescription: string | null;
}

let cachedAgent: EnvHttpProxyAgent | ProxyAgent | null = null;
let cachedAgentKey: string | null = null;
// A2 Phase2：WinINET 系统代理缓存（异步预取，同步消费——保持 createOutboundFetch 同步契约）
let cachedSystemProxy: { url: string; noProxy?: string; pac?: boolean } | null | undefined;

/** 预取系统代理（bootstrap 调用一次；env 代理优先，无 env 时读 WinINET；失败诚实 null） */
export async function loadSystemProxy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (hasEnvProxy(env)) { cachedSystemProxy = null; return; }
  try {
    const { readWinInetProxy } = await import('./winInetProxy.js');
    const info = await readWinInetProxy();
    cachedSystemProxy = info ? { url: info.proxy, noProxy: info.noProxy, pac: info.pac } : null;
  } catch {
    cachedSystemProxy = null;
  }
}

/**
 * 出站 fetch 工厂：env 代理 → EnvHttpProxyAgent；无 env 但系统代理已预取 → ProxyAgent；
 * 皆无 → 零开销直连。每次调用重读 globalThis.fetch（测试可 vi.stubGlobal；生产恒等）；
 * 仅代理 agent 按来源键缓存。私网直连红线始终在包装层生效。
 */
export function createOutboundFetch(env: NodeJS.ProcessEnv = process.env): OutboundFetch {
  const g = (globalThis as { fetch: typeof fetch }).fetch;
  const envProxy = hasEnvProxy(env);
  const sysProxy = cachedSystemProxy ?? null;
  if (!envProxy && !sysProxy) {
    return { fetch: g, proxyDescription: null };
  }
  const key = envProxy
    ? `env:${proxyEnvNames.map(n => env[n] ?? '').join('\u0000')}\u0000${mergeNoProxy(env.NO_PROXY ?? env.no_proxy)}`
    : `sys:${sysProxy!.url}\u0000${sysProxy!.noProxy ?? ''}`;
  if (!cachedAgent || cachedAgentKey !== key) {
    cachedAgent = envProxy
      ? new EnvHttpProxyAgent({ noProxy: mergeNoProxy(env.NO_PROXY ?? env.no_proxy) })
      : new ProxyAgent({ uri: sysProxy!.url });
    cachedAgentKey = key;
  }
  const agent = cachedAgent;
  const proxyBits = envProxy
    ? proxyEnvNames.filter(n => env[n]).map(n => `${n}=${env[n]}`)
    : [`WinINET=${sysProxy!.url}${sysProxy!.pac ? '（PAC 在场——无法执行 PAC 脚本，仅主机直连兜底）' : ''}`];
  const noProxyOverride = envProxy ? undefined : sysProxy!.noProxy;
  // undici 自身类型与全局 undici-types 的 Dispatcher 定义冲突（body 联合类型差异）——
  // 显式断言为 fetch 接受的 dispatcher 形态（运行时完全兼容）。
  return {
    fetch: (input, init) => {
      const urlStr = typeof input === 'string' ? input : (input as Request).url;
      const host = new URL(urlStr).hostname;
      if (isPrivateHost(host) || matchProxyOverride(host, noProxyOverride)) {
        return g(input, init); // 私网/旁路直连红线：不挂代理 dispatcher
      }
      return g(input, { ...(init ?? {}), dispatcher: agent as any });
    },
    proxyDescription: `env ${proxyBits.join(' ')}（私网段默认直连）`,
  };
}
