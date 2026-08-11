// src/kernel/snap/browser.ts — 浏览器域（playwright-core 封装，回源操作）
// 设计：系统 Chrome/Edge 启动（channel 探测），headless 默认——聚合界面操作
//       真实回源站执行（点击/输入/提交发生在源页面，本模块仅控制浏览器）。
//       会话复用源站正常登录态（不绕认证）；无浏览器环境干净降级。
import type { Browser, Page } from 'playwright-core';

let browser: Browser | null = null;
let page: Page | null = null;

export interface SnapBrowser {
  page: Page | null;
  open(url: string): Promise<{ ok: boolean; title: string; error?: string }>;
  /** 截取当前页面（PNG buffer）——多模态网站识别输入源 */
  screenshot(): Promise<Buffer | null>;
  act(kind: 'click' | 'fill' | 'submit', sel: string, value?: string): Promise<{ ok: boolean; message: string }>;
  close(): void;
}

async function launch(): Promise<Browser | null> {
  try {
    const { chromium } = await import('playwright-core');
    // 系统浏览器优先（channel），否则 playwright 自带 chromium
    for (const channel of ['chrome', 'msedge'] as const) {
      try {
        return await chromium.launch({ channel, headless: true });
      } catch (e: any) { if (process.env.WXNODUS_DEBUG_BROWSER) console.error('[launch]', channel, String(e?.message ?? e).slice(0, 150)); }
    }
    try {
      return await chromium.launch({ headless: true });
    } catch (e: any) { if (process.env.WXNODUS_DEBUG_BROWSER) console.error('[launch] default', String(e?.message ?? e).slice(0, 150)); return null; }
  } catch { return null; } // 无浏览器环境
}

export async function snapBrowser(): Promise<SnapBrowser> {
  if (!browser) browser = await launch();
  if (!browser) {
    return { page: null, open: async () => ({ ok: false, title: '', error: '浏览器不可用（需 Chrome/Edge，或安装 playwright 浏览器）' }), screenshot: async () => null, act: async () => ({ ok: false, message: '浏览器未启动' }), close() {} };
  }
  return {
    // getter：open() 后才创建 page——调用方每次读取都能拿到最新实例
    get page() { return page; },
    async screenshot() {
      if (!page) return null;
      try { return await page.screenshot({ type: 'png' }); } catch { return null; }
    },
    async open(url) {
      try {
        if (!page) page = await browser!.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(800); // 动态渲染缓冲
        return { ok: true, title: await page.title() };
      } catch (e: any) {
        return { ok: false, title: '', error: String(e?.message ?? e).slice(0, 200) };
      }
    },
    async act(kind, sel, value) {
      if (!page) return { ok: false, message: '页面未打开（先 /snap <URL>）' };
      try {
        if (kind === 'click') {
          await page.click(sel, { timeout: 8000 });
          return { ok: true, message: `已点击 ${sel}` };
        }
        if (kind === 'fill') {
          await page.fill(sel, value ?? '');
          return { ok: true, message: `已填写 ${sel}` };
        }
        // submit：Enter 提交（表单）
        await page.press(sel, 'Enter');
        await page.waitForTimeout(600);
        return { ok: true, message: `已提交 ${sel}（源站执行）` };
      } catch (e: any) {
        return { ok: false, message: `回源操作失败：${String(e?.message ?? e).slice(0, 200)}` };
      }
    },
    close() {
      try { page?.close(); page = null; } catch { /* 忽略 */ }
    },
  };
}
