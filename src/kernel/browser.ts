// src/kernel/browser.ts — 浏览器自动化工具（P0-1 补齐竞品标配缺口）
// 设计：系统浏览器复用（Windows 自带 Edge → Chrome 回退，零浏览器下载）+ 惰性单例 +
//       SSRF 域名白名单（navigate 前 checkUrlSafety 三层防护）+ 诚实归因（不可用明确提示）
// 对齐：Gemini browser_agent / Cline browser —— AI 可主动打开网页、点击、输入、截图分析
import { checkUrlSafety } from './ssrf.js';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

let browser: any = null;
let page: any = null;
let launchError: string | null = null;

// 审查修复：操作互斥——并行剧本分支/多任务会并发调用 browser_*，而 page 是模块级单例；
// 不经串行化时导航中点击、截图与导航交错（竞态错位）。全部操作经此链排队。
let opChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(() => undefined, () => undefined); // 前序失败不阻塞后续
  return run;
}

/** 浏览器可用性探测（不启动）：系统 Edge/Chrome 可执行文件或 playwright 内置 */
export function browserProbe(): { ok: boolean; browser?: string; error?: string } {
  try {
    requireCjs('playwright-core'); // 加载校验（工具可用性前置探测）
    // 探测系统浏览器：Windows 自带 Edge 优先，Chrome 回退（channel 由 launch 时决定）
    const { existsSync } = requireCjs('node:fs');
    const { join } = requireCjs('node:path');
    const { env } = requireCjs('node:process');
    const candidates = [
      join(env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env.PROGRAMFILES ?? 'C:/Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env.PROGRAMFILES ?? 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    for (const p of candidates) {
      if (p && existsSync(p)) {
        const name = /chrome/i.test(p) ? 'chrome' : 'msedge';
        return { ok: true, browser: `${name}（${p}）` };
      }
    }
    return { ok: false, error: '未找到系统浏览器（Edge/Chrome）——请安装 Microsoft Edge 或 Google Chrome' };
  } catch {
    return { ok: false, error: 'playwright-core 加载失败——npm install 后重试' };
  }
}

/** 惰性启动浏览器会话（单例）；失败记录归因（探测层已提示，这里不再重复） */
async function ensureBrowser(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (browser) return { ok: true };
  const probe = browserProbe();
  if (!probe.ok) return { ok: false, error: probe.error ?? '浏览器不可用' };
  try {
    const { chromium } = requireCjs('playwright-core');
    const channel = probe.browser?.startsWith('chrome') ? 'chrome' : 'msedge';
    browser = await chromium.launch({
      channel,
      headless: false, // 有头模式：用户可见浏览器窗口（可交互；无头回退在失败时尝试）
      args: ['--disable-blink-features=AutomationControlled'],
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(15000);
    return { ok: true };
  } catch (e: any) {
    launchError = String(e?.message ?? e).slice(0, 300);
    // 有头失败回退无头（CI/无显示环境）
    try {
      const { chromium } = requireCjs('playwright-core');
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(15000);
      return { ok: true };
    } catch {
      browser = null;
      return { ok: false, error: `浏览器启动失败：${launchError}` };
    }
  }
}

/** 关闭浏览器会话（/browser close 或工具调用；释放进程） */
export function browserClose(): Promise<string> {
  return serialized(async () => {
    try { if (page) await page.close(); } catch { /* 忽略 */ }
    try { if (browser) await browser.close(); } catch { /* 忽略 */ }
    browser = null;
    page = null;
    return '浏览器会话已关闭';
  });
}

/** 可交互元素清单（深度：AI 精准选择器的依据——按钮/链接/输入框/下拉的稳定选择器建议） */
async function interactiveElements(): Promise<string> {
  try {
    // 字符串函数在浏览器上下文执行（Node tsconfig 无 DOM lib，避免类型报错）
    const els = await page.evaluate(`(() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"]')) {
        if (out.length >= 40) break;
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        const id = el.id ? '#' + el.id : '';
        const name = el.name ? '[name="' + el.name + '"]' : '';
        const ph = el.placeholder ? '[placeholder="' + el.placeholder + '"]' : '';
        const type = tag === 'input' ? ' type=' + (el.type || 'text') : '';
        const href = el.href ? ' → ' + el.href.slice(0, 80) : '';
        const key = tag + id + name + ph + text;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push('<' + tag + id + name + ph + type + '> ' + (text || '(无文本)') + href);
      }
      return out;
    })()`);
    if (!Array.isArray(els) || !els.length) return '';
    return `可交互元素（选择器建议：<tag>#id / <tag>[name=…] / <tag>:has-text("文本")）：
${els.join('\n')}`;
  } catch {
    return '';
  }
}

/** 可访问性树 → 紧凑文本快照（AI 理解页面结构；深度：含可交互元素清单） */
async function snapshotText(): Promise<string> {
  try {
    const title = await page.title();
    const url = page.url();
    const body = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
    const clean = String(body ?? '').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').slice(0, 2500);
    const els = await interactiveElements();
    return `标题：${title}\n地址：${url}\n正文：\n${clean}${els ? `\n\n${els}` : ''}`;
  } catch (e: any) {
    return `快照失败：${String(e?.message ?? e).slice(0, 200)}`;
  }
}

/** 截图保存到 data/browser-*.png（AI 视觉模型可分析；返回路径） */
async function takeShot(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    const { resolveDataDir } = await import('./paths.js');
    const dir = resolveDataDir(process.cwd());
    mkdirSync(join(dir, 'browser'), { recursive: true });
    const file = join(dir, 'browser', `shot-${Date.now().toString(36)}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return { ok: true, path: file };
  } catch (e: any) {
    return { ok: false, error: `截图失败：${String(e?.message ?? e).slice(0, 200)}` };
  }
}

export interface BrowserToolResult { ok: boolean; text: string }

/** browser_navigate：打开 URL（SSRF 三层防护——内网/重绑定/重定向逐跳）→ 页面快照 */
export function browserNavigate(url: string): Promise<BrowserToolResult> {
  return serialized(async () => {
    const target = String(url ?? '').trim();
    if (!target) return { ok: false, text: '参数错误：url 必填' };
    const safe = await checkUrlSafety(target);
    if (!safe.ok) return { ok: false, text: `已拦截：${safe.reason}` };
    const boot = await ensureBrowser();
    if (!boot.ok) return { ok: false, text: boot.error };
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const snap = await snapshotText();
      return { ok: true, text: `已打开 ${target}\n${snap}` };
    } catch (e: any) {
      return { ok: false, text: `导航失败：${String(e?.message ?? e).slice(0, 300)}` };
    }
  });
}

/** browser_click：CSS 选择器点击 */
export function browserClick(selector: string): Promise<BrowserToolResult> {
  return serialized(async () => {
    const boot = await ensureBrowser();
    if (!boot.ok) return { ok: false, text: boot.error };
    if (!page) return { ok: false, text: '浏览器未打开页面——先 browser_navigate' };
    try {
      await page.locator(String(selector ?? '')).first().click({ timeout: 10000 });
      const url = page.url();
      return { ok: true, text: `已点击「${selector}」→ ${url}\n${(await snapshotText()).slice(0, 1500)}` };
    } catch (e: any) {
      return { ok: false, text: `点击失败（选择器「${selector}」未命中？）：${String(e?.message ?? e).slice(0, 200)}` };
    }
  });
}

/** browser_type：输入文本（可回车提交） */
export function browserType(selector: string, text: string, submit = false): Promise<BrowserToolResult> {
  return serialized(async () => {
    const boot = await ensureBrowser();
    if (!boot.ok) return { ok: false, text: boot.error };
    if (!page) return { ok: false, text: '浏览器未打开页面——先 browser_navigate' };
    try {
      const loc = page.locator(String(selector ?? '')).first();
      await loc.fill(String(text ?? ''), { timeout: 10000 });
      if (submit) await loc.press('Enter');
      return { ok: true, text: `已输入「${String(text ?? '').slice(0, 60)}」${submit ? '并回车' : ''}` };
    } catch (e: any) {
      return { ok: false, text: `输入失败（选择器「${selector}」未命中？）：${String(e?.message ?? e).slice(0, 200)}` };
    }
  });
}

/** browser_screenshot：截图落盘（/img 可分析；返回路径） */
export function browserScreenshot(): Promise<BrowserToolResult> {
  return serialized(async () => {
    const boot = await ensureBrowser();
    if (!boot.ok) return { ok: false, text: boot.error };
    if (!page) return { ok: false, text: '浏览器未打开页面——先 browser_navigate' };
    const shot = await takeShot();
    if (!shot.ok) return { ok: false, text: shot.error };
    return { ok: true, text: `截图已保存：${shot.path}（/img <路径> 可视觉分析）` };
  });
}

/** browser_snapshot：当前页面可访问性快照（深度：含可交互元素清单） */
export function browserSnapshot(): Promise<BrowserToolResult> {
  return serialized(async () => {
    const boot = await ensureBrowser();
    if (!boot.ok) return { ok: false, text: boot.error };
    if (!page) return { ok: false, text: '浏览器未打开页面——先 browser_navigate' };
    return { ok: true, text: await snapshotText() };
  });
}

/** browser_wait：等待元素出现（SPA 动态加载）或固定毫秒——交互前确保页面就绪 */
export function browserWait(selector: string, timeoutMs = 15000): Promise<BrowserToolResult> {
  return serialized(async () => {
    const boot = await ensureBrowser();
    if (!boot.ok) return { ok: false, text: boot.error };
    if (!page) return { ok: false, text: '浏览器未打开页面——先 browser_navigate' };
    const sel = String(selector ?? '').trim();
    try {
      if (!sel) {
        await new Promise(r => setTimeout(r, Math.min(Number(timeoutMs) || 2000, 15000)));
        return { ok: true, text: `已等待 ${Math.min(Number(timeoutMs) || 2000, 15000)}ms` };
      }
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: Number(timeoutMs) || 15000 });
      return { ok: true, text: `元素已出现：${sel}` };
    } catch (e: any) {
      return { ok: false, text: `等待超时（${sel} 未出现）：${String(e?.message ?? e).slice(0, 150)}` };
    }
  });
}
