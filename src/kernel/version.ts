// src/kernel/version.ts — 版本单一事实源（package.json）
// 运行时读取：src 与 dist 同深度（../../package.json），tsx 开发与编译产物均正确解析；
// 读取失败回退 '0.0.0'——版本显示绝不因文件缺失而崩溃。
// 改版本只动 package.json 的 version 字段，全仓显示处（banner//version/serve/MCP/ACP/打包）自动同步。
import { readFileSync } from 'node:fs';

export const WXNODUS_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
