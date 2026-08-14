// src/commands/registry.ts — L4 命令注册表（单一事实来源）
// 设计：核心命令面（自然语言主线）+ 分类符号 + 全量描述 + 别名表
import { classifyCommand, COMMAND_LEVEL_ICON, COMMAND_LEVEL_LABEL } from '../kernel/commandLevels.js';

export const SLASH: string[] = [
  // 对话
  '/help', '/clear', '/undo', '/usage', '/quit', '/sessions', '/resume', '/new', '/title', '/context', '/fork', '/checkpoint', '/versions', '/snapshot', '/script', '/self-evolve',
  // 模型
  '/key', '/model', '/status', '/doctor', '/version', '/thinking', '/hooks',
  // 记忆（黑洞引擎）
  '/memory', '/hole', '/compact', '/digest', '/curator',
  // 构建（概念编译器）
  '/build', '/deploy', '/forge', '/skill', '/learn', '/gate', '/fdr', '/evidence', '/plan', '/flow', '/import', '/assimilate',
  // 安全（合规红线）
  '/perm', '/sandbox', '/compliance', '/consent', '/audit', '/encrypt', '/yolo', '/afk', '/security', '/offline',
  // 系统
  '/backup', '/export', '/theme', '/lang', '/config', '/logs', '/bench', '/init', '/voice', '/fortune', '/workspace',
  // 视觉与媒体（可视化 AI 技能）
  '/vision', '/img', '/video', '/render', '/capture', '/input', '/computer',
  // 网络与集成
  '/claw', '/web', '/search', '/browser', '/download', '/mcp', '/plugin', '/gateway', '/proxy', '/webhook', '/a2a', '/acp',
  // 协作
  '/swarm', '/duo', '/cron', '/jobs', '/term', '/task', '/delegate', '/agent', '/arena', '/review', '/understand', '/session-stream', '/goal', '/btw',
  // 工具（确定性）
  '/calc', '/hash', '/base64', '/uuid', '/rand', '/json', '/timer', '/sql', '/fs', '/units', '/csv',
  // 上下文工程（P3：repo map / 快照回滚 / 技能热重载）
  '/map', '/rewind', '/reload-skills',
];

export const COMMAND_CAT: Record<string, string> = {
  // 分类符号全部 BMP 宽字符（无 emoji 代理对）——旧终端字体/winpty 下不产生 � 乱码；
  // 每类唯一符号（/help 分组按符号聚合——此前模型/系统共用 ⚙、对话/协作共用 ◈ 导致组错乱合并）
  '/help': '◈', '/clear': '◈', '/undo': '◈', '/usage': '◈', '/quit': '◈', '/sessions': '◈', '/resume': '◈', '/new': '◈', '/title': '◈', '/context': '◈', '/fork': '◈', '/checkpoint': '◈', '/versions': '◈', '/snapshot': '◈', '/script': '◈', '/self-evolve': '◈',
  '/key': '⚙', '/model': '⚙', '/status': '⚙', '/doctor': '⚙', '/version': '⚙', '/thinking': '⚙', '/hooks': '⚙',
  '/memory': '▤', '/hole': '▤', '/compact': '▤', '/digest': '▤', '/curator': '▤',
  '/build': '◆', '/deploy': '◆', '/forge': '◆', '/skill': '◆', '/learn': '◆', '/gate': '◆', '/fdr': '◆', '/evidence': '◆', '/plan': '◆', '/flow': '◆', '/import': '◆', '/assimilate': '◆',
  '/perm': '⛨', '/sandbox': '⛨', '/compliance': '⛨', '/consent': '⛨', '/audit': '⛨', '/encrypt': '⛨', '/yolo': '⛨', '/afk': '⛨', '/security': '⛨', '/offline': '⬇',
  '/backup': '◉', '/export': '◉', '/theme': '◉', '/lang': '◉', '/config': '◉', '/logs': '◉', '/bench': '◉', '/init': '◉', '/voice': '◉', '/fortune': '◉', '/workspace': '◉',
  '/vision': '❖', '/img': '❖', '/video': '❖', '/render': '❖', '/capture': '❖', '/input': '⚿', '/computer': '⛭',
  '/claw': '⛭', '/web': '⛭', '/search': '⛭', '/browser': '⛭', '/download': '⛭', '/mcp': '⛭', '/plugin': '⛭', '/gateway': '⛭', '/proxy': '⛭', '/webhook': '⛭', '/a2a': '⛭', '/acp': '⛭',
  '/swarm': '◍', '/duo': '◍', '/cron': '◍', '/jobs': '◍', '/term': '◍', '/task': '◍', '/delegate': '◍', '/agent': '◍', '/arena': '◍', '/review': '◍', '/understand': '◍', '/session-stream': '◍', '/goal': '◍', '/btw': '◍',
  '/calc': '☆', '/hash': '☆', '/base64': '☆', '/uuid': '☆', '/rand': '☆', '/json': '☆', '/timer': '☆', '/sql': '☆', '/fs': '☆', '/units': '☆', '/csv': '☆',
  '/map': '⬡', '/rewind': '⬡', '/reload-skills': '⬡',
};

