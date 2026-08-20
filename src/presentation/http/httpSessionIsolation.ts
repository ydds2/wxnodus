// src/presentation/http/httpSessionIsolation.ts — session 所有权绑定 subject，跨 client 一律拒绝
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';

export function createHttpSessionIsolation() {
  const ownerBySession = new Map<string, string>();
  return {
    bind(subject: string, sessionId: string) {
      const owner = ownerBySession.get(sessionId);
      if (owner && owner !== subject) {
        return err(gatewayError('HTTP_SESSION_CROSS_CLIENT', 'session 属于其他 client', 'http.session.cross_client'));
      }
      ownerBySession.set(sessionId, subject);
      return ok({ sessionId });
    },
    assertOwner(subject: string, sessionId: string) {
      const owner = ownerBySession.get(sessionId);
      return owner === subject
        ? ok({ sessionId })
        : err(gatewayError('HTTP_SESSION_CROSS_CLIENT', '禁止跨 client 访问 session', 'http.session.cross_client'));
    },
  };
}

export type HttpSessionIsolation = ReturnType<typeof createHttpSessionIsolation>;
