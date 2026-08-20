import type { GatewayService } from '../../application/gatewayService.js';
import { createSharedAdapter } from '../shared/inProcessAdapter.js';

export const createCliGatewayAdapter = (service: GatewayService, sessionId: string) => createSharedAdapter(service, 'cli', sessionId);
