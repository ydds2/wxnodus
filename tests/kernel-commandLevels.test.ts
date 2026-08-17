// tests/kernel-commandLevels.test.ts — 命令分级（AI 自主调用通道 wx_cmd 的裁决依据）
import { describe, it, expect } from 'vitest';
import { SLASH } from '../src/commands/registry.js';
import { classifyCommand, COMMAND_LEVELS, COMMAND_LEVEL_LABEL, type CommandLevel } from '../src/kernel/commandLevels.js';

describe('分级表白名单完整性', () => {
  it('SLASH 全量命令均有等级（漏配会保守 confirm，但白名单应完整）', () => {
    for (const cmd of SLASH) {
      expect(COMMAND_LEVELS[cmd], `缺少分级: ${cmd}`).toBeTruthy();
    }
  });
  it('等级取值合法且标签齐全', () => {
    const levels = new Set(Object.values(COMMAND_LEVELS));
    for (const lv of levels) {
      expect(['safe', 'confirm', 'danger', 'redline']).toContain(lv);
      expect(COMMAND_LEVEL_LABEL[lv as CommandLevel]).toBeTruthy();
    }
  });
  it('子命令键存在（/model set-key、/perm rule、/security sudo on 等精确键）', () => {
    for (const key of ['/model set-key', '/model add', '/perm rule', '/security sudo on', '/script run', '/yolo']) {
      expect(COMMAND_LEVELS[key], `缺少子命令分级: ${key}`).toBeTruthy();
    }
  });
});

describe('classifyCommand 分级命中', () => {
  it('safe：只读/查询命令直接执行', () => {
    expect(classifyCommand('/memory')).toBe('safe');
    expect(classifyCommand('/hole 项目结构')).toBe('safe');
    expect(classifyCommand('/status')).toBe('safe');
    expect(classifyCommand('/script ci')).toBe('safe');
    expect(classifyCommand('/calc 1+2')).toBe('safe');
  });
  it('confirm：常规副作用命令', () => {
    expect(classifyCommand('/build 待办系统')).toBe('confirm');
    expect(classifyCommand('/compact')).toBe('confirm');
    expect(classifyCommand('/script record demo')).toBe('confirm');
  });
  it('danger：高危命令', () => {
    expect(classifyCommand('/script run demo')).toBe('danger');
    expect(classifyCommand('/deploy')).toBe('danger');
    expect(classifyCommand('/webhook add')).toBe('danger');
  });
  it('redline：权限/密钥/安全/退出', () => {
    expect(classifyCommand('/yolo on')).toBe('redline');
    expect(classifyCommand('/model set-key sk-xxx')).toBe('redline');
    expect(classifyCommand('/model sk-abc123')).toBe('redline'); // 直接传密钥（不带子命令）
    expect(classifyCommand('/密钥 sk-abc123')).toBe('redline');   // 中文别名 → /model set-key
    expect(classifyCommand('/self-evolve')).toBe('redline');
    expect(classifyCommand('/perm auto')).toBe('redline');
    expect(classifyCommand('/perm rule add fs_write allow')).toBe('redline');
    expect(classifyCommand('/security sudo on')).toBe('redline');
    expect(classifyCommand('/plan on')).toBe('redline');
    expect(classifyCommand('/quit')).toBe('redline');
  });
});

describe('classifyCommand 边界', () => {
  it('子命令最长前缀优先（/model 是 confirm，/model set-key 是 redline）', () => {
    expect(classifyCommand('/model')).toBe('confirm');
    expect(classifyCommand('/model set-key sk-xxx')).toBe('redline');
    expect(classifyCommand('/model add foo --base https://x')).toBe('confirm');
    expect(classifyCommand('/security status')).toBe('safe');
    expect(classifyCommand('/security sudo off')).toBe('confirm');
  });
  it('未命中表项 → 保守 confirm（用户确认后 bus 处理未知命令，无害）', () => {
    expect(classifyCommand('/some-unknown-cmd')).toBe('confirm');
  });
  it('非命令输入 → redline（防任意文本注入执行）', () => {
    expect(classifyCommand('rm -rf /')).toBe('redline');
    expect(classifyCommand('')).toBe('redline');
    expect(classifyCommand('   ')).toBe('redline');
  });
  it('带尾随参数的子命令键仍命中（/perm smart extra → redline）', () => {
    expect(classifyCommand('/perm smart 额外参数')).toBe('redline');
    expect(classifyCommand('/sandbox L2')).toBe('redline');
  });
});

describe('任务系统分级（AI 联动）', () => {
  it('查询类 safe：模型可直接查看任务状态/日志', () => {
    expect(classifyCommand('/jobs list')).toBe('safe');
    expect(classifyCommand('/jobs show t123')).toBe('safe');
    expect(classifyCommand('/jobs logs t123 50')).toBe('safe');
    expect(classifyCommand('/jobs tree t123')).toBe('safe');
    expect(classifyCommand('/jobs')).toBe('safe'); // 无参 = list
  });
  it('调度类 danger：AI 发起任意 shell 后台执行需人工确认', () => {
    expect(classifyCommand('/jobs run npm run build')).toBe('danger');
    expect(classifyCommand('/jobs run node build.js --parallel "node test.js"')).toBe('danger');
    expect(classifyCommand('/jobs kill t123')).toBe('danger');
  });
  it('管理类 confirm：retry/pause/resume/clean 走模式确认链', () => {
    expect(classifyCommand('/jobs retry t123')).toBe('confirm');
    expect(classifyCommand('/jobs clean 50')).toBe('confirm');
    expect(classifyCommand('/cron run 1')).toBe('confirm');
  });
});

describe('/assimilate 同化分级与 NL 触发', () => {
  it('confirm 级：写技能文件走模式确认链（AI 可发起但需确认）', () => {
    expect(classifyCommand('/assimilate ./skills')).toBe('confirm');
    expect(classifyCommand('/assimilate 素材.md --name demo')).toBe('confirm');
  });
  it('中文别名与 NL 触发', async () => {
    const { resolveAlias } = await import('../src/commands/registry.js');
    expect(resolveAlias('/同化')).toBe('/assimilate');
    const { routeNaturalLanguage } = await import('../src/commands/intent.js');
    expect(routeNaturalLanguage('把技能目录同化进来')).toBe('/assimilate');
    expect(routeNaturalLanguage('帮我消化这个技能文档')).toBe('/assimilate');
    expect(routeNaturalLanguage('同化这个文件夹的技能')).toBe('/assimilate');
  });
});
