// src/commands/registry.ts — L4 命令注册表（单一事实来源）
// 设计：核心命令面（自然语言主线）+ 分类符号 + 全量描述 + 别名表
export const SLASH: string[] = [
  // 对话
  '/help', '/clear', '/undo', '/usage', '/quit', '/sessions', '/resume', '/new', '/title', '/context', '/fork', '/checkpoint', '/versions', '/snapshot', '/script',
  // 模型
  '/key', '/model', '/status', '/doctor', '/version', '/thinking', '/hooks',
  // 记忆（黑洞引擎）
  '/memory', '/hole', '/compact', '/digest', '/curator',
  // 构建（概念编译器）
  '/build', '/deploy', '/forge', '/skill', '/learn', '/gate', '/fdr', '/evidence', '/plan', '/flow', '/import',
  // 安全（合规红线）
  '/perm', '/sandbox', '/compliance', '/consent', '/audit', '/encrypt', '/yolo', '/afk', '/security',
  // 系统
  '/backup', '/export', '/theme', '/lang', '/config', '/logs', '/bench', '/init',
  // 视觉与媒体（可视化 AI 技能）
  '/vision', '/img', '/video', '/render', '/capture', '/input',
  // 网络与集成
  '/claw', '/mcp', '/plugin', '/gateway', '/proxy', '/webhook', '/a2a', '/acp',
  // 协作
  '/swarm', '/duo', '/cron', '/jobs', '/task', '/delegate', '/goal', '/btw',
  // 工具（确定性）
  '/calc', '/hash', '/base64', '/uuid', '/rand', '/json', '/timer', '/sql', '/fs', '/units', '/csv',
  // 上下文工程（P3：repo map / 快照回滚 / 技能热重载）
  '/map', '/rewind', '/reload-skills',
];

export const COMMAND_CAT: Record<string, string> = {
  '/help': '◈', '/clear': '◈', '/undo': '◈', '/usage': '◈', '/quit': '◈', '/sessions': '◈', '/resume': '◈', '/new': '◈', '/title': '◈', '/context': '◈', '/fork': '◈', '/checkpoint': '◈', '/versions': '◈', '/snapshot': '◈', '/script': '◈',
  '/key': '⚙', '/model': '⚙', '/status': '⚙', '/doctor': '⚙', '/version': '⚙', '/thinking': '⚙', '/hooks': '⚙',
  '/memory': '▤', '/hole': '▤', '/compact': '▤', '/digest': '▤', '/curator': '▤',
  '/build': '◆', '/deploy': '◆', '/forge': '◆', '/skill': '◆', '/learn': '◆', '/gate': '◆', '/fdr': '◆', '/evidence': '◆', '/plan': '◆', '/flow': '◆', '/import': '◆',
  '/perm': '🛡', '/sandbox': '🛡', '/compliance': '🛡', '/consent': '🛡', '/audit': '🛡', '/encrypt': '🛡', '/yolo': '🛡', '/afk': '🛡', '/security': '🛡',
  '/backup': '⚙', '/export': '⚙', '/theme': '⚙', '/lang': '⚙', '/config': '⚙', '/logs': '⚙', '/bench': '⚙', '/init': '⚙',
  '/vision': '👁', '/img': '👁', '/video': '👁', '/render': '👁', '/capture': '👁', '/input': '🔐',
  '/claw': '⛭', '/mcp': '⛭', '/plugin': '⛭', '/gateway': '⛭', '/proxy': '⛭', '/webhook': '⛭', '/a2a': '⛭', '/acp': '⛭',
  '/swarm': '◈', '/duo': '◈', '/cron': '◈', '/jobs': '◈', '/task': '◈', '/delegate': '◈', '/goal': '◈', '/btw': '◈',
  '/calc': '☆', '/hash': '☆', '/base64': '☆', '/uuid': '☆', '/rand': '☆', '/json': '☆', '/timer': '☆', '/sql': '☆', '/fs': '☆', '/units': '☆', '/csv': '☆',
  '/map': '◆', '/rewind': '◈', '/reload-skills': '◆',
};

