// tests/v4-output-spec-matrix.test.ts — V4 L0-1 输出规范规格层快照矩阵
// 30 格（10 kinds × 3 densities）快照 + 行为断言（outcome 着色/折叠规则/notice 作用域/
// 零正则纪律）。渲染器层 60 格（×明暗主题）由 L0-6 落地——本矩阵是其基准。
import { describe, it, expect } from 'vitest';
import {
  OUTPUT_SPEC_VERSION,
  SPEC_MATRIX_KINDS,
  SPEC_DENSITIES,
  renderEvent,
  collapsePolicy,
  toolOutcomeColor,
  sessionEventColor,
  type OutputEvent,
  type Density,
} from '../src/wxnodus-ui/output/spec.js';

// 每类事件的代表性样例（含结构化字段：outcome/tokens/durationMs/type/scope/exitCode）
const SAMPLES: Record<OutputEvent['kind'], OutputEvent> = {
  user: { kind: 'user', text: '帮我修这个 bug', attachments: ['截图.png'] },
  assistant: { kind: 'assistant', text: '已定位问题……', streaming: true },
  reasoning: { kind: 'reasoning', text: '思考过程……', tokens: 1024 },
  'tool-start': { kind: 'tool-start', name: 'fs_edit', argsSummary: 'src/app.ts' },
  'tool-result': { kind: 'tool-result', name: 'fs_edit', outcome: 'ok', preview: '已替换 1 处', tokens: 120, durationMs: 850 },
  diff: { kind: 'diff', file: 'src/app.ts', body: '@@ -1,2 +1,2 @@\n-old\n+new' },
  command: { kind: 'command', name: 'npm test', output: 'ok', exitCode: 0 },
  notice: { kind: 'notice', level: 'warn', scope: 'core', text: '上下文已用 75%' },
  'turn-summary': { kind: 'turn-summary', turns: 3, tokens: 8400, costUsd: 0.0123, durationMs: 24500 },
  'session-event': { kind: 'session-event', type: 'session.switched', text: '已切换到会话 s2' },
};

describe('V4 L0-1 输出规范 v1：规格层快照矩阵（10 × 3 = 30 格）', () => {
  for (const kind of SPEC_MATRIX_KINDS) {
    for (const density of SPEC_DENSITIES) {
      it(`${kind} @ ${density}`, () => {
        const blocks = renderEvent(SAMPLES[kind]!, density as Density)
        // 快照（稳定：结构化输入 → 确定性输出）
        expect(blocks).toMatchSnapshot()
        // 不变量：每块有颜色语义名与非负缩进
        for (const b of blocks) {
          expect(['accent', 'error', 'warn', 'muted', 'ok', 'text']).toContain(b.color)
          expect(b.indent).toBeGreaterThanOrEqual(0)
        }
      })
    }
  }
})

