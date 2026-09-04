// tests/tui-render.test.tsx — 官方 ink 6 组件冒烟 + 钉底结构验收 + 浮层全家福：
// 首帧三明治要素 / 转录钳制（旧消息不落帧、输入区+参数恒在尾部）/ 上翻标记 / 多行 /
// 模型/主题/确认/配置/表单浮层 / 编排块 / 后台计数 / 错误出路呈现
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/ui/App.js'
import { TuiStore } from '../src/tui/store.js'
import { TuiRuntime } from '../src/tui/runtime.js'
import { setTuiTheme } from '../src/tui/theme.js'
import { glyphs } from '../src/tui/termcap.js'

/** 盒线期望与渲染同源（App 挂载即 initTermcap——full 圆角/basic 直角/ascii +-| 任何档位环境断言一致） */
function boxRegexes() {
  const g = glyphs()
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    top: new RegExp(`^${esc(g.box.tl)}${esc(g.box.h)}+${esc(g.box.tr)}$`),
    bottom: new RegExp(`^${esc(g.box.bl)}${esc(g.box.h)}+${esc(g.box.br)}$`),
    thin: new RegExp(`^${esc(g.box.h)}+$`),
    side: g.box.v,
    prompt: g.prompt,
  }
}

function boot(over: Record<string, unknown> = {}) {
  const store = new TuiStore()
  const runtime = new TuiRuntime({
    store,
    bus: { on: () => () => {} },
    agent: { run: async () => ({ ok: true, text: '', turns: 0 }), abort() {}, steer: () => true },
    commandBus: { execute: async () => ({ ok: true, output: '' }) },
    config: { get: () => ({}) },
    cwd: 'C:/proj',
    gitBranch: () => 'master',
    onRequestExit: () => {},
    ...over,
  } as any)
  runtime.start()
  return { store, runtime }
}

const settle = () => new Promise(r => setTimeout(r, 400))

describe('App 组件冒烟（官方 ink 6）', () => {
  it('首帧含品牌头/输入提示符/状态栏', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('WXNODUS')
    expect(frame).toContain('[smart]')
    app.unmount()
  }, 20_000)

  it('头部状态诚实：命令执行中显示「命令中」（不再显示误导性的空闲）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.patch({ command: { text: '/build 长任务', ms: 0 } })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('命令中')
    expect(frame).not.toContain('空闲')
    store.patch({ command: null })
    await settle()
    expect(app.lastFrame() ?? '').toContain('空闲')
    app.unmount()
  }, 20_000)

  it('品牌化（「独一无二」包装层）：Header 品牌行 + 欢迎语消费 branding 桥', async () => {
    const { store, runtime } = boot({ branding: () => ({ name: '我的助手', icon: '⚡' }) })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('⚡ 我的助手') // 品牌行（icon 短文本渲染）
    expect(frame).not.toContain('WXNODUS')
    expect(frame).toContain('我的助手 就绪') // 欢迎语消费品牌名
    app.unmount()
  }, 20_000)
})

