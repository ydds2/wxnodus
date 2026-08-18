// packages/vscode-ext/scripts/build.mjs — esbuild 打包为单文件 dist/extension.js（CJS——vscode 扩展宿主格式）
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
console.log('built dist/extension.js');
