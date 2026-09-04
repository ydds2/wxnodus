# -*- coding: utf-8 -*-
# 临时：压缩失败护栏 + 循环双模型确认 + 鼠标支持 + 评测扩展（ⅩⅩⅫ——执行后删）
import io

# ═══ 1. memory.ts 压缩失败护栏 ═══
p = 'src/kernel/memory.ts'
s = io.open(p, encoding='utf-8').read()
NL = chr(92) + 'n'

old1 = "  if (summary) {\n    return [...keepHead, { role: 'system', content: `" + chr(0xEFBBBF) + "（自动压缩摘要）" + NL + "${summary.slice(0, summaryCap)}` }, ...keepTail];\n  }"
# 直接用行级匹配替代
lines = s.split('\n')
for i, l in enumerate(lines):
    if 'if (summary) {' in l and i + 1 < len(lines) and 'keepHead' in lines[i+1]:
        # 在 if(summary) 后插入护栏
        indent = '  '
        guard = (
            indent + "  // ⅩⅩⅫ：压缩失败护栏（gemini chatCompressionService:461-469 语义）——\n"
            indent + "  // 压缩后反而更大 → 放弃摘要改确定性降级（白烧 LLM 还把上下文变糟）\n"
            indent + "  const originalTokens = estimateMessagesTokens(mid);\n"
            indent + "  const compressedTokens = estimateMessagesTokens([{ role: 'system', content: summary }]);\n"
            indent + "  if (compressedTokens >= originalTokens * 0.8) {\n"
            indent + "    return compactDeterministic(keepHead, mid, keepTail);\n"
            indent + "  }"
        )
        lines.insert(i + 1, guard)
        break
s = '\n'.join(lines)

# 确定性降级提取
old_det = lines[:]
for i, l in enumerate(old_det):
    if '// LLM 摘要失败：确定性降级' in l:
        # 找到函数闭合（return...;}
        j = i
        while j < len(old_det) and not (old_det[j].startswith('  }') or (old_det[j].strip() == '}' and 'keepTail' in ''.join(old_det[max(0,j-3):j]))):
            j += 1
        # 找 return 行的闭合 }
        end = j + 1
        while end < len(old_det) and not old_det[end].strip() == '}':
            end += 1
        # 替换为函数调用
        old_det[i] = '  return compactDeterministic(keepHead, mid, keepTail);'
        # 清空中间行
        for k in range(i + 1, end):
            old_det[k] = ''
        # 在函数闭合 } 后追加新函数
        if end < len(old_det):
            old_det[end] = '''}

/** ⅩⅩⅫ：确定性降级压缩（LLM 失败/膨胀护栏共用——每轮首行 + 尾 10 条） */
function compactDeterministic(keepHead: MemMsg[], mid: MemMsg[], keepTail: MemMsg[]): MemMsg[] {
  const condensed: MemMsg[] = [];
  let lastRole = '';
  for (const m of mid) {
    if (m.role !== 'tool' && m.role !== lastRole) {
      const firstLine = String(m.content).split('\\n')[0]!.slice(0, 120);
      condensed.push({ role: m.role, content: firstLine });
    }
    lastRole = m.role;
  }
  return [...keepHead, { role: 'system', content: `（压缩省略 ${mid.length} 条中间消息）` }, ...condensed.slice(-10), ...keepTail];'''
        break
s = '\n'.join(old_det)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('memory.ts guard ok')
