// scripts/personalize-wxnodus.ts — 「独立艺术品」品牌化 demo：
// 用法：npm exec -- tsx scripts/personalize-wxnodus.ts --name <名称> [--icon <emoji/短文本/data-URI>] [--show]
// 产出：user config 写入 branding（原子持久化；--show 仅打印当前品牌）
import { join } from 'node:path';
import { ConfigService, DEFAULT_BRANDING } from '../src/application/config/configService.js';
import { ConfigRepository } from '../src/infrastructure/config/configRepository.js';
import { resolveDataDir } from '../src/kernel/paths.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const userFile = join(resolveDataDir(process.cwd()), 'config.json');
const service = new ConfigService(new ConfigRepository({ userFile, workspaceFile: join(process.cwd(), '.wxnodus', 'config.yaml') }));

if (args.includes('--show')) {
  const resolved = await service.resolveBranding();
  if (!resolved.ok) {
    process.stderr.write(`${resolved.error.code}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(resolved.value, null, 2)}\n`);
  process.exit(0);
}

const name = flag('--name');
const icon = flag('--icon');
if (!name) {
  process.stderr.write('usage: personalize-wxnodus.ts --name <名称> [--icon <icon>] [--show]\n');
  process.exit(2);
}
const result = await service.setBranding('user', { name, ...(icon ? { icon } : {}) });
if (!result.ok) {
  process.stderr.write(`${result.error.code}\n`);
  process.exit(1);
}
const resolved = await service.resolveBranding();
process.stdout.write(`品牌已设置：${JSON.stringify(resolved.ok ? resolved.value : DEFAULT_BRANDING, null, 2)}\n`);
