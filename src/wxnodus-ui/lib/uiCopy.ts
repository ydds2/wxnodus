// src/wxnodus-ui/lib/uiCopy.ts — 阶段 3：产品自有固定文案单一事实源（中文优先）
// 命令名、路径、工具输出和用户内容保持原始数据，不盲目翻译——这里只管产品 chrome 文案。
// 分区标题与状态文案统一从这取，避免各组件各写一套。

import type { EvidenceStatus } from '../runtime/evidenceModel.js'

/** 回合分区标题（计划/活动/修改/验证/证据——参考同类型 CLI 的轮次结构化展示）。 */
export const SECTION_TITLES = {
  plan: '计划',
  activity: '活动',
  changes: '修改',
  verification: '验证',
  evidence: '证据'
} as const

/** 证据状态 → 中文标签（与证据状态机一一对应，缺一不可）。 */
export const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  'not-started': '未开始',
  pending: '待验证',
  running: '验证中',
  verified: '已验证',
  failed: '验证失败',
  interrupted: '已中断',
  unavailable: '不可用',
  unknown: '未知'
}

/** 分区空态/诚实态文案。 */
export const SECTION_EMPTY = {
  /** 验证区：没有任何真实验证事件时——诚实 pending，绝不假装验证过 */
  noVerificationEvents: '等待真实验证事件',
  /** 证据区：无证据项时 */
  noEvidence: '暂无证据项',
  /** 修改区：无 diff 段时（整个分区不渲染，此文案仅作兜底） */
  noChanges: '暂无文件变更'
} as const

/** 活动区工具子状态文案（数据来自 turnState.tools/doneTools 结构化记录）。 */
export const ACTIVITY_LABELS = {
  running: '运行中',
  progress: '输出中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消'
} as const
