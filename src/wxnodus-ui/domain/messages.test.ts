// src/wxnodus-ui/domain/messages.test.ts — 启动历史投影合同（防空 transcript 回归）
import { describe, expect, it } from 'vitest';
import { bareIntro, startupHistory } from './messages.js';
import type { Msg, SessionInfo } from '../types.js';

const info = (): SessionInfo => ({
  model: 'mock',
  profile_name: 'default',
  skills: {},
  tools: {},
});

describe('startupHistory（启动历史投影）', () => {
  it('info 缺失且无历史消息时仍保留 bare intro（品牌面板不消失）', () => {
    const h = startupHistory(null, []);
    expect(h).toEqual([bareIntro()]);
  });

  it('info 缺失但有历史消息 → bare intro + 消息', () => {
    const msg: Msg = { role: 'user', text: '历史问题' };
    const h = startupHistory(null, [msg]);
    expect(h[0]).toEqual(bareIntro());
    expect(h[1]).toEqual(msg);
  });

  it('info 存在 → introMsg(info) 打头（含会话卡数据）', () => {
    const i = info();
    const h = startupHistory(i, []);
    expect(h[0]).toMatchObject({ kind: 'intro', info: i });
  });

  it('纯函数：不修改入参列表', () => {
    const msgs: Msg[] = [];
    const h = startupHistory(info(), msgs);
    expect(msgs).toEqual([]);
    expect(h).toHaveLength(1);
  });
});
