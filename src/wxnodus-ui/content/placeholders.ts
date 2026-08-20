import { pick } from '../lib/text.js'

export const PLACEHOLDERS = [
  '自然语言描述需求，交付可运行系统…',
  '示例：「做一个待办系统」',
  '示例：「分析这个代码库」',
  '示例：「为 auth 模块编写测试」',
  '示例：「/help 查看全部命令」',
  '示例：「修复 lint 错误」',
  '示例：「这个配置加载器如何工作？」'
]

export const PLACEHOLDER = pick(PLACEHOLDERS)