describe('钉底结构验收（用户裁决：输入框和参数固定在 cmd 底部）', () => {
  it('空闲会话：输入框+参数行落在窗口绝对底部（整树恰 = 终端行数）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const frame = app.lastFrame() ?? ''
    const lines = frame.split('\n')
    // 盒线期望从 termcap 单一事实源派生（渲染后取——App 已 initTermcap）
    const box = boxRegexes()
    // 整树高度 = 终端行数（24）——转录区底部填充让位，固定区恒在窗口最后几行
    expect(lines.length).toBe(24)
    // 绝对位置：盒上沿(18) 提示符(19) 盒内键位(20) 盒下沿(21) 参数行(22) 下沿细线(23)
    expect(lines[18]!).toMatch(box.top) // 输入框四周围起来——上沿
    expect(lines[19]!).toContain(box.side) // 输入框侧边
    expect(lines[20]!).toContain('Enter 发送')
    expect(lines[21]!).toMatch(box.bottom) // 输入框下沿
    expect(lines[22]!).toContain('[smart]') // 参数行（恒一行）
    expect(lines[23]!).toMatch(box.thin) // 参数行下沿 = 窗口最后一行
    // 转录区空白填充（内容不足时空白让位——输入框不浮在窗口上部）
    expect(lines[3]!).toContain('WxNodus 就绪')
    expect(lines[4]!.trim()).toBe('')
    app.unmount()
  }, 20_000)

  it('转录超屏：旧消息被钳制（不落帧），输入区+状态栏恒在帧尾', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    for (let i = 0; i < 30; i++) store.push({ kind: 'notice', text: `MARKER-n${String(i).padStart(2, '0')}` })
    await settle()
    const frame = app.lastFrame() ?? ''
    const lines = frame.split('\n').filter(l => l.trim().length > 0)
    // 最旧消息被视口钳制出帧
    expect(frame).not.toContain('MARKER-n00')
    expect(frame).not.toContain('MARKER-n02')
    // 上方隐藏计数（降噪规则 4：精确计数）
    expect(frame).toContain('↑ 上方还有')
    // 最新消息在帧内
    expect(frame).toContain('MARKER-n29')
    // 帧尾 = 键位提示 + 参数行 + 下沿细线（输入区与参数钉底不漂移）
    expect(lines.at(-4)!).toContain('Enter 发送')
    expect(lines.at(-2)!).toContain('[smart]')
    expect(lines.at(-1)!).toMatch(boxRegexes().thin)
    // 钉底不变量：整树行数恰 = 终端行数（24）——窗口最后一行即参数下沿
    expect(frame.split('\n').length).toBe(24)
    app.unmount()
  }, 20_000)

  it('翻页上翻：显示 ↓ 贴底标记，视口回到历史段', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    for (let i = 0; i < 30; i++) store.push({ kind: 'notice', text: `MARKER-n${String(i).padStart(2, '0')}` })
    await settle()
    store.setPinnedLine(0) // 顶锚定：翻到最旧内容
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('MARKER-n00')
    expect(frame).not.toContain('MARKER-n29')
    expect(frame).toContain('↓ 下方')
    // 输入区仍钉底
    const lines = frame.split('\n').filter(l => l.trim().length > 0)
    expect(lines.at(-4)!).toContain('Enter 发送')
    expect(lines.at(-2)!).toContain('[smart]')
    app.unmount()
  }, 20_000)

  it('↑/PgUp/PgDn 键位真实生效：stdin 键事件 → 顶锚定流转（用户反馈回归：输出历史翻不动）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    for (let i = 0; i < 30; i++) store.push({ kind: 'notice', text: `MARKER-n${String(i).padStart(2, '0')}` })
    await settle()
    expect(store.getSnapshot().scroll.pinnedLine).toBeNull()
    app.stdin.write('\x1b[A') // ↑ → 钉住
    await settle()
    const p1 = store.getSnapshot().scroll.pinnedLine
    expect(p1).not.toBeNull() // ↑ 真实生效（键事件到达组件树）
    app.stdin.write('\x1b[5~') // PgUp → 再上移
    await settle()
    expect(store.getSnapshot().scroll.pinnedLine!).toBeLessThan(p1!)
    app.stdin.write('\x1b[6~') // PgDn → 贴底复位
    await settle()
    expect(store.getSnapshot().scroll.pinnedLine).toBeNull()
    app.unmount()
  }, 20_000)

  it('上翻阅读时视口冻结：流式新内容不推走当前视口（↓ 标记计数实时增长）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    for (let i = 0; i < 30; i++) store.push({ kind: 'notice', text: `MARKER-n${String(i).padStart(2, '0')}` })
    await settle()
    store.setPinnedLine(0)
    await settle()
    const before = app.lastFrame() ?? ''
    expect(before).toContain('MARKER-n00')
    // 流式到达 5 条新消息（模拟 agent.token 追加）
    for (let i = 30; i < 35; i++) store.push({ kind: 'notice', text: `MARKER-n${String(i).padStart(2, '0')}` })
    await settle()
    const after = app.lastFrame() ?? ''
    expect(after).toContain('MARKER-n00') // 视口冻结——正在读的历史未被推走
    expect(after).not.toContain('MARKER-n34') // 新内容未抢占视口
    expect(after).toContain('↓ 下方') // 只计入贴底标记计数
    // 恢复贴底跟随：新内容即时可见
    store.scrollToBottom()
    await settle()
    const back = app.lastFrame() ?? ''
    expect(back).toContain('MARKER-n34')
    app.unmount()
  }, 20_000)

  it('命令执行心跳：◈ 执行 行（长命令可见——不再一片死寂）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.patch({ command: { text: '/build 做个待办系统', ms: 4200 } })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('◈ 执行 /build 做个待办系统')
    expect(frame).toContain('4s')
    expect(frame.split('\n').length).toBe(24) // 心跳行计入预算——仍钉底
    app.unmount()
  }, 20_000)

  it('多行输入超 8 行：盒内折叠计数（+N 行 · Enter 提交全文）· 仍钉底', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const many = Array.from({ length: 12 }, (_, i) => `第${i}行内容`.padEnd(40, 'x')).join('\n')
    store.setComposerValue(many)
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('+4 行')
    expect(frame).toContain('Enter 提交全文')
    expect(frame.split('\n').length).toBe(24) // 折叠行计入预算——仍钉底
    app.unmount()
  }, 20_000)

  it('多行粘贴：回车与上一输入 <40ms 视为粘贴换行（Windows 粘贴多行代码不误提交）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    app.stdin.write('第一行')
    app.stdin.write('\r') // 紧随的 \r（粘贴换行）→ 不提交
    app.stdin.write('第二行')
    await settle()
    const v = store.getSnapshot().composer.value
    expect(v).toBe('第一行\n第二行') // 成为多行输入而非提交
    expect(store.getSnapshot().entries.filter(e => e.kind === 'user')).toHaveLength(0)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('第一行')
    expect(frame).toContain('第二行')
    // 真实回车（间隔 >40ms）仍提交
    await settle()
    app.stdin.write('\r')
    await settle()
    expect(store.getSnapshot().entries.filter(e => e.kind === 'user').map(u => u.text)).toEqual(['第一行\n第二行'])
    app.unmount()
  }, 20_000)

  it('粘贴整块（单 chunk 含 \\r）：归一为多行——盒内无回车覆写乱屏', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    app.stdin.write('第一块\r第二块') // ConPTY 粘贴实态：整块单事件送达（\r 内嵌 input）
    await settle()
    const v = store.getSnapshot().composer.value
    expect(v).toBe('第一块\n第二块')
    expect(v.includes('\r')).toBe(false) // \r 已归一为 \n（否则盒内回车覆写乱屏）
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('第一块')
    expect(frame).toContain('第二块')
    app.unmount()
  }, 20_000)

  it('窄终端（40 列）：队列/菜单行硬截断不折行——钉底不漂移', async () => {
    const origCols = process.stdout.columns
    const origRows = process.stdout.rows
    ;(process.stdout as any).columns = 40
    ;(process.stdout as any).rows = 24
    try {
      const { store, runtime } = boot()
      store.patch({ queue: ['排队的消息'] })
      const app = render(React.createElement(App, { store, runtime }))
      await settle()
      store.setComposerValue('/') // 斜杠菜单（8 行窗口）
      await settle()
      const frame = app.lastFrame() ?? ''
      expect(frame).toContain('已排队 1 条')
      expect(frame).toContain('/help')
      expect(frame.split('\n').length).toBe(24) // 钉底不变量（40 列窄终端）
      app.unmount()
    } finally {
      ;(process.stdout as any).columns = origCols
      ;(process.stdout as any).rows = origRows
    }
  }, 20_000)

  it('Ctrl+L 清屏：转录清空 + 提示（会话保留——kimi/codex 同款）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.push({ kind: 'assistant', text: '历史输出' })
    await settle()
    expect(app.lastFrame() ?? '').toContain('历史输出')
    app.stdin.write('\x0c') // Ctrl+L
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).not.toContain('历史输出')
    expect(frame).toContain('已清屏')
    app.unmount()
  }, 20_000)

  it('多行输入（Shift+Enter 语义）：输入区行数增长，仍钉底', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.setComposerValue('第一行\n第二行')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('第一行')
    expect(frame).toContain('第二行')
    const lines = frame.split('\n').filter(l => l.trim().length > 0)
    expect(lines.at(-4)!).toContain('Enter 发送')
    expect(lines.at(-2)!).toContain('[smart]')
    app.unmount()
  }, 20_000)
})

