// src/kernel/paths.ts — 路径约定单一事实源（开放兼容：数据目录可经 env 覆盖）
// 历史版本 dataDir 约定（<cwd>/data）散落 8+ 处且不可覆盖——本模块收敛为唯一出口。
// WXNODUS_DATA_DIR 设置后，多实例/换目录无需 --cwd（数据/会话/插件/快照全部跟随）
import { join } from 'node:path';

export function resolveDataDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WXNODUS_DATA_DIR?.trim();
  return override || join(cwd, 'data');
}
