import type { GatewayService } from '../../application/gatewayService.js';
import { createSharedAdapter } from '../shared/inProcessAdapter.js';

export const createInProcessGatewayAdapter = (service: GatewayService, sessionId: string) => createSharedAdapter(service, 'tui', sessionId);