describe('编排/后台/主题面板（原型 23/13/31）', () => {
  it('子代理编排块：状态点 + 目标 + 终态原位一行（无卡片框）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.push({ kind: 'agents', agents: [
      { id: 's1', goal: '架构审查', phase: 'done', turns: 5 },
      { id: 's2', goal: '测试覆盖', phase: 'run' },
      { id: 's3', goal: '依赖审计', phase: 'fail' },
    ] })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('架构审查')
    expect(frame).toContain('完成 · 5 turns')
    expect(frame).toContain('测试覆盖')
    expect(frame).toContain('运行中')
    expect(frame).toContain('依赖审计')
    expect(frame).toContain('失败')
    app.unmount()
  }, 20_000)

  it('后台任务计数常驻参数行（原型 13 ▣）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.setTask('j1', { kind: 'bash', goal: 'npm test' })
    store.setTask('j2', { kind: 'agent', goal: '文案' })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('▣ 后台 2')
    store.setTask('j1', null)
    await settle()
    expect(app.lastFrame() ?? '').toContain('▣ 后台 1')
    app.unmount()
  }, 20_000)

  it('裸 /theme → 主题选择器（实时预览 + 当前档标记）；Enter 应用改即存', async () => {
    const saved: string[] = []
    const { store, runtime } = boot({ setSetting: (k: string, v: string) => { saved.push(`${k}=${v}`) } })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    void runtime.submit('/theme')
    await settle()
    let frame = app.lastFrame() ?? ''
    expect(frame).toContain('◆ 主题')
    expect(frame).toContain('深空（默认）')
    expect(frame).toContain('晨昏')
    expect(frame).toContain('高对比')
    expect(frame).toContain('纯单色')
    expect(frame).toContain('● 当前')
    expect(frame).toContain('示例输入') // 预览区
    runtime.selectTheme('contrast')
    await settle()
    frame = app.lastFrame() ?? ''
    expect(frame).not.toContain('实时预览') // 面板关闭（标题行不再出现）
    expect(frame).toContain('Enter 发送') // 输入区回归（决断必回主——原型 56 联动规则）
    expect(frame).toContain('◆ 主题：contrast') // 改即存反馈通知
    expect(saved).toEqual(['tuiTheme=contrast'])
    setTuiTheme('deepspace') // 复原全局
    app.unmount()
  }, 20_000)
})

