// src/infrastructure/http/winInetProxy.ts — A2 Phase2（2026-08-27）：WinINET 系统代理读取
// 企业 Windows 的代理几乎都是系统级配置（Internet Settings），非 env——Node fetch 不读
// WinINET，需显式桥接。零依赖实现：reg.exe 查询（HKCU 优先，回退 HKLM；被组策略锁定时
// HKLM 只读同样可查）。PAC（AutoConfigURL）无法在无 JS 解释器下执行——诚实标注降级。
import { execFile } from 'node:child_process';

export interface SystemProxyInfo {
  /** 代理地址（http://host:port，可含 Basic 认证） */
  proxy: string;
  /** ProxyOverride 旁路列表（原样透传，undici 语法） */
  noProxy?: string;
  /** AutoConfigURL（PAC）在场——pac=true 时 proxy 为 PAC 主机直连兜底，消费者应如实提示 */
  pac?: boolean;
}

/** reg query 结果 → 值字符串（`    ProxyServer    REG_SZ    host:port` 形态） */
const parseRegValue = (stdout: string): string | null => {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+\w+\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/.exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
};

/** ProxyServer 值解析：`host:port`（全协议）或 `http=…;https=…;ftp=…`（按协议分列，https 优先） */
export function parseProxyServerValue(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.startsWith('=')) return null;
  const entries = raw.split(';').map(s => s.trim()).filter(Boolean);
  if (entries.some(e => e.includes('='))) {
    const https = entries.find(e => /^https\s*=/i.test(e))?.split(/=/)[1]?.trim();
    const http = entries.find(e => /^http\s*=/i.test(e))?.split(/=/)[1]?.trim();
    return https || http || null;
  }
  return entries[0] ?? null;
}

/** 单次 reg query（HKCU 优先；值缺失回退 HKLM） */
const regQuery = (root: 'HKCU' | 'HKLM', value: string): Promise<string | null> =>
  new Promise(resolve => {
    execFile('reg.exe', ['query', `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings`, '/v', value],
      { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        if (error) return resolve(null);
        resolve(parseRegValue(stdout));
      });
  });

/** 读取 WinINET 系统代理（非 win32 / 未启用 / 读取失败 → null，诚实降级直连） */
export async function readWinInetProxy(): Promise<SystemProxyInfo | null> {
  if (process.platform !== 'win32') return null;
  const enabledHkcu = await regQuery('HKCU', 'ProxyEnable');
  const enabledHklm = enabledHkcu === null ? await regQuery('HKLM', 'ProxyEnable') : enabledHkcu;
  if (enabledHklm !== '0x1') return null;
  const server = (await regQuery('HKCU', 'ProxyServer')) ?? (await regQuery('HKLM', 'ProxyServer'));
  if (!server) return null;
  const parsed = parseProxyServerValue(server);
  if (!parsed) return null;
  const override = (await regQuery('HKCU', 'ProxyOverride')) ?? (await regQuery('HKLM', 'ProxyOverride')) ?? undefined;
  const pac = Boolean((await regQuery('HKCU', 'AutoConfigURL')) ?? (await regQuery('HKLM', 'AutoConfigURL')));
  return {
    proxy: /^https?:\/\//i.test(parsed) ? parsed : `http://${parsed}`,
    noProxy: override,
    pac: pac || undefined,
  };
}
