// src/wxnodus-ui/content/features.ts — WxNodus 旗舰能力速览（单一事实来源）
// 用途：intro SessionPanel「特色能力」区（branding.tsx）。cmd 一律为斜杠命令。
export interface FeatureSpotlight {
  cmd: string
  desc: string
  label: string
}

export const FEATURE_SPOTLIGHTS: readonly FeatureSpotlight[] = [
  { label: '概念编译', desc: '自然语言需求直达可运行系统（真实验证 + 质量门）', cmd: '/build 做一个待办系统' },
  { label: '黑洞记忆', desc: '三层记忆 + 混合召回，全量永不删', cmd: '/memory' },
  { label: '语音免提', desc: '本地 whisper 完全离线 + VAD 静音自动停止', cmd: '/voice on' },
  { label: '后台终端', desc: 'node-pty 真实交互会话，与主对话并行', cmd: '/term new' },
  { label: '并行任务', desc: '/jobs 并行双线子任务 + 真实 shell 进程', cmd: '/jobs list' },
  { label: '目标循环', desc: '/goal 循环推进并真实验证完成（不靠自夸）', cmd: '/goal 修复这个项目里的 bug' },
  { label: '仓库地图', desc: 'aider repo-map 自研版，符号索引注入上下文', cmd: '/map' },
  { label: '安全密钥', desc: 'AES-256-GCM 加密存储 + 敏感注入仅内存', cmd: '/security status' },
  { label: '自我进化', desc: 'AI 分析自身源码 → 补丁 → 自测 → 报告', cmd: '/self-evolve --report' },
  { label: '联网搜索', desc: '无 API key 的 DuckDuckGo 搜索（SSRF 防护）', cmd: '/search 今天的新闻' },
]
