// tests/kernel-posix-sandbox.test.ts — macOS/Linux 沙盒（gap ⑥ 三平台化：bwrap/Seatbelt）
// 纯函数部分（bwrap 参数构建/Seatbelt profile 文本）全平台确定性测试；
// 探测契约：Windows 上必须诚实返回「非 Linux/macOS 平台」——POSIX 实机校准待 mac/Linux
// 环境（⑥ 评分在实机校准前不升 10，见审计口径）。L2 限速降级口径一并断言（诚实原则）。
import { describe, it, expect } from 'vitest';
import { bwrapArgs, seatbeltProfile, probePosixSandbox, POSIX_L2_RATE_LIMIT_NOTE, clearPosixProbeCache } from '../src/kernel/posixSandbox.js';
import { probeOsSandbox, tryOsSandboxLaunch } from '../src/kernel/osSandbox.js';

describe('bwrapArgs（纯函数：L0-L3 参数映射）', () => {
  it('L0 只读+断网：--ro-bind 工作区 + --unshare-net + --die-with-parent', () => {
    const a = bwrapArgs('L0', '/ws', '/data');
    expect(a).toContain('--die-with-parent');
    expect(a).toContain('--unshare-net');
    expect(a).toContain('--ro-bind');
    expect(a).toContain('/ws');
    expect(a[a.length - 1]).toBe('--');
  });

  it('L1 可写+断网：--bind 工作区（dataDir 恒 ro-bind）+ --unshare-net；L2 可写+联网；L3 遏制', () => {
    const l1 = bwrapArgs('L1', '/ws', '/data');
    expect(l1).toContain('--bind');
    expect(l1.filter(x => x === '--ro-bind')).toHaveLength(1); // 仅 dataDir（恒只读）
    expect(l1).toContain('--unshare-net');
    const l2 = bwrapArgs('L2', '/ws', '/data');
    expect(l2).not.toContain('--unshare-net');
    expect(l2).toContain('--bind');
    const l3 = bwrapArgs('L3', '/ws', '/data');
    expect(l3).toContain('--die-with-parent');
    expect(l3).not.toContain('--unshare-net');
  });
});

describe('seatbeltProfile（纯函数：macOS profile 文本）', () => {
  it('L0：deny file-write + deny network；L1：allow file-write + deny network；L2：allow network', () => {
    const l0 = seatbeltProfile('L0');
    expect(l0).toContain('(deny file-write*)');
    expect(l0).toContain('(deny network*)');
    const l1 = seatbeltProfile('L1');
    expect(l1).toContain('(allow file-write*)');
    expect(l1).toContain('(deny network*)');
    const l2 = seatbeltProfile('L2');
    expect(l2).toContain('(allow network*)');
  });

  it('L2 限速降级口径如实（Linux 需 root tc / Seatbelt 无原语）', () => {
    expect(POSIX_L2_RATE_LIMIT_NOTE).toContain('root');
    expect(POSIX_L2_RATE_LIMIT_NOTE).toContain('Seatbelt');
  });
});

describe('探测契约（诚实原则）', () => {
  it('Windows 上 POSIX 探测诚实返回「非 Linux/macOS 平台」', async () => {
    clearPosixProbeCache();
    const r = await probePosixSandbox(true);
    expect(r.ok).toBe(false);
    if (process.platform === 'win32') {
      expect(r.detail).toContain('非 Linux/macOS');
    } else {
      // mac/Linux 实机：探测须可解释（ok 或具体原因）——本仓库当前环境为 Windows，此分支为校准预留
      expect(typeof r.detail).toBe('string');
    }
  }, 60_000);

  it('门面 probeOsSandbox 在 Windows 走 winSandbox 探测（返回可解释结果）', async () => {
    const r = await probeOsSandbox('./.tmp-osbx-probe', true);
    expect(typeof r.ok).toBe('boolean');
    expect(r.detail.length).toBeGreaterThan(0);
  }, 60_000);

  it('门面 tryOsSandboxLaunch：profile off → 直接不适用（不探测不执行）', async () => {
    const r = await tryOsSandboxLaunch({ settings: {}, dataDir: './.tmp-osbx', cmd: '/bin/echo', args: ['x'], cwd: '.' });
    expect(r.result).toBeNull();
    expect(r.reason).toBe('off');
  });
});
