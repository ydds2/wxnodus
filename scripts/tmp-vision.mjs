// scripts/tmp-vision.mjs — GLM 多模态识别截图（ZCode 会话不嵌图：deepseek-v4-pro 拒收 image_url）
// 用法：node scripts/tmp-vision.mjs <图片路径> [提示词]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const target = process.argv[2];
const prompt = process.argv[3] ?? '描述这张终端截图：界面布局、文字内容、有无乱码/豆腐块/错位/颜色异常，以及任何视觉缺陷。';

const { describeImageStatus } = await import('../dist/kernel/vision.js');
const settings = JSON.parse(readFileSync(new URL('../data/settings.json', import.meta.url), 'utf8'));
const r = await describeImageStatus(target, null, prompt, settings);
if (!r.ok) {
  console.error('VISION_FAIL:', r.reason);
  process.exit(1);
}
console.log(r.text);
