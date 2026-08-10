import { pick } from '../lib/text.js'

export const PLACEHOLDERS = [
  '说一句话，交付可运行系统…',
  '试试「做一个待办系统」',
  '试试「分析这个代码库」',
  '试试「为 auth 模块写测试」',
  '试试「/help 查看全部命令」',
  '试试「修复 lint 错误」',
  '试试「这个配置加载器怎么工作的？」'
]

export const PLACEHOLDER = pick(PLACEHOLDERS)
