// src/infrastructure/build/persistenceProbe.ts — 业务持久化探针：seed（写 token+值）→ 重启 → readBack 同一 token
import { randomUUID } from 'node:crypto';

export interface PersistenceProbePorts {
  write(token: string, value: unknown): Promise<void>;
  read(token: string): Promise<unknown>;
}

export class PersistenceProbe {
  constructor(private readonly ports: PersistenceProbePorts, private readonly value: unknown) {}

  async seed(_processId: number, _signal: AbortSignal): Promise<{ token: string; expected: unknown }> {
    const token = randomUUID();
    await this.ports.write(token, this.value);
    return { token, expected: this.value };
  }

  async readBack(_processId: number, token: { token: string; expected: unknown }, _signal: AbortSignal): Promise<unknown> {
    void token.expected;
    return this.ports.read(token.token);
  }
}