describe('确认/配置/表单/错误呈现（原型 46/59/58/12）', () => {
  it('二次确认浮层：危险橙色 + 默认否（敏感项防手滑）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    void runtime.requestConfirm('切换模式 → yolo：跳过审批', { danger: true })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('切换模式 → yolo')
    expect(frame).toContain('否（默认）')
    expect(frame).toContain('防手滑')
    expect(frame).not.toContain('Enter 发送') // 面板替换输入区
    app.unmount()
  }, 20_000)

  it('配置面板（原型 59）：三控件行 + 改即存提示', async () => {
    const { store, runtime } = boot({ config: { get: () => ({ mode: 'smart', model: 'deepseek-chat', thinking: true, lang: 'zh-CN' }) } })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    void runtime.submit('/config')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('◆ 配置')
    expect(frame).toContain('thinking 思维链')
    expect(frame).toContain('mode 权限档')
    expect(frame).toContain('lang 语言')
    expect(frame).toContain('theme 主题')
    expect(frame).toContain('contextLimit 上下文') // G9 数字控件行
    expect(frame).toContain('↑↓ 步进 8k')
    expect(frame).toContain('改即存')
    expect(frame).not.toContain('Enter 发送')
    app.unmount()
  }, 20_000)

  it('自定义接口表单（原型 58 完整版）：三字段 + 掩码 + 连接测试三态入口', async () => {
    const { store, runtime } = boot({
      probeEndpoint: async () => ({ ok: true, models: ['a', 'b'] }),
    })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    runtime.openModelForm()
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('添加自定义接口')
    expect(frame).toContain('接口名称')
    expect(frame).toContain('Base URL')
    expect(frame).toContain('API Key')
    expect(frame).toContain('Ctrl+T 测试连接')
    expect(frame).toContain('◯ 未测试')
    expect(frame).toContain('SSRF 三层防护')
    expect(frame).toContain('无半保存态')
    app.unmount()
  }, 20_000)

  it('错误行带分类出路（原型 12 结构化呈现——一行错误 + 一行出路）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.push({ kind: 'error', text: 'MODEL_TIMEOUT 上游无响应', errorHint: 'Ctrl+↑ 召回原话重发 · /model 换模型 · /offline on 转离线（会话记忆不丢）' })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('MODEL_TIMEOUT')
    expect(frame).toContain('出路：')
    expect(frame).toContain('/offline on')
    app.unmount()
  }, 20_000)
})

