// src/kernel/share.ts — 会话打包分享（离线文件式——单机堡垒下的 share 变体，2026-08-18）
// 参考：opencode share（云 token）/ kimi share（web 链接）——两者均依赖中心服务器；
// wxnodus 数据不出机红线 + 无发布服务器 → 实现为「离线加密打包」：
//   /share export [sid] [--encrypt --pass <口令>] [--out <path>] → 单文件 .wxnshare
//   /share import <path> [--pass <口令>] → 新会话（血缘记 forked_from_id='share:<源id>'）
// 包格式（明文）：{ format:'wxn-share', version:1, exportedAt, source:{id,title},
//   messages:[{role,content,tool_call_id,parts,ts}], sha256 }——sha256 覆盖前五字段的
//   规范化 JSON（防篡改/防截断，导入前校验）。
// 包格式（加密）：{ format:'wxn-share-enc', version:1, kdf:{algo:'scrypt',salt,N,r,p},
//   iv, data }——data = AES-256-GCM(口令派生 32B, iv)(明文包 JSON) 的 base64。
// 口令绝不入包/不落盘；argv 传参可见性风险由命令层文案提示（推荐 WXNODUS_SHARE_PASS）。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
type Db = InstanceType<typeof Database>;

export const SHARE_FORMAT = 'wxn-share';
export const SHARE_FORMAT_ENC = 'wxn-share-enc';
export const SHARE_VERSION = 1;

interface ShareMessage {
  role: string;
  content: string;
  tool_call_id: string | null;
  parts: string | null;
  ts: number;
}

interface PlainPayload {
  format: 'wxn-share';
  version: number;
  exportedAt: number;
  source: { id: string; title: string };
  messages: ShareMessage[];
  sha256: string;
}

/** 规范化序列化（键序稳定——sha256 校验的确定性基础） */
function canonicalize(p: Omit<PlainPayload, 'sha256'>): string {
  return JSON.stringify({
    format: p.format, version: p.version, exportedAt: p.exportedAt,
    source: { id: p.source.id, title: p.source.title },
    messages: p.messages.map(m => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id, parts: m.parts, ts: m.ts })),
  });
}

function payloadSha256(p: Omit<PlainPayload, 'sha256'>): string {
  return createHash('sha256').update(canonicalize(p), 'utf8').digest('hex');
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** 导出会话为分享包（明文或 AES-256-GCM 加密；口令经 scrypt 派生，盐/iv 随机） */
export function exportSessionBundle(db: Db, sessionId: string, opts: { password?: string } = {}): { ok: true; bundle: string; summary: { msgCount: number; encrypted: boolean } } | { ok: false; error: string } {
  const row = db.prepare(`SELECT title FROM sessions WHERE id=?`).get(sessionId) as { title: string } | undefined;
  if (!row) return { ok: false, error: `会话不存在：${sessionId}` };
  const msgs = db.prepare(`SELECT role, content, tool_call_id, parts, ts FROM messages WHERE session_id=? ORDER BY id`).all(sessionId) as ShareMessage[];
  const payload: Omit<PlainPayload, 'sha256'> = {
    format: SHARE_FORMAT, version: SHARE_VERSION, exportedAt: Date.now(),
    source: { id: sessionId, title: row.title },
    messages: msgs,
  };
  const plain: PlainPayload = { ...payload, sha256: payloadSha256(payload) };
  const plainJson = JSON.stringify(plain);
  if (!opts.password) {
    return { ok: true, bundle: plainJson, summary: { msgCount: msgs.length, encrypted: false } };
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(opts.password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const bundle = JSON.stringify({
    format: SHARE_FORMAT_ENC, version: SHARE_VERSION,
    kdf: { algo: 'scrypt', salt: salt.toString('base64'), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  });
  return { ok: true, bundle, summary: { msgCount: msgs.length, encrypted: true } };
}

/** 导入分享包为新会话（先 sha256 校验再入库；加密包先解密；血缘标记 share:<源id>） */
export function importSessionBundle(db: Db, bundle: string, opts: { password?: string; newId?: string } = {}): { ok: true; sessionId: string; msgCount: number; sourceId: string } | { ok: false; error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(bundle); } catch { return { ok: false, error: '包不是合法 JSON（文件损坏或格式错误）' }; }
  const doc = parsed as { format?: string; data?: string; iv?: string; tag?: string; kdf?: { algo?: string; salt?: string; N?: number; r?: number; p?: number } };
  if (doc?.format === SHARE_FORMAT_ENC) {
    if (!opts.password) return { ok: false, error: '加密包需要口令——/share import <文件> --pass <口令>（或环境变量 WXNODUS_SHARE_PASS）' };
    try {
      const salt = Buffer.from(String(doc.kdf?.salt ?? ''), 'base64');
      const iv = Buffer.from(String(doc.iv ?? ''), 'base64');
      const key = scryptSync(opts.password, salt, 32, { N: Number(doc.kdf?.N) || SCRYPT_N, r: Number(doc.kdf?.r) || SCRYPT_R, p: Number(doc.kdf?.p) || SCRYPT_P });
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(Buffer.from(String(doc.tag ?? ''), 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(String(doc.data ?? ''), 'base64')), decipher.final()]).toString('utf8');
      try { parsed = JSON.parse(plain); } catch { return { ok: false, error: '解密后内容不是合法 JSON（口令可能错误）' }; }
    } catch {
      return { ok: false, error: '解密失败——口令错误或包已损坏' };
    }
  }
  const p = parsed as PlainPayload | null;
  if (!p || p.format !== SHARE_FORMAT || p.version !== SHARE_VERSION || !Array.isArray(p.messages)) {
    return { ok: false, error: '包格式不合法（format/version 不匹配——不同版本或伪造文件）' };
  }
  const calc = payloadSha256(p);
  if (calc !== p.sha256) return { ok: false, error: `sha256 校验失败（包被篡改或截断）——期望 ${p.sha256.slice(0, 12)}… 实际 ${calc.slice(0, 12)}…` };
  const newId = opts.newId ?? `s${Date.now()}i`;
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at, forked_from_id) VALUES (?,?,?,?,?)`)
    .run(newId, `（导入）${p.source.title || p.source.id}`.slice(0, 50), now, now, `share:${p.source.id}`);
  const ins = db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, parts, ts) VALUES (?,?,?,?,?,?)`);
  for (const m of p.messages) {
    ins.run(newId, m.role, m.content, m.tool_call_id, m.parts, m.ts);
  }
  return { ok: true, sessionId: newId, msgCount: p.messages.length, sourceId: p.source.id };
}
