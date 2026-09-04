// tests/docs-links.test.ts — V4 文档集命令对账契约（Q5 重写 2026-09-04，替换 V3 三件套 describe.skip）
// 契约：当前态文档（白名单）中反引号包裹的 /cmd token 必须 ∈ SLASH ∪ 退役豁免表——文档不撒谎。
// 三层豁免（与 scripts/check-docs-links.mjs HISTORICAL 先例同口径）：
//   ① 历史快照文档（日期后缀评估/审计档案）不入对账——档案如实记录当时状态；
//   ② token 口径收窄：仅反引号包裹（`/cmd`）——散文裸提及不抓；
//   ③ 退役命令豁免表：当前态文档合法提及已退役命令（如 README「原 `/key` 已并入 `/model`」）——
//      显式登记去向，豁免表自身即文档。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SLASH } from '../src/commands/registry.js';

const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

/** 当前态对账白名单（V4 文档集——docs/ 日期后缀历史快照不入对账，见 scripts/check-docs-links.mjs HISTORICAL 先例） */
const CURRENT_DOCS = ['README.md', 'docs/user-guide.md'] as const;

/** 退役命令豁免表：当前态文档合法提及的退役命令 → 去向说明 */
const RETIRED: Record<string, string> = {
  '/key': '已并入 /model（/model set-key）',
};

describe('V4 文档集命令对账（反引号 /cmd ∈ SLASH ∪ 退役表）', () => {
  it('README 引用的用户文档存在且非空', () => {
    const guide = read('docs/user-guide.md');
    expect(guide.length, 'docs/user-guide.md').toBeGreaterThan(500);
  });

  it('当前态文档反引号 /cmd 全部真实注册或显式退役', () => {
    const registered = new Set(SLASH);
    const violations: string[] = [];
    for (const f of CURRENT_DOCS) {
      const text = read(f);
      expect(text.length, `${f} 缺失或为空`).toBeGreaterThan(0);
      for (const m of text.matchAll(/`(\/[a-z][a-z0-9-]*)`/gi)) {
        const cmd = m[1]!.toLowerCase();
        if (registered.has(cmd) || RETIRED[cmd]) continue;
        violations.push(`${f}: \`${cmd}\``);
      }
    }
    expect(violations, `文档提到未注册且未豁免的命令:\n${violations.join('\n')}`).toEqual([]);
  });

  it('退役豁免表自身不撒谎（表内命令确实不在注册表——已复活即从表移除）', () => {
    for (const cmd of Object.keys(RETIRED)) {
      expect(SLASH, `${cmd} 已重新注册？请从豁免表移除`).not.toContain(cmd);
    }
  });
});
