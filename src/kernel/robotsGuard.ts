// src/kernel/robotsGuard.ts — 自动化护栏（合规五项之⑤）
// 审查接线：compliance.ts 的 checkRobots/detectCaptcha/guardrail 此前零调用者——
// http_get 与 /claw 从不尊重 robots.txt（「自动化必须尊重站点规则」宣称与实现脱节）。
// 本模块把护栏接进真实抓取链路：同源 robots.txt 校验（禁止路径 → 拦截）+ 验证码提示。
// robots.txt 获取失败/不存在 → 视为允许（标准行为）；SSRF 防护复用（safeFetchText）。
import { safeFetchText } from './ssrf.js';

const robotsCache = new Map<string, { text: string; ts: number }>();
const ROBOTS_TTL = 10 * 60_000;

async function fetchRobots(origin: string): Promise<string> {
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.ts < ROBOTS_TTL) return hit.text;
  const r = await safeFetchText(`${origin}/robots.txt`, { maxBytes: 64_000 });
  const text = 'error' in r ? '' : r.text;
  robotsCache.set(origin, { text, ts: Date.now() });
  return text;
}

/** 抓取前护栏：返回 block=禁止理由（应拦截）或 captcha=验证码页面提示 */
export async function robotsGuard(url: string, html: string): Promise<{ block?: string; captcha?: boolean }> {
  const out: { block?: string; captcha?: boolean } = {};
  try {
    const u = new URL(String(url ?? ''));
    const robotsTxt = await fetchRobots(u.origin);
    if (robotsTxt) {
      const { checkRobots } = await import('../compliance/compliance.js');
      if (!checkRobots(robotsTxt, u.pathname || '/').allowed) {
        out.block = `站点 robots.txt 禁止抓取该路径（护栏拦截——自动化必须尊重站点规则）`;
      }
    }
    const { detectCaptcha } = await import('../compliance/compliance.js');
    if (detectCaptcha(html) === 'high') out.captcha = true;
  } catch { /* 护栏检查失败不阻断（SSRF 仍是主防线） */ }
  return out;
}
