// packages/vscode-ext/tests/wireBridge.test.mjs — wireBridge 纯函数单测（node:test，零 vscode 依赖）
// 覆盖：行解析容错（非 JSON/无 type/空行）、帧编码、审批模态载荷、应答帧构造、终态判定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// wireBridge 是 TS + type import（类型擦除后零运行时依赖）——esbuild 单文件转译后 require
const tmp = mkdtempSync(join(tmpdir(), 'wxn-ext-'));
try {
  const out = buildSync({
    entryPoints: ['src/wireBridge.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['vscode'],
  }).outputFiles[0].text;
  writeFileSync(join(tmp, 'wireBridge.cjs'), out);
} catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }

const requireCjs = createRequire(import.meta.url);
const { parseWireLine, encodeWireFrame, approvalModalText, approvalAnswer, textAnswer, isTerminalEvent } = requireCjs(join(tmp, 'wireBridge.cjs'));

test('parseWireLine：JSONL 事件行解析 + 容错', () => {
  assert.deepEqual(parseWireLine('{"type":"agent.token","text":"你"}'), { type: 'agent.token', text: '你' });
  assert.equal(parseWireLine('   '), null);
  assert.equal(parseWireLine('not json'), null);
  assert.equal(parseWireLine('{"no_type":1}'), null);
  assert.equal(parseWireLine('123'), null);
});

test('encodeWireFrame / approvalAnswer / textAnswer：请求帧构造', () => {
  assert.equal(encodeWireFrame({ method: 'approval.respond', params: { request_id: 'r1', answer: 'allow' } }),
    '{"method":"approval.respond","params":{"request_id":"r1","answer":"allow"}}\n');
  assert.deepEqual(approvalAnswer('r1', 'session'), { method: 'approval.respond', params: { request_id: 'r1', answer: 'session' } });
  assert.deepEqual(textAnswer('clarify.respond', 'r2', '好的'), { method: 'clarify.respond', params: { request_id: 'r2', answer: '好的' } });
  assert.deepEqual(textAnswer('secret.respond', 'r3', 'pwd'), { method: 'secret.respond', params: { request_id: 'r3', value: 'pwd' } });
});

test('approvalModalText：工具与参数摘要（截断防护）', () => {
  const m = approvalModalText({ type: 'approval.request', tool: 'bash', args: { command: 'git push' } });
  assert.equal(m.title, '审批请求：bash');
  assert.ok(m.detail.includes('git push'));
});

test('isTerminalEvent：agent.result 终态判定', () => {
  assert.equal(isTerminalEvent({ type: 'agent.result' }), true);
  assert.equal(isTerminalEvent({ type: 'agent.message' }), false);
});

rmSync(tmp, { recursive: true, force: true });
