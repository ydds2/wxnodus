// tests/kernel-sys-admin.test.ts — Windows 系统管理三面（sys_service/sys_registry/sys_task · 2026-08-28）
import { describe, it, expect } from 'vitest';
import { buildServiceArgs, buildRegistryArgs, buildTaskArgs, type SysAdminRunner } from '../src/kernel/sysAdmin.js';

const runnerOk: SysAdminRunner = async () => ({ code: 0, stdout: 'done', stderr: '' });
const runnerFail: SysAdminRunner = async () => ({ code: 5, stdout: '', stderr: '拒绝访问' });

describe('命令构造（纯函数）——服务 sc.exe', () => {
  it('list/status/start/stop/set-startup 全形态', () => {
    expect(buildServiceArgs({ action: 'list' })).toEqual(['query', 'state=', 'all']);
    expect(buildServiceArgs({ action: 'status', name: 'wuauserv' })).toEqual(['query', 'wuauserv']);
    expect(buildServiceArgs({ action: 'start', name: 'Spooler' })).toEqual(['start', 'Spooler']);
    expect(buildServiceArgs({ action: 'stop', name: 'Spooler' })).toEqual(['stop', 'Spooler']);
    expect(buildServiceArgs({ action: 'set-startup', name: 'wuauserv', startup: 'disabled' })).toEqual(['config', 'wuauserv', 'start=', 'disabled']);
    // 非法形态 null
    expect(buildServiceArgs({ action: 'status' })).toBeNull();
    expect(buildServiceArgs({ action: 'set-startup', name: 'x', startup: 'sometimes' })).toBeNull();
    expect(buildServiceArgs({ action: 'nope' })).toBeNull();
  });
});

describe('命令构造——注册表 reg.exe（根前缀强校验）', () => {
  it('get/set/delete/delete-tree 形态与 /f 幂等覆盖', () => {
    expect(buildRegistryArgs({ action: 'list', key: 'HKLM\\SOFTWARE\\wxnodus' })).toEqual(['query', 'HKLM\\SOFTWARE\\wxnodus']);
    expect(buildRegistryArgs({ action: 'get', key: 'HKCU\\S\\W', name: 'InstallPath' })).toEqual(['query', 'HKCU\\S\\W', '/v', 'InstallPath']);
    expect(buildRegistryArgs({ action: 'set', key: 'HKLM\\SOFTWARE\\wxnodus', name: 'Mode', value: '1', type: 'REG_DWORD' }))
      .toEqual(['add', 'HKLM\\SOFTWARE\\wxnodus', '/v', 'Mode', '/t', 'REG_DWORD', '/d', '1', '/f']);
    expect(buildRegistryArgs({ action: 'delete', key: 'HKCU\\S\\W', name: 'X' })).toEqual(['delete', 'HKCU\\S\\W', '/v', 'X', '/f']);
    expect(buildRegistryArgs({ action: 'delete-tree', key: 'HKCU\\S\\W' })).toEqual(['delete', 'HKCU\\S\\W', '/f']);
  });
  it('非根前缀键一律 null（防相对键注入）', () => {
    expect(buildRegistryArgs({ action: 'list', key: 'SOFTWARE\\no-root' })).toBeNull();
    expect(buildRegistryArgs({ action: 'list', key: '' })).toBeNull();
    expect(buildRegistryArgs({ action: 'set', key: 'HKLM\\S', name: 'v' })).toBeNull(); // 缺 value
  });
});

describe('命令构造——计划任务 schtasks.exe', () => {
  it('create 三要素校验 / query / delete / run', () => {
    expect(buildTaskArgs({ action: 'list' })).toEqual(['/query', '/fo', 'LIST', '/v']);
    expect(buildTaskArgs({ action: 'create', name: 'wxn-sync', command: 'wxnodus -p 同步', schedule: 'HOURLY' }))
      .toEqual(['/create', '/tn', 'wxn-sync', '/tr', 'wxnodus -p 同步', '/sc', 'HOURLY', '/f']);
    expect(buildTaskArgs({ action: 'delete', name: 'wxn-sync' })).toEqual(['/delete', '/tn', 'wxn-sync', '/f']);
    expect(buildTaskArgs({ action: 'run', name: 'wxn-sync' })).toEqual(['/run', '/tn', 'wxn-sync']);
    expect(buildTaskArgs({ action: 'create', name: 'x', command: 'c' })).toBeNull(); // 缺 schedule
    expect(buildTaskArgs({ action: 'query' })).toBeNull(); // 缺 name
  });
});

describe('win32 平台门（当前测试机为 win32——真跑通过/失败路径）', () => {
  it('win32 下 runner 注入：成功/失败输出形态', async () => {
    if (process.platform !== 'win32') return;
    const { sysServiceOp, sysRegistryOp, sysTaskOp } = await import('../src/kernel/sysAdmin.js');
    const r1 = await sysServiceOp({ action: 'status', name: 'nonexistent-svc-xyz' }, runnerOk);
    expect(r1.ok).toBe(true); // runner 桩零退出——透传 stdout
    const r2 = await sysServiceOp({ action: 'stop', name: 'x' }, runnerFail);
    expect(r2.ok).toBe(false);
    expect(r2.output).toContain('退出码 5');
    const r3 = await sysRegistryOp({ action: 'get', key: 'HKLM\\SOFTWARE\\wxnodus', name: 'A' }, runnerOk);
    expect(r3.ok).toBe(true);
    const r4 = await sysTaskOp({ action: 'run', name: 't' }, runnerFail);
    expect(r4.ok).toBe(false);
  });
  it('参数无效 → 结构化用法说明（不执行）', async () => {
    const { sysRegistryOp } = await import('../src/kernel/sysAdmin.js');
    const r = await sysRegistryOp({ action: 'set', key: 'no-root\\x', name: 'v', value: '1' }, runnerOk);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('注册表根');
  });
});
