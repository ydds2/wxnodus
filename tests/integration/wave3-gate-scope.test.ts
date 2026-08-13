// tests/integration/wave3-gate-scope.test.ts — W3-11 Step 1：Wave 3 scoped Gate 契约（计划原文）
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WAVE3_GATE_DEFINITIONS, WAVE3_TEST_FILES } from '../../src/release/gateDefinitions.js';

it('contains only Wave 3-owned A/B/C/D/E/F/G slices', () => {
  expect(WAVE3_GATE_DEFINITIONS.map(gate => gate.id)).toEqual(['A-W3', 'B-W3', 'C-W3', 'D-W3', 'E-W3', 'F-W3', 'G-W3']);
  expect(WAVE3_GATE_DEFINITIONS.some(gate => gate.id.startsWith('H-') || gate.id.startsWith('I-'))).toBe(false);
  expect(WAVE3_GATE_DEFINITIONS.every(gate => gate.wave === 3)).toBe(true);
  expect(WAVE3_GATE_DEFINITIONS.find(gate => gate.id === 'C-W3')?.command).toEqual([
    'npm.cmd', ['run', 'drill:wave3-recovery'],
  ]);
});

it('uses an exact test manifest rather than a directory-wide shorthand', () => {
  expect(WAVE3_TEST_FILES.length).toBeGreaterThanOrEqual(20);
  expect(WAVE3_TEST_FILES.every(path => path.startsWith('tests/') && path.endsWith('.test.ts'))).toBe(true);
  expect(new Set(WAVE3_TEST_FILES).size).toBe(WAVE3_TEST_FILES.length);
});

it('forbids known direct legacy imports and direct executions', async () => {
  const targets = [
    'src/commands/handlers.ts',
    'src/commands/handlersExt.ts',
    'src/kernel/tools.ts',
    'src/wxnodus-ui/wxGateway.ts',
  ];
  for (const target of targets) {
    const source = await readFile(target, 'utf8');
    expect(source).not.toMatch(/new ComputerUse\(|startRecording\(|stopAndTranscribe\(|scaffoldProject\(|spawnSync\(/);
  }
});
