// scripts/uia-scenario-driver.ts — Gate E uia 场景驱动（生产代码路径：真实桥 + 真实端口 + WindowsUiaDriver）
// 正向：Invoke（WPF Button）/ Value + 读回（notepad 真实 Win32 RichEdit——WPF TextBox 的 ValuePattern
//   在本机静默失效，见 docs/audit-deep.md 第 11 节）/ Selection（WPF ListBox item）+ 端到端读回（echo 文件）；
// 负向：不存在元素 → 全链路诚实失败（UIA_ACTION_NOT_PERFORMED，绝不假成功）。
// 用法：由 tests/acceptance/windows/uia.ps1 编排调用（npx tsx scripts/uia-scenario-driver.ts）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uiaWindows, uiaType, uiaRead } from '../src/kernel/computer/uia.js';
import { createWindowsUiaPorts } from '../src/infrastructure/computer/windowsUiaPorts.js';
import { WindowsUiaDriver } from '../src/infrastructure/computer/windowsUiaDriver.js';

const echoDir = process.env.WXNODUS_UIA_ECHO_DIR ?? join(process.env.TEMP ?? '.', 'wxnodus-uia-echo');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const driver = new WindowsUiaDriver(createWindowsUiaPorts());
const results: Array<{ id: string; ok: boolean; detail: unknown }> = [];
const record = (id: string, ok: boolean, detail: unknown) => { results.push({ id, ok, detail }); };

async function findWindow(pred: (w: { name: string; className: string; handle: string }) => boolean, tries = 30): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const r = uiaWindows();
    const win = (r.windows ?? []).find(pred);
    if (win) return String(win.handle);
    await sleep(1000);
  }
  return '';
}

async function main(): Promise<void> {
  // 1. Value 正向 + 真实读回（notepad 真实 Win32 RichEdit——宿主控件无 Name/Id，按 ct:Document 定位
  //    （新版 tabbed Notepad 编辑器 ControlType=Document；WPF TextBox 的 ValuePattern 在本机静默失效））
  const npH = await findWindow(w => String(w.className) === 'Notepad', 15);
  if (!npH) {
    record('value', false, 'notepad window not found');
    record('value-readback', false, '');
  } else {
    const typ = uiaType('中文native', 'ct:Document', npH);
    record('value', typ.ok, typ.ok ? typ.element : typ.reason);
    await sleep(500);
    const rd = uiaRead('ct:Document', npH);
    const val = String((rd.element as { value?: string } | undefined)?.value ?? '');
    record('value-readback', rd.ok && val === '中文native', val);
  }

  // 2. Invoke 正向（WPF Button → 驱动 act → invoke 端口）
  const fxH = await findWindow(w => String(w.name).includes('WxNodus-UiaFixture'));
  if (!fxH) {
    record('invoke', false, 'fixture window not found');
    record('selection', false, 'fixture window not found');
    record('selection-readback', false, '');
    record('no-action-fail-closed', false, 'fixture window not found');
    console.log(JSON.stringify({ ok: false, reason: 'fixture window not found', results }));
    process.exit(1);
  }
  const inv = await driver.act({ runtimeId: `|FixtureButton|${fxH}`, action: 'activate' }, {}, AbortSignal.timeout(30000));
  record('invoke', inv.ok, inv.ok ? inv.value : inv.error);

  // 3. Selection 正向（ListBox item 'Beta'：invoke 端口无模式 → 驱动转 select 端口）+ echo 读回
  const sel = await driver.act({ runtimeId: `|ItemBeta|${fxH}`, action: 'activate' }, {}, AbortSignal.timeout(30000));
  record('selection', sel.ok && String((sel as { value?: { receiptId: string } }).value?.receiptId ?? '').startsWith('uia-select-'), sel.ok ? sel.value : sel.error);
  let selectEcho = '';
  try { selectEcho = readFileSync(join(echoDir, 'select-echo.txt'), 'utf8').trim(); } catch { /* 读不到即证据缺失 */ }
  record('selection-readback', selectEcho === 'Beta', selectEcho);

  // 4. 负向：不存在元素 → invoke/select/坐标兜底全失败 → 诚实 UIA_ACTION_NOT_PERFORMED
  const neg = await driver.act({ runtimeId: `|NoSuchElement|${fxH}`, action: 'activate' }, {}, AbortSignal.timeout(30000));
  const negCode = (neg as { error?: { code: string } }).error?.code ?? '';
  record('no-action-fail-closed', !neg.ok && (negCode === 'UIA_ACTION_NOT_PERFORMED' || negCode === 'UIA_COORDINATE_FALLBACK_FORBIDDEN'), neg.ok ? neg.value : neg.error);

  const positives = results.filter(r => !r.id.startsWith('no-action'));
  const ok = positives.every(r => r.ok) && results.some(r => r.id === 'no-action-fail-closed' && r.ok);
  const summary = { ok, fixtureHandle: fxH, notepadHandle: npH, results };
  // 文件握手：ps1 编排方读取此文件（stdout 仅作人工调试——管道/编码/2>&1 均不参与判定）
  try { writeFileSync(join(echoDir, 'driver-result.json'), JSON.stringify(summary), 'utf8'); } catch { /* 写失败则 stdout 仍兜底 */ }
  console.log(JSON.stringify(summary));
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.log(JSON.stringify({ ok: false, reason: String(e?.message ?? e).slice(0, 300), results }));
  process.exit(1);
});