export const COMMAND_DESC: Record<string, string> = {
  '/help': '查看帮助（/help <命令> 展开单个）',
  '/clear': '清空会话视图',
  '/undo': '撤销最近 N 轮（/undo list 查看可撤销轮次）',
  '/versions': '文件时间机器（/versions <文件> 查看历史版本，restore 回滚）',
  '/script': '可执行剧本（record/run/verify/ci/watch——会话录制为可重放脚本+回放CI+自动回归）',
  '/self-evolve': '自举模式（AI 分析自身源码→补丁→自测→报告，不自动提交；--report 只审查不改码）',
  '/snapshot': '目录级快照（建档/整体回滚，/snapshot restore）',
  '/usage': '用量统计（token/成本；--waterfall 瀑布）',
  '/quit': '退出',
  '/new': '新建空会话并切换',
  '/title': '重命名当前会话',
  '/yolo': '完全访问开关（除硬红线全部放行）',
  '/afk': '无人值守自动批准开关',
  '/plan': '计划模式（on/off/save/view/clear）',
  '/flow': 'AI 生成流程图（Mermaid 写入 data/flow/）',
  '/import': '导入消息（JSON 或文本文件回填会话）',
  '/plugin': '插件管理（list/install/remove/enable/disable）',
  '/task': '后台任务浏览器（等价 /jobs）',
  '/sessions': '会话列表（非交互模式输出文本列表）',
  '/resume': '切换会话（真正加载历史并继续）',
  '/context': '上下文占用可视化',
  '/fork': '分支会话（复制当前会话为副本）',
  '/checkpoint': '会话快照（save/list/compare/restore/clear，undo 前自动保存）',
  '/key': '配置/查看模型密钥（加密存储）',
  '/model': '切换模型（打开选择器或 /model <名称>）',
  '/thinking': '推理显示开关（on/off）',
  '/status': '系统状态',
  '/doctor': '健康体检',
  '/version': '版本信息',
  '/hooks': '生命周期 Hooks（settings.hooks 本地命令）',
  '/memory': '记忆概览（三层）',
  '/hole': '黑洞引擎检索（自然语言直达）',
  '/compact': '压缩上下文（有密钥时 LLM 真实总结）',
  '/digest': '摘要最近对话并展示（不写记忆——整理视图）',
  '/curator': '黑洞策展（即时审查 + 后台自动审查 on/off/interval）',
  '/build': '概念编译：自然语言需求直达可运行系统',
  '/deploy': '本地部署：验证→启动服务→探活端口',
  '/assimilate': '黑洞同化（目录 100% 同化技能 / 文件·URL·对话 AI 消化产出融入）',
  '/forge': '组件锻造（MCP Server/Skill 打包）',
  '/skill': '技能管理（/skill list｜inspect｜new；/skill:名 注入）',
  '/learn': '从最近对话学习生成技能（需密钥，AI 生成标注）',
  '/gate': '统一质量门（五门：自测/健康/证据/合规/测试）',
  '/fdr': '生成部署后保障文档（FDR.md，AI 审对话或模板）',
  '/evidence': '证据链查看',
  '/perm': '权限模式（smart 确认/auto 自动编辑/goal 循环/plan 计划/yolo 全放）',
  '/sandbox': '分层沙盒（L0-L3）',
  '/compliance': '合规五项',
  '/security': '安全注入通道（sudo/secret，关闭即清缓存）',
  '/offline': '离线 token 包（本地 LLM：pack status/download + 切换，断网可用）',
  '/consent': '授权存证',
  '/audit': '审计导出',
  '/encrypt': '加密工具',
  '/backup': '备份',
  '/export': '导出',
  '/theme': '主题切换',
  '/lang': '语言切换',
  '/config': '配置中心',
  '/workspace': '主工作区查看/设置（用户动态指定项目文件夹）',
  '/logs': '日志查看',
  '/bench': '基准测试',
  '/map': '仓库地图（aider repo-map 自研版——符号索引注入上下文，/map <预算>）',
  '/rewind': '回滚到最近快照（Claude Code /rewind 同款，等价 /checkpoint restore）',
  '/reload-skills': '重扫技能目录（含跨品牌 .claude/.agents/.codex/.gemini）并汇报',
  '/init': '分析项目生成 AGENTS.md（本地扫描，--overwrite 覆盖）',
  '/voice': '语音模式（TUI 内 Ctrl+B/麦克风钮；status 查看组件）',
  '/fortune': '今日运势（本地确定性）',
  '/vision': 'GLM 视觉理解（/vision <图片>）',
  '/input': '动态内容表（多字段敏感输入——仅内存，不保存）',
  '/img': '图片分析（GLM-4V 多模态）',
  '/video': '视频人工视觉分析（不下载）',
  '/render': 'Markdown 排版预览',
  '/capture': '屏幕截屏（当前界面留证）',
  '/computer': '桌面控制（Computer Use：截图/点击/键入/打开——robotjs 动作层 + GLM-4V 屏幕理解）',
  '/claw': '网页抓取（SSRF 防护）',
  '/web': '抓取网页（/claw 别名）',
  '/search': '联网搜索（DuckDuckGo）',
  '/browser': '浏览器自动化（打开/点击/输入/截图，AI 可自主操作）',
  '/download': '下载文件到主工作区（SSRF 防护 + sha256 证据）',
  '/mcp': 'MCP 服务器管理',
  '/gateway': 'HTTP 网关',
  '/proxy': '代理转发',
  '/webhook': 'Webhook 配置',
  '/a2a': 'A2A 跨 agent 协议',
  '/acp': 'ACP server',
  '/swarm': '同种子代理多开',
  '/duo': '双脑协作',
  '/cron': '定时任务（add/list/del/pause 真实调度）',
  '/jobs': '后台任务中心',
  '/term': '后台终端（PTY 交互会话）',
  '/delegate': '派生子代理',
  '/agent': '自定义 agent（list/run——.wxnodus/agents/*.md 定义）',
  '/arena': '多模型对战（双模型执行同一任务对比选优）',
  '/review': '任务自查（AI 审查视角复查改动，只读不修改）',
  '/session-stream': '会话事件流（list/show——用户消息/工具/压缩/审批可重放时间线）',
  '/understand': '逆向编译（代码→概念规格，与 /build 形成双向编译闭环——竞品无此设计）',
  '/goal': '循环目标执行',
  '/btw': '侧边提问（隔离只读上下文，不打断主对话）',
  '/calc': '计算器（自然语言直达）',
  '/hash': '哈希（md5/sha256）',
  '/base64': 'Base64 编解码',
  '/uuid': '生成 UUID',
  '/rand': '随机数',
  '/json': 'JSON 格式化',
  '/timer': '计时器',
  '/sql': 'SQL 查询（只读）',
  '/fs': '文件操作',
  '/units': '单位换算',
  '/csv': 'CSV 摘要',
};

