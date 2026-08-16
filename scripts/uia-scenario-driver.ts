// scripts/uia-scenario-driver.ts — Gate E uia 场景驱动（生产代码路径：真实桥 + 真实端口 + WindowsUiaDriver）
// 正向：Invoke（Button）/ Value（TextBox 中文原生）/ Selection（ListBox item）——每步端到端读回（echo 文件）；
// 负向：不存在元素 → 全链路诚实失败（UIA_ACTION_NOT_PERFORMED，绝不假成功）。
// 用法：由 tests/acceptance/windows/uia.ps1 编排调用（npx tsx scripts/uia-scenario-driver.ts）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uiaWindows, uiaType } from '../src/kernel/computer/uia.js';
import { createWindowsUiaPorts } from '../src/infrastructure/computer/windowsUiaPorts.js';
import { WindowsUiaDriver } from '../src/infrastructure/computer/windowsUiaDriver.js';

const echoDir = process.env.WXNODUS_UIA_ECHO_DIR ?? join(process.env.TEMP ?? '.', 'wxnodus-uia-echo');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const driver = new WindowsUiaDriver(createWindowsUiaPorts());
const results: Array<{ id: string; ok: boolean; detail: unknown }> = [];
const record = (id: string, ok: boolean, detail: unknown) => { results.push({ id, ok, detail }); };

async function main(): Promise<void> {
  // 等 fixture 窗口出现（真实桌面窗口枚举——uiaWindows 过滤 offscreen，窗口必须可见）
  let handle = '';
  for (let i = 0; i < 30; i++) {
    const r = uiaWindows();
    const win = (r.windows ?? []).find(w => String(w.name).includes('WxNodus-UiaFixture'));
    if (win) { handle = String(win.handle); break; }
    await sleep(1000);
  }
  if (!handle) {
    console.log(JSON.stringify({ ok: false, reason: 'fixture window not found', results }));
    process.exit(1);
  }

  // 1. Invoke 正向（Button → 驱动 act → invoke 端口）——WPF AutomationId 定位
  const inv = await driver.act({ runtimeId: `|FixtureButton|${handle}`, action: 'activate' }, {}, AbortSignal.timeout(30000));
  record('invoke', inv.ok, inv.ok ? inv.value : inv.error);

  // 2. Value 正向（TextBox 中文原生输入——无剪贴板 hack）
  const typ = uiaType('中文native', '|FixtureEdit', handle);
  record('value', typ.ok, typ.ok ? typ.element : typ.reason);

  // 3. Invoke 端到端读回：按钮处理器把 TextBox 当前值写 invoke-echo.txt
  const inv2 = await driver.act({ runtimeId: `|FixtureButton|${handle}`, action: 'activate' }, {}, AbortSignal.timeout(30000));
  let invokeEcho = '';
  try { invokeEcho = readFileSync(join(echoDir, 'invoke-echo.txt'), 'utf8').trim(); } catch { /* 读不到即证据缺失 */ }
  record('invoke-readback', inv2.ok && invokeEcho.includes('中文native'), invokeEcho);

  // 4. Selection 正向（ListBox item 'Beta'：invoke 端口无模式 → 驱动转 select 端口）
  const sel = await driver.act({ runtimeId: `|ItemBeta|${handle}`, action: 'activate' }, {}, AbortSignal.timeout(30000));
  record('selection', sel.ok && String((sel as { value?: { receiptId: string } }).value?.receiptId ?? '').startsWith('uia-select-'), sel.ok ? sel.value : sel.error);
  let selectEcho = '';
  try { selectEcho = readFileSync(join(echoDir, 'select-echo.txt'), 'utf8').trim(); } catch { /* 读不到即证据缺失 */ }
  record('selection-readback', selectEcho === 'Beta', selectEcho);

  // 5. 负向：不存在元素 → invoke/select/坐标兜底全失败 → 诚实 UIA_ACTION_NOT_PERFORMED
  const neg = await driver.act({ runtimeId: `|NoSuchElement|${handle}`, action: 'activate' }, {}, AbortSignal.timeout(30000));
  const negCode = (neg as { error?: { code: string } }).error?.code ?? '';
  record('no-action-fail-closed', !neg.ok && (negCode === 'UIA_ACTION_NOT_PERFORMED' || negCode === 'UIA_COORDINATE_FALLBACK_FORBIDDEN'), neg.ok ? neg.value : neg.error);

  const positives = results.filter(r => !r.id.startsWith('no-action'));
  const ok = positives.every(r => r.ok) && results.some(r => r.id === 'no-action-fail-closed' && r.ok);
  const summary = { ok, fixtureHandle: handle, results };
  // 文件握手：ps1 编排方读取此文件（stdout 仅作人工调试——管道/编码/2>&1 均不参与判定）
  try { writeFileSync(join(echoDir, 'driver-result.json'), JSON.stringify(summary), 'utf8'); } catch { /* 写失败则 stdout 仍兜底 */ }
  console.log(JSON.stringify(summary));
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.log(JSON.stringify({ ok: false, reason: String(e?.message ?? e).slice(0, 300), results }));
  process.exit(1);
});
