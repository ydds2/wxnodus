// scripts/verify-view-image.ts（临时真机验证脚本——1.1 验收：真实图片走 view_image 全链路）
import { coreTools } from '../src/kernel/tools.js';

(async () => {
  const t = coreTools().view_image!;
  const ctx = { cwd: process.cwd(), dataDir: process.cwd(), sessionId: 'real-check' } as any;
  const out = await t.run({ path: 'artifacts/cmd-audit/01-startup.png' }, ctx);
  console.log('RUN>>>', out);
  const imgs = await t.extractImages!({ path: 'artifacts/cmd-audit/01-startup.png' }, ctx);
  console.log('IMGS>>>', imgs ? `${imgs.length} part, head=${imgs[0]!.image_url.url.slice(0, 44)}` : 'null');
})();