// 别名表（中文自然语言）与 resolveAlias 已移至 kernel/commandLevels.ts（审查修复：
// registry 依赖 commandLevels，原位置使分级侧无法引用别名——中文命令在 wx_cmd
// AI 通道分级中漏网；本文件 re-export 保持调用方（intent.ts/CommandBus）兼容）
export { ALIASES, resolveAlias } from '../kernel/commandLevels.js';

// A22 指令融合标注：命令 → 合并去向（仅标注，不改变旧命令行为——
// 语义有差异的（/afk 开关、/evidence 验证落盘）保留原命令，/help 与
// command_search 展示合并关系，用户与 AI 都走统一心智模型）
export const COMMAND_MERGE: Record<string, string> = {
  '/task': '/jobs',
  '/vision': '/img',
  '/learn': '/assimilate',
  '/rewind': '/checkpoint restore',
  '/yolo': '/perm yolo',
  '/afk': '/perm yolo（无人值守=完全放行）',
  '/evidence': '/gate + 验证落盘',
  '/web': '/claw',
};

export function isSlash(text: string): boolean {
  return /^\/[^\s/]*(?:\s|$)/.test(text);
}

// ── A22 command_search 数据源：命令目录检索 ─────────────────────────
// 解决核心缺口：96 条 COMMAND_DESC 从不注入模型 → AI 盲调 wx_cmd。
// 模型先 command_search（按关键词/意图检索目录），拿到名称/描述/等级/
// 合并关系后再经 wx_cmd 执行正确命令。等级 = wx_cmd 分级裁决的同一
// 依据（commandLevels.classifyCommand）——AI 可自行判断哪些命令能直接跑。