describe('V4 L0-1 行为断言', () => {
  it('工具 outcome 着色为结构化映射（零内容猜测）', () => {
    expect(toolOutcomeColor('ok')).toBe('muted')
    expect(toolOutcomeColor('failed')).toBe('error')
    expect(toolOutcomeColor('denied')).toBe('warn')
    expect(toolOutcomeColor('timeout')).toBe('warn')
    expect(toolOutcomeColor('cached')).toBe('muted')
    // failed 红色与内容无关——preview 含「成功」字样也不改色
    const failed = renderEvent({ kind: 'tool-result', name: 'bash', outcome: 'failed', preview: '任务成功完成' }, 'cozy')
    expect(failed[0]!.color).toBe('error')
    const ok = renderEvent({ kind: 'tool-result', name: 'bash', outcome: 'ok', preview: '失败：文件不存在' }, 'cozy')
    expect(ok[0]!.color).toBe('muted')
  })

  it('时长徽标密度差异：cozy 无时长，compact/dense 追加', () => {
    const ev: OutputEvent = { kind: 'tool-result', name: 'bash', outcome: 'ok', preview: 'done', durationMs: 1500 }
    expect(renderEvent(ev, 'cozy')[0]!.text).not.toContain('1.5s')
    expect(renderEvent(ev, 'compact')[0]!.text).toContain('1.5s')
    expect(renderEvent(ev, 'dense')[0]!.text).toContain('1.5s')
  })

  it('折叠规则：reasoning 恒折叠；工具结果按行数阈值；command 同族', () => {
    expect(collapsePolicy({ kind: 'reasoning', text: 'x', tokens: 5 }, 'dense')?.collapsed).toBe(true)
    const short: OutputEvent = { kind: 'tool-result', name: 'ls', outcome: 'ok', preview: 'a\nb' }
    expect(collapsePolicy(short, 'cozy')).toBeNull()            // 2 行 ≤3
    expect(collapsePolicy(short, 'compact')?.collapsed).toBe(true) // 2 行 >1
    const long: OutputEvent = { kind: 'command', name: 'npm', output: Array.from({ length: 7 }, (_, i) => `line${i}`).join('\n'), exitCode: 0 }
    expect(collapsePolicy(long, 'cozy')?.badge).toBe('7 行')
  })

  it('notice 作用域：rpc/transient 不产出对话流块（A-26 分流基准）', () => {
    expect(renderEvent({ kind: 'notice', level: 'error', scope: 'rpc', text: 'session.list 失败' }, 'cozy')).toEqual([])
    expect(renderEvent({ kind: 'notice', level: 'error', scope: 'transient', text: 'x' }, 'dense')).toEqual([])
    expect(renderEvent({ kind: 'notice', level: 'error', scope: 'core', text: '模型调用失败' }, 'cozy').length).toBe(1)
  })

  it('session-event 颜色由结构化 type 映射（替代 V3 内容正则）', () => {
    expect(sessionEventColor('session.switched')).toBe('accent')
    expect(sessionEventColor('job.completed')).toBe('ok')
    expect(sessionEventColor('job.failed')).toBe('error')
    expect(sessionEventColor('anything-else')).toBe('muted')
  })

  it('command 非零退出码 → error 色不 dim；零退出 → muted dim', () => {
    const fail = renderEvent({ kind: 'command', name: 'npm', output: 'ERR', exitCode: 1 }, 'cozy')[0]!
    expect(fail.color).toBe('error')
    expect(fail.dim).toBeFalsy()
    const ok = renderEvent({ kind: 'command', name: 'npm', output: 'ok', exitCode: 0 }, 'cozy')[0]!
    expect(ok.color).toBe('muted')
    expect(ok.dim).toBe(true)
  })

  it('dense 档 reasoning 完全不可见（仅 badge 折叠行且 dim）', () => {
    const b = renderEvent({ kind: 'reasoning', text: '长思考', tokens: 2048 }, 'dense')[0]!
    expect(b.kind).toBe('fold')
    expect(b.dim).toBe(true)
    expect(b.text).toContain('2.0k tokens')
  })

  it('规范版本存在且为正整数（版本化变更纪律锚点）', () => {
    expect(OUTPUT_SPEC_VERSION).toBeGreaterThanOrEqual(1)
  })
})

// V4 P3-7：注入开销守卫——每轮固定成本（system prompt + 工具 schema）不超 opencode 7k 档。
import { buildSystemPrompt } from '../src/kernel/systemPrompt.js';
import { coreTools, toolsToOpenAI } from '../src/kernel/tools.js';

describe('V4 P3-7 注入开销守卫', () => {
  it('system prompt + 全量工具 schema ≤ 7000 tokens（opencode 档）——新增工具须压减或按需', () => {
    const rough = (s: string) => { let t = 0; for (const ch of s) t += ch.charCodeAt(0) > 0x7f ? 1 : 0.25; return Math.round(t); };
    const sys = buildSystemPrompt({ mode: 'smart', cwd: process.cwd(), model: 'gpt-4o-mini', sessionId: 'guard', hasImageIn: false, lang: 'zh' } as any);
    const schemas = toolsToOpenAI(coreTools());
    const total = rough(sys) + rough(JSON.stringify(schemas));
    // 7k 档 + 10% 容差（架构演进缓冲）；超限即失败——防止悄悄膨胀回 Claude Code 33k
    expect(total).toBeLessThanOrEqual(7_700);
  });
});
