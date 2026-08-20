// src/presentation/http/httpGatewayAdapter.ts — 安全 HTTP adapter：TLS→Host/Origin→forwarded→token→session 所有权→委托
import { randomUUID } from 'node:crypto';
import type { GatewayService } from '../../application/gatewayService.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import { evaluateHttpTransport, validateHttpSecurityConfig, type HttpRequestFacts, type HttpSecurityConfig } from './httpSecurity.js';
import type { HttpSessionIsolation } from './httpSessionIsolation.js';
import type { HttpTokenStore } from './httpTokenStore.js';

export interface HttpGatewayConfig extends HttpSecurityConfig {
  tokens: HttpTokenStore;
  sessions: HttpSessionIsolation;
  now(): number;
}

export interface HttpGatewayRequest extends HttpRequestFacts {
  method: string;
  params: Record<string, unknown>;
  correlationId?: string;
  signal?: AbortSignal;
}

export function createHttpGatewayAdapter(service: GatewayService, config: HttpGatewayConfig) {
  const valid = validateHttpSecurityConfig(config);
  if (!valid.ok) return valid;
  return ok({
    bindSession(subject: string, sessionId: string) {
      return config.sessions.bind(subject, sessionId);
    },
    async request(input: HttpGatewayRequest) {
      const transport = evaluateHttpTransport(config, input);
      if (!transport.ok) {
        return { result: transport, corsOrigin: undefined, clientIp: input.peerAddress };
      }
      const authorization = input.headers.authorization ?? '';
      const match = /^Bearer (.+)$/i.exec(authorization);
      if (!match) {
        return { result: err(gatewayError('HTTP_TOKEN_MISSING', '缺少 Bearer token', 'http.token.missing')), corsOrigin: transport.value.corsOrigin, clientIp: transport.value.clientIp };
      }
      const token = config.tokens.verify(match[1]!, config.now());
      if (!token.ok) {
        return { result: token, corsOrigin: transport.value.corsOrigin, clientIp: transport.value.clientIp };
      }
      const sessionId = String(input.params.sessionId ?? input.params.session_id ?? '');
      const ownership = config.sessions.assertOwner(token.value.subject, sessionId);
      if (!ownership.ok) {
        return { result: ownership, corsOrigin: transport.value.corsOrigin, clientIp: transport.value.clientIp };
      }
      const result = await service.request({
        method: input.method,
        params: input.params,
        sessionId,
        source: 'http',
        correlationId: input.correlationId ?? randomUUID(),
        signal: input.signal,
      });
      return { result, corsOrigin: transport.value.corsOrigin, clientIp: transport.value.clientIp };
    },
  });
}