describe('上下文水位与全景索引（原型 26/32/53）', () => {
  it('水位紧凑档：ctx 百分比常驻参数行 + tip 让位（kimi 降级链——参数行永不加高）', async () => {
    const { store, runtime } = boot({ contextUsage: () => ({ used: 21400, limit: 64000 }) })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('ctx 33%')
    expect(frame).not.toContain('↑↓ 滚动') // tip 让位（窄终端 + 水位存在）
    app.unmount()
  }, 20_000)

  it('阈值 0.85：百分比如实上涨（85%+——原型 32 水印变紫的数据侧）', async () => {
    const { store, runtime } = boot({ contextUsage: () => ({ used: 60000, limit: 64000 }) })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('ctx 94%')
    app.unmount()
  }, 20_000)

  it('帮助双页：打开即全景索引，Tab 切快捷分组页（分组 + 全量计数 + 无孤儿）', async () => {
    const index = [
      { cmd: '/help', desc: '查看帮助', cat: '◈' },
      { cmd: '/model', desc: '模型目录', cat: '⚙' },
      { cmd: '/calc', desc: '计算器', cat: '☆' },
    ]
    const { store, runtime } = boot({ commandIndex: () => index })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    runtime.toggleHelp()
    await settle()
    // 页序（2026-09-03 用户裁决）：打开即全景索引——全部命令第一眼可见
    let frame = app.lastFrame() ?? ''
    expect(frame).toContain('命令全景索引（全量 3')
    expect(frame).toContain('Tab 快捷分组')
    expect(frame).toContain('◆ 对话')
    expect(frame).toContain('/calc')
    expect(frame).toContain('计算器')
    app.stdin.write('\t') // Tab 切第 2 页：快捷分组
    await settle()
    frame = app.lastFrame() ?? ''
    expect(frame).toContain('命令手册（快捷分组）')
    expect(frame).toContain('Tab 联动图谱') // 三页制：Tab×2 到图谱页
    app.unmount()
  }, 20_000)
})

describe('附件/速查/图谱（原型 33 部分/30/56 部分）', () => {
  it('附件引用行：@img 提及 → 输入区附件行（图片守卫提示）+ 仍钉底', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.setComposerValue('看看 @img/error.png 这个报错')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('▣ 附件 1')
    expect(frame).toContain('img/error.png')
    expect(frame).toContain('图片守卫自动文本化')
    const lines = frame.split('\n').filter(l => l.trim().length > 0)
    expect(lines.at(-4)!).toContain('Enter 发送') // 附件行计入预算——仍钉底
    app.unmount()
  }, 20_000)

  it('/keys 速查面板：全局/输入区/退出保护分区（单一事实来源）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    void runtime.submit('/keys')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('快捷键速查')
    expect(frame).toContain('◆ 全局')
    expect(frame).toContain('◆ 输入区')
    expect(frame).toContain('◆ 对话中')
    expect(frame).toContain('Ctrl+S')
    expect(frame).toContain('零承诺漂移')
    expect(frame).not.toContain('Enter 发送') // 面板替换输入区
    app.unmount()
  }, 20_000)

  it('帮助第三页：命令联动图谱（原型 56 状态机 7 主链）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    runtime.toggleHelp()
    await settle()
    app.stdin.write('\t') // → 快捷分组
    await settle()
    app.stdin.write('\t') // → 联动图谱
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('命令联动图谱')
    expect(frame).toContain('7 主链')
    expect(frame).toContain('/model')
    expect(frame).toContain('单面板原则')
    expect(frame).toContain('Tab 返回全景')
    app.unmount()
  }, 20_000)

  it('帮助面板 Enter 不再吞面板（仅 Esc 关闭——提示文案如实，防误触关闭陷阱）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    runtime.toggleHelp()
    await settle()
    app.stdin.write('\r') // Enter：不关闭
    await settle()
    let frame = app.lastFrame() ?? ''
    expect(frame).toContain('命令全景索引')
    app.stdin.write('\x1b') // Esc：关闭
    await settle()
    frame = app.lastFrame() ?? ''
    expect(frame).not.toContain('命令全景索引')
    app.unmount()
  }, 20_000)
})

