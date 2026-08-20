import { describe, it, expect } from 'vitest';
import { textSimilarity, segmentScenes } from '../src/kernel/video.js';

describe('video 场景分析', () => {
  it('textSimilarity 相同文本 1 / 不同 0', () => {
    expect(textSimilarity('界面显示待办列表', '界面显示待办列表')).toBe(1);
    expect(textSimilarity('界面显示待办列表', '完全不同的另一场景内容')).toBeLessThan(0.3);
  });
  it('segmentScenes 场景切换检测', () => {
    const notes = [
      { tSec: 0, desc: '打开应用显示启动界面 logo' },
      { tSec: 1, desc: '启动界面显示加载进度' },
      { tSec: 2, desc: '进入主界面显示待办列表' },
      { tSec: 3, desc: '主界面列表滑动操作' },
      { tSec: 4, desc: '点击新建按钮弹出输入框' },
    ];
    const scenes = segmentScenes(notes, 0.25);
    expect(scenes.length).toBeGreaterThan(1);
    expect(scenes[0]!.frames.length).toBeGreaterThanOrEqual(1);
    expect(scenes[scenes.length - 1]!.frames.length).toBeGreaterThanOrEqual(1);
  });
  it('segmentScenes 空输入', () => {
    expect(segmentScenes([])).toEqual([]);
  });
});
