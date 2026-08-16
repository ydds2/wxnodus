// tests/ui-pet-motion.test.ts — 黑洞宠物/模式徽章纯函数
import { describe, it, expect } from 'vitest';
import { petFace, modeBadgeSpec, permBadgeLabel, welcomeLines } from '../src/wxnodus-ui/components/blackHolePet.js';

describe('宠物/徽章纯函数', () => {
  it('petFace: 三态（idle/busy/error）', () => {
    expect(petFace('idle', 0)).toContain('◉');
    expect(petFace('busy', 0)).toContain('●');
    expect(petFace('error', 0)).toContain('⚠');
  });

  it('petFace: busy 帧随 i 变化（吸积盘旋转），idle 帧二拍循环', () => {
    expect(petFace('busy', 0)).not.toBe(petFace('busy', 1));
    expect(petFace('busy', 0)).toBe(petFace('busy', 4)); // 4 帧循环
    expect(petFace('idle', 0)).toBe(petFace('idle', 2));
    expect(petFace('idle', 0)).not.toBe(petFace('idle', 1));
  });

  it('modeBadgeSpec: Kimi 同款模式语义着色', () => {
    expect(modeBadgeSpec('yolo')).toEqual({ label: 'YOLO', tone: 'error' });
    expect(modeBadgeSpec('auto')).toEqual({ label: 'AUTO', tone: 'good' });
    expect(modeBadgeSpec('manual')).toEqual({ label: 'MANUAL', tone: 'warn' });
    expect(modeBadgeSpec('plan')).toEqual({ label: 'PLAN', tone: 'accent' });
    expect(modeBadgeSpec('goal')).toEqual({ label: 'GOAL', tone: 'warn' });
  });

  it('modeBadgeSpec: 未知模式诚实回退 SMART（不假装高权限）', () => {
    expect(modeBadgeSpec('smart')).toEqual({ label: 'SMART', tone: 'muted' });
    expect(modeBadgeSpec('')).toEqual({ label: 'SMART', tone: 'muted' });
    expect(modeBadgeSpec('garbage')).toEqual({ label: 'SMART', tone: 'muted' });
  });

  it('permBadgeLabel: 括号键帽形式', () => {
    expect(permBadgeLabel('yolo')).toBe('[YOLO]');
    expect(permBadgeLabel('smart')).toBe('[SMART]');
  });

  it('welcomeLines: 帧内容确定性 + 含徽章与吸积盘', () => {
    const l0 = welcomeLines(0, 'manual');
    expect(l0).toEqual(welcomeLines(0, 'manual'));
    expect(l0[0]).toContain('●');
    expect(l0[1]).toContain('[MANUAL]');
    expect(welcomeLines(1, 'manual')[0]).not.toBe(l0[0]); // 帧旋转
  });
});
