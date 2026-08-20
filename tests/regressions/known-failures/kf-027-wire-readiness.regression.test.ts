// tests/regressions/known-failures/kf-027-wire-readiness.regression.test.ts — KF-027 正式回归
// wire stdin RPC 帧处理器必须在 gateway/frontend/事件订阅全部装配完成（ready）之后才分发；
// ready 之前到达的帧返回 WIRE_GATEWAY_NOT_READY（源码结构断言 + adapter 层行为双锁）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGatewayService } from '../../../src/application/createGatewayService.js';
import { createWireGatewayAdapter } from '../../../src/presentation/wire/wireGatewayAdapter.js';

const cliSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/cli/index.ts'),
  'utf8',
);

describe('KF-027 wire readiness (resolved)', () => {
  it('CLI wire stdin handler gates RPC frames behind a ready flag', () => {
    const start = cliSource.indexOf('if (opts.wire) {');
    const wireBlock = start >= 0 ? cliSource.slice(start, cliSource.indexOf('process.exit(0)', start)) : '';
    expect(wireBlock).toContain('wireReady');
    // 门控判定必须在 frame 分发之前（源码顺序：!wireReady 检查先于 gateway.request）
    const gateIdx = wireBlock.indexOf('if (!wireReady)');
    const dispatchIdx = wireBlock.indexOf('gateway.request(frame.method');
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(dispatchIdx).toBeGreaterThan(gateIdx);
  });

  it('wire adapter rejects approval frames before ready and accepts after', () => {
    const service = createGatewayService({});
    const wire = createWireGatewayAdapter(service, 's1');
    expect(wire.connectApproval(() => undefined)).toMatchObject({
      ok: false, error: { code: 'WIRE_GATEWAY_NOT_READY' },
    });
    wire.markReady();
    expect(wire.connectApproval(() => undefined)).toMatchObject({ ok: true });
  });
});