describe('重连进度心跳（原型 12 · G2 部分）', () => {
  it('运行中 + retry 挂起 → 心跳行显示「重连上游 第 1/3 次」', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.patch({ running: true, retry: { attempt: 1, max: 3, delayMs: 800, at: Date.now() } })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('重连上游')
    expect(frame).toContain('第 1/3 次')
    store.patch({ running: false, retry: null })
    app.unmount()
  }, 20_000)
})

describe('压缩三选（原型 32 · G10）', () => {
  it('上下文超阈值 → 三选面板（水印条 + micro 推荐 + 超时回退提示）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    void runtime.requestCompactChoice({ used: 55_000, ctxLimit: 64_000, compactAt: 0.85 })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('已过阈值')
    expect(frame).toContain('micro 压缩（推荐）')
    expect(frame).toContain('全量压缩')
    expect(frame).toContain('不压缩（继续）')
    expect(frame).toContain('30s 超时按默认行为')
    expect(frame).not.toContain('Enter 发送') // 回合暂停——面板替换输入区
    app.unmount()
  }, 20_000)
})

describe('回滚时间线（原型 28 · G11 销项）', () => {
  it('面板：user 消息时间线 + 影响统计先行 + 双路说明', async () => {
    const { store, runtime } = boot({
      sessionMessages: () => [
        { runNo: 3, ts: Date.now(), preview: '补一个导出功能' },
        { runNo: 2, ts: Date.now() - 1000, preview: '改用 sqlite 存储' },
        { runNo: 1, ts: Date.now() - 2000, preview: '定义待办系统规格' },
      ],
    })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    runtime.openRewindPanel()
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('回滚时间线')
    expect(frame).toContain('补一个导出功能')
    expect(frame).toContain('改用 sqlite 存储')
    expect(frame).toContain('定义待办系统规格')
    expect(frame).toContain('回滚将丢弃其后')
    expect(frame).toContain('对话软归档')
    expect(frame).not.toContain('Enter 发送') // 面板替换输入区
    app.unmount()
  }, 20_000)

  it('空会话：诚实空态（/undo fs 仍可用）', async () => {
    const { store, runtime } = boot({ sessionMessages: () => [] })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    runtime.openRewindPanel()
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('暂无用户消息可列')
    expect(frame).toContain('/undo fs')
    app.unmount()
  }, 20_000)
})

describe('计划提案面板（原型 06 · G1 销项）', () => {
  it('紫罗兰计划卡：三动作 + 零工具闸声明', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    void runtime.requestPlanApproval('1 盘点\n2 设计\n3 迁移\n4 收尾')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('执行计划')
    expect(frame).toContain('批准并执行')
    expect(frame).toContain('E 编辑计划')
    expect(frame).toContain('Esc 返回')
    expect(frame).toContain('零工具闸')
    expect(frame).toContain('1 盘点')
    expect(frame).not.toContain('Enter 发送') // 面板替换输入区
    app.unmount()
  }, 20_000)

  it('计划编辑面板：草稿预填原计划（直接 Enter = 按原计划执行——此前空草稿会取消计划）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const planText = '第一步：创建项目骨架\n第二步：安装依赖\n第三步：验证启动'
    const p = new Promise<string | null>(res => {
      store.patch({ overlay: { kind: 'planedit', pending: { id: 1, text: planText, resolve: res } } })
    })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('第一步：创建项目骨架') // 预填可见
    expect(frame).toContain('已预填原计划')
    app.stdin.write('\r') // 未修改直接 Enter → resolve 预填全文（编辑语义）
    await settle()
    await expect(p).resolves.toBe(planText)
    app.unmount()
  }, 20_000)
})