export interface CommandCatalogHit {
  desc: string
  level: string
  merge?: string
  name: string
}

export function searchCommandCatalog(query: string, limit = 8): CommandCatalogHit[] {
  const q = String(query ?? '').trim().toLowerCase();

  const hits = SLASH
    .map(cmd => {
      const desc = COMMAND_DESC[cmd] ?? '';
      const merge = COMMAND_MERGE[cmd];
      const hay = `${cmd} ${desc} ${merge ?? ''}`.toLowerCase();
      let score = -1;
      if (cmd.startsWith(q)) score = 3;
      else if (cmd.includes(q)) score = 2;
      else if (hay.includes(q)) score = 1;
      if (score < 0) return null;
      return {
        desc,
        level: `${COMMAND_LEVEL_ICON[classifyCommand(cmd)] ?? ''}${COMMAND_LEVEL_LABEL[classifyCommand(cmd)] ?? '确认'}`,
        merge,
        name: cmd,
        score,
      };
    })
    .filter((h): h is NonNullable<typeof h> => h !== null)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);

  if (!q) {
    // 空查询：全目录抽样 + 引导（模型拿不到目录时的兜底入口）
    return SLASH.slice(0, limit).map(cmd => ({
      desc: COMMAND_DESC[cmd] ?? '',
      level: `${COMMAND_LEVEL_ICON[classifyCommand(cmd)] ?? ''}${COMMAND_LEVEL_LABEL[classifyCommand(cmd)] ?? '确认'}`,
      merge: COMMAND_MERGE[cmd],
      name: cmd,
    }));
  }

  return hits;
}

// 前缀补全（输入 /hel → /help）
export function completeCommand(input: string): string | null {
  const matches = SLASH.filter(c => c.startsWith(input));
  return matches.length === 1 ? matches[0] : null;
}