export const COMMAND_DESC: Record<string, string> = {
  '/help': '查看帮助（/help <命令> 展开单个）',
  '/clear': '清空会话视图',
  '/undo': '撤销最近 N 轮（/undo list 查看可撤销轮次）',
  '/versions': '文件时间机器（/versions <文件> 查看历史版本，restore 回滚）',
  '/script': '可执行剧本（record/run/dry-run——会话录制为可重放脚本）',
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
  '/checkpoint': '会话快照（save/list/restore/clear，undo 前自动保存）',
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
  '/digest': '融化吸收外来产物入记忆',
  '/curator': '黑洞策展（即时审查 + 后台自动审查 on/off/interval）',
  '/build': '概念编译：自然语言需求直达可运行系统',
  '/deploy': '业务落地（FDE 五段）',
  '/forge': '组件锻造（MCP Server/Skill 打包）',
  '/skill': '技能管理（/skill list｜inspect｜new；/skill:名 注入）',
  '/learn': '从最近对话学习生成技能（需密钥，AI 生成标注）',
  '/gate': '统一质量门（五门：自测/健康/证据/合规/测试）',
  '/fdr': '部署后保障（五回路）',
  '/evidence': '证据链查看',
  '/perm': '权限模式（smart 确认/auto 自动编辑/goal 循环/plan 计划/yolo 全放）',
  '/sandbox': '分层沙盒（L0-L3）',
  '/compliance': '合规五项',
  '/security': '安全注入通道（sudo/secret，关闭即清缓存）',
  '/consent': '授权存证',
  '/audit': '审计导出',
  '/encrypt': '加密工具',
  '/backup': '备份',
  '/export': '导出',
  '/theme': '主题切换',
  '/lang': '语言切换',
  '/config': '配置中心',
  '/logs': '日志查看',
  '/bench': '基准测试',
  '/map': '仓库地图（aider repo-map 自研版——符号索引注入上下文，/map <预算>）',
  '/rewind': '回滚到最近快照（Claude Code /rewind 同款，等价 /checkpoint restore）',
  '/reload-skills': '重扫技能目录（含跨品牌 .claude/.agents/.codex/.gemini）并汇报',
  '/init': '分析项目生成 AGENTS.md（本地扫描，--overwrite 覆盖）',
  '/vision': 'GLM 视觉理解（/vision <图片>）',
  '/input': '动态内容表（多字段敏感输入——仅内存，不保存）',
  '/img': '图片分析（GLM-4V 多模态）',
  '/video': '视频人工视觉分析（不下载）',
  '/render': 'Markdown 排版预览',
  '/capture': '屏幕截屏（当前界面留证）',
  '/claw': '网页抓取（SSRF 防护）',
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
  '/delegate': '派生子代理',
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

// 别名表（中文自然语言）
const ALIASES: Record<string, string> = {
  '/帮助': '/help', '/退出': '/quit', '/清空': '/clear', '/会话': '/sessions', '/恢复': '/resume',
  '/体检': '/doctor', '/状态': '/status', '/模型': '/model', '/密钥': '/key', '/版本': '/version',
  '/记忆': '/memory', '/黑洞': '/hole', '/压缩': '/compact', '/构建': '/build', '/部署': '/deploy',
  '/锻造': '/forge', '/技能': '/skill', '/权限': '/perm', '/沙盒': '/sandbox', '/合规': '/compliance',
  '/授权': '/consent', '/备份': '/backup', '/导出': '/export', '/主题': '/theme', '/语言': '/lang',
  '/视觉': '/vision', '/图片': '/img', '/视频': '/video', '/抓取': '/claw', '/定时': '/cron',
  '/计算': '/calc', '/哈希': '/hash', '/换算': '/units',
};

export function isSlash(text: string): boolean {
  return /^\/[^\s/]*(?:\s|$)/.test(text);
}

export function resolveAlias(cmd: string): string {
  return ALIASES[cmd] ?? cmd;
}

// 前缀补全（输入 /hel → /help）
export function completeCommand(input: string): string | null {
  const matches = SLASH.filter(c => c.startsWith(input));
  return matches.length === 1 ? matches[0] : null;
}
