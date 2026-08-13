// src/application/compliance/platformAuthRegistry.ts — 平台授权槽位最小版（蓝图 §7.2/红线 2&5）：
// 平台授权状态登记（到期自动失效/撤销/封禁信号熔断）——「用户授权＋平台授权」双件中平台侧的证据槽位
export interface PlatformAuthRecord {
  platformId: string;
  channel: 'api' | 'carryover' | 'user-plus-platform' | 'public';
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  status: 'active' | 'expired' | 'revoked' | 'suspended';
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class PlatformAuthRegistry {
  private readonly records = new Map<string, PlatformAuthRecord>();

  register(record: PlatformAuthRecord): { ok: true } | { ok: false; error: { code: 'PLATFORM_AUTH_INVALID'; message: string } } {
    if (!SAFE_ID.test(record.platformId) || !record.grantedBy || !record.grantedAt ||
        !['api', 'carryover', 'user-plus-platform', 'public'].includes(record.channel)) {
      return { ok: false, error: { code: 'PLATFORM_AUTH_INVALID', message: 'platform auth record invalid' } };
    }
    this.records.set(record.platformId, { ...record, status: 'active' });
    return { ok: true };
  }

  status(platformId: string): PlatformAuthRecord | undefined {
    const record = this.records.get(platformId);
    if (!record) return undefined;
    if (record.status === 'active' && record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now()) {
      const expired = { ...record, status: 'expired' as const };
      this.records.set(platformId, expired);
      return expired;
    }
    return record;
  }

  revoke(platformId: string): void {
    const record = this.records.get(platformId);
    if (record) this.records.set(platformId, { ...record, status: 'revoked' });
  }

  /** 封禁/停止函信号 → 熔断（不可由租户自行解除——只能重新登记新授权） */
  suspend(platformId: string): void {
    const record = this.records.get(platformId);
    if (record && record.status !== 'revoked') this.records.set(platformId, { ...record, status: 'suspended' });
  }

  /** 授权通道判定：P2（用户+平台双授权）需要 user-plus-platform；公开数据 P3 需要 public 且不得被熔断 */
  isBlocked(platformId: string, now: number = Date.now()): boolean {
    const record = this.status(platformId);
    if (!record) return true; // 无平台授权证据 → 物理锁定（红线 6）
    if (record.status === 'revoked' || record.status === 'suspended') return true;
    if (record.status === 'expired' || (record.expiresAt !== null && Date.parse(record.expiresAt) <= now)) return true;
    return false;
  }
}
