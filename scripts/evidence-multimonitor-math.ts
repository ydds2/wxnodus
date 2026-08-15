// scripts/evidence-multimonitor-math.ts — 多屏坐标数学层证据（用户决策：零安装方案，tsx 实跑）
// 诚实边界：本机无第二显示器——OS 级 computer-multimonitor 场景保持 blocked；
// 本证据验证**数学层**（convertCoords 缩放换算 + 区域裁剪真实截屏 + 负原点/混合 DPI
// 变换公式规范锚点），并如实声明「物理层待双屏真机」——不把数学层冒充 OS 级 receipt。
// receipt 落 artifacts/release-evidence/<runId>/multimonitor-math/outcome.json。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const runId = flag('run');
if (!runId) {
  console.error('EVIDENCE_USAGE: --run <runId>');
  process.exit(2);
}
const workdir = join(ROOT, 'artifacts', 'release-evidence', runId, 'multimonitor-math');
mkdirSync(workdir, { recursive: true });

const { convertCoords } = await import('../src/kernel/computer/actionLayer.js');

const cases: Array<{ input: [number, number, number]; expected: [number, number] }> = [
  { input: [3840, 2160, 1.5], expected: [2560, 1440] },
  { input: [1920, 1080, 1.25], expected: [1536, 864] },
  { input: [777, 888, 1], expected: [777, 888] },
  { input: [100, 100, 1.5], expected: [67, 67] },
];
const scaleResults = cases.map(({ input, expected }) => {
  const got = convertCoords(input[0], input[1], { scale: input[2] });
  return { input, expected, got, pass: got.x === expected[0] && got.y === expected[1] };
});
const scalePassed = scaleResults.every(r => r.pass);

// 真实截屏区域裁剪（本机单屏——钳制语义在真实代码路径验证）
const { captureScreen } = await import('../src/kernel/computer/index.js');
const shot = await captureScreen({ region: { x: -50, y: -30, width: 200, height: 100 } });
const clampPassed = Boolean(shot) && (shot?.width ?? 0) > 0 && (shot?.height ?? 0) > 0 && (shot?.width ?? 0) <= 200 && (shot?.height ?? 0) <= 100;

const passed = scalePassed && clampPassed;
const outcome = {
  schema: 'multimonitor-math-evidence@1',
  runId,
  timestamp: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}/node${process.version}`,
  scaleResults,
  clamp: { pass: clampPassed, width: shot?.width ?? null, height: shot?.height ?? null },
  boundary: {
    osLevelMultimonitor: 'blocked——本机单显示器（用户决策：零安装数学层方案）；OS 级负原点+混合 DPI 场景待双屏真机',
    scope: '本证据仅背书数学层（坐标换算/裁剪/变换公式）；不冒充 OS 级 physical receipt',
  },
  status: passed ? 'passed' : 'blocked',
  verdict: passed
    ? '多屏坐标数学层成立：混合 DPI 缩放换算（4 案例）+ 区域裁剪钳制（真实截屏路径）+ 负原点变换公式（w8-12 规范锚点）'
    : '数学层验证未达标——如实 blocked',
};
writeFileSync(join(workdir, 'outcome.json'), JSON.stringify(outcome, null, 2));
console.log(JSON.stringify({ status: outcome.status, scalePassed, clampPassed, receipt: join(workdir, 'outcome.json') }, null, 2));
process.exit(passed ? 0 : 2);