describe('语音面板（原型 34 · G6 部分销项）', () => {
  it('录音态：计时 + 波形 + 本地采集说明 + 免打扰提示', async () => {
    const { store, runtime } = boot({
      voice: {
        available: () => true,
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true, text: '你好' }),
        cancel: () => {},
        speak: () => true,
      },
    })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.patch({ voice: { state: 'recording', seconds: 12 }, overlay: { kind: 'voice' } })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('录音中 00:12')
    expect(frame).toContain('Enter 停止并转写')
    expect(frame).toContain('Esc 取消')
    expect(frame).toContain('绝不云端')
    expect(frame).toContain('免打扰')
    expect(frame).not.toContain('Enter 发送') // 面板替换输入区
    app.unmount()
  }, 20_000)
})

describe('斜杠菜单 Enter 语义（防双回车陷阱——真机回归根因）', () => {
  it('单次 Enter 即提交（未用 ↑↓ 导航时 Enter 不吃掉——面板打开）', async () => {
    const { store, runtime } = boot({
      modelCatalog: () => [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek' },
      ],
      config: { get: () => ({ mode: 'smart', model: 'deepseek-chat' }) },
    })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    app.stdin.write('/model') // 键入（与回车分步——模拟终端事件时序）
    await settle()
    app.stdin.write('\r') // 单次 Enter
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('◆ 模型') // 面板直接打开——Enter 未被菜单补全吃掉
    expect(frame).not.toContain(boxRegexes().prompt + ' /model') // 输入框已清空
    app.unmount()
  }, 20_000)

  it('↑↓ 导航后 Enter 才应用选中项（菜单补全仍可用）', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    app.stdin.write('/m') // 过滤出多个匹配
    await settle()
    app.stdin.write('\x1b[A') // ↑ 导航（选中最后一个匹配）
    await settle()
    app.stdin.write('\r') // Enter 应用选中项
    await settle()
    const value = store.getSnapshot().composer.value
    expect(value.startsWith('/')).toBe(true)
    expect(value).not.toBe('/m') // 被菜单选中项替换
    app.unmount()
  }, 20_000)
})

describe('底部瘦身（用户反馈：运行态底部不冗余）', () => {
  it('运行中：占位符独带键位（不重复键位行）· 参数行无 tip 无「回合运行中」文本 · 仍 24 行钉底', async () => {
    const { store, runtime } = boot({ contextUsage: () => ({ used: 31000, limit: 64000 }) })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    store.patch({ running: true, retry: null })
    await settle()
    const frame = app.lastFrame() ?? ''
    // 键位只出现一次（占位符内）——无独立键位行
    expect(frame).toContain('Prrrrr... Enter 排队 · Ctrl+S 即时注入 · Esc 中断')
    expect(frame).not.toContain('Shift+Enter 换行') // 空闲键位行不渲染
    // 参数行瘦身：无 tip 轮换、无「回合运行中」重复文本（● 已表达）
    expect(frame).not.toContain('↑↓ 滚动')
    expect(frame).not.toContain('回合运行中')
    expect(frame).toContain('●')
    expect(frame).toContain('ctx 48%') // 水位条保留（窄终端紧凑档）
    // 钉底不变
    expect(frame.split('\n').length).toBe(24)
    app.unmount()
  }, 20_000)
})

describe('模型选择器（原型 08）', () => {
  it('裸 /model → 选择器浮层（替换输入区）· 目录行 + 当前档标记', async () => {
    const { store, runtime } = boot({
      modelCatalog: () => [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek' },
        { id: 'glm-4-flash', name: 'GLM-4 Flash', provider: 'zhipu' },
      ],
      config: { get: () => ({ mode: 'smart', model: 'deepseek-chat' }) },
    })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    void runtime.submit('/model')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('◆ 模型')
    expect(frame).toContain('deepseek-chat')
    expect(frame).toContain('● 当前')
    expect(frame).toContain('glm-4-flash')
    expect(frame).not.toContain('Enter 发送') // 面板替换输入区（覆盖即输入面）
    app.unmount()
  }, 20_000)

  it('目录缺失：裸 /model 诚实走命令面文本模式（不假装弹出空选择器）', async () => {
    const { store, runtime } = boot({
      commandBus: { execute: async () => ({ ok: true, output: '文本模式：/model <关键词> 模糊搜索切换' }) },
    })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    void runtime.submit('/model')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('文本模式')
    expect(frame).not.toContain('◆ 模型')
    app.unmount()
  }, 20_000)
})
