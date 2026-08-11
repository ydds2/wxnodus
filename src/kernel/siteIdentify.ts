// src/kernel/siteIdentify.ts — 多模态网站识别（/site）
// 设计：打开目标页面 → 截屏 → GLM-4V 视觉识别「页面需要用户提供哪些敏感输入字段」
//       （如登录用户名/密码、API Key、令牌），DOM 提取 input 字段作为结构化兜底合并；
//       输出字段清单供 /input 动态内容表录入。识别结果不落盘敏感值（截图临时文件即删）。
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { snapBrowser } from './web/browser.js';
import { describeImage } from './vision.js';

export interface SiteField {
  /** 字段名（输入键，供 $WXNODUS_SECRET_<NAME> 引用） */
  name: string;
  /** 人类可读标签（识别/兜底来源） */
  label: string;
  /** 输入类型：text（普通）/ password（掩码）/ key（长密钥） */
  kind: 'text' | 'password' | 'key';
  /** 来源：vision（多模态识别）/ dom（结构化兜底） */
  source: 'vision' | 'dom';
}

export interface SiteIdentifyResult {
  ok: boolean;
  message: string;
  url: string;
  title?: string;
  fields: SiteField[];
  /** 识别截图（临时文件已删除——不保存页面内容） */
  screenshotTaken: boolean;
}

const VISION_PROMPT =
  '这是目标网站的截图。请识别该页面中用户需要提供哪些敏感输入字段（如登录用户名/密码、API Key、令牌、验证码等），并评估是否需要这些信息才能继续操作。请严格输出 JSON 数组，每项为 {"name": "字段英文名(如 username/password/api_key)", "label": "中文标签", "kind": "text|password|key"}。若页面无需敏感输入，输出 []。不要输出其他内容。';

/** 从模型输出中解析字段 JSON（容错：截取首个 [...] 段） */
export function parseFieldsFromVision(text: string | null): SiteField[] {
  if (!text) return [];
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    const arr = JSON.parse(text.slice(start, end + 1)) as Array<{ name?: string; label?: string; kind?: string }>;
    return arr
      .filter(f => f && typeof f.name === 'string' && f.name.trim())
      .map(f => ({
        name: String(f.name).trim().replace(/[^\w-]/g, '_').replace(/^_+|_+$/g, ''),
        label: String(f.label ?? f.name).slice(0, 40),
        kind: f.kind === 'key' || f.kind === 'password' ? f.kind : 'text',
        source: 'vision' as const,
      }));
  } catch { return []; }
}

/** DOM 兜底：提取可见 input 字段（视觉识别失败的降级/合并） */
const DOM_EXTRACT = `(() => {
  const vis = el => el.offsetParent !== null && el.getClientRects().length > 0;
  const out = [];
  for (const el of document.querySelectorAll('input,textarea,select')) {
    if (!vis(el)) continue;
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
    const name = el.placeholder || el.name || el.id || ('field' + out.length);
    const type = el.type === 'password' ? 'password' : el.tagName === 'textarea' || el.type === 'text' ? 'text' : 'text';
    out.push({ name: String(name), label: String(name), kind: type });
  }
  return out;
})()`;

/**
 * 识别网站所需敏感输入字段。
 * @param apiKeyEnc 加密的视觉模型密钥（null = 无多模态，仅 DOM 兜底）
 */
export async function identifySiteInputs(url: string, apiKeyEnc: string | null, dataDir: string): Promise<SiteIdentifyResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'URL 需以 http(s):// 开头', url, fields: [], screenshotTaken: false };
  const b = await snapBrowser();
  const opened = await b.open(url);
  if (!opened.ok) return { ok: false, message: `打开失败：${opened.error}`, url, fields: [], screenshotTaken: false };

  // ① 截图（多模态识别输入源）——临时文件，用后即删（不保存页面内容）
  const shot = await b.screenshot();
  let visionFields: SiteField[] = [];
  let screenshotTaken = !!shot;
  if (shot && apiKeyEnc) {
    const tmp = join(dataDir, `.site-shot-${Date.now().toString(36)}.png`);
    try {
      writeFileSync(tmp, shot);
      const desc = await describeImage(tmp, apiKeyEnc, VISION_PROMPT);
      visionFields = parseFieldsFromVision(desc);
    } catch { /* 识别失败走 DOM 兜底 */ }
    finally {
      try { unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  }

  // ② DOM 结构化兜底
  let domFields: SiteField[] = [];
  try {
    const raw = await b.page!.evaluate(DOM_EXTRACT) as Array<{ name: string; label: string; kind: string }>;
    domFields = raw.map(f => ({ name: f.name.replace(/[^\w-]/g, '_'), label: f.label, kind: f.kind as SiteField['kind'], source: 'dom' as const }));
  } catch { /* 页面不可评估 */ }

  // 合并去重：vision 优先（语义更准），DOM 补充 vision 未覆盖的字段
  const merged: SiteField[] = [];
  const seen = new Set<string>();
  for (const f of [...visionFields, ...domFields]) {
    const key = f.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }

  const msg = merged.length
    ? `识别到 ${merged.length} 个敏感输入字段（${visionFields.length ? '多模态' : 'DOM'}识别）——用 /input ${merged.map(f => f.name).join(' ')} 动态录入（仅内存，不保存）`
    : '未识别到敏感输入字段（页面可能无需凭据或已登录）';
  return { ok: true, message: msg, url, title: opened.title, fields: merged, screenshotTaken };
}
