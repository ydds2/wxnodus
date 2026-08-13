import type { GatewayService } from '../../application/gatewayService.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import { createSharedAdapter } from '../shared/inProcessAdapter.js';

export function createWireGatewayAdapter(service: GatewayService, sessionId: string) {
  let ready = false;
  return {
    ...createSharedAdapter(service, 'wire', sessionId),
    markReady() { ready = true; },
    connectApproval(_handler: (input: unknown) => void) {
      return ready ? ok(undefined) : err(gatewayError('WIRE_GATEWAY_NOT_READY', 'Wire Gateway 尚未 ready', 'wire.gateway.not_ready'));
    },
  };
}
