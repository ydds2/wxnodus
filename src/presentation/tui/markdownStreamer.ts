// src/presentation/tui/markdownStreamer.ts — 流式 Markdown 增量提交（kimi code 风格化，2026-08-28）
// 机制参考：kimi-cli ui/shell/visualize/_blocks.py:_ContentBlock（「已确认块立即落盘、未确认尾部留在
// 暂存区」的增量承诺）+ _find_committed_boundary（markdown-it 顶层块边界）——实现原创：
//   - 不用 markdown-it：行状态机判定块边界（段落/代码围栏/标题/分隔线/列表/表格/引用），
//     语义对齐「只提交完整块」：代码围栏必须闭合才提交、标题与分隔线自闭合即提交、
//     段落以空行收口、列表/表格以块结束收口；
//   - 块边界只在新行处判定（流中半行绝不拆断——kimi「Block boundaries require newlines」同语义）；
//   - 纯函数式小类：零终端副作用，返回待打印块数组，可单测。
export type BlockKind = 'paragraph' | 'fence' | 'list' | 'table' | 'quote';

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const HR = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const QUOTE = /^\s*>\s?/;

interface State {
  kind: BlockKind;
  /** 围栏打开时的标记（``` 或 ~~~，可带语言后缀） */
  fenceMarker: string | null;
  lines: string[];
}

const paragraph = (): State => ({ kind: 'paragraph', fenceMarker: null, lines: [] });

export class MarkdownStreamer {
  private state: State = paragraph();
  /** 流中未到行尾的残段（半行不判定边界） */
  private tail = '';

  /** 追加流式文本；返回已确认可落盘的完整块（可能为空数组） */
  append(text: string): string[] {
    const committed: string[] = [];
    this.tail += text.replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = this.tail.indexOf('\n')) >= 0) {
      const line = this.tail.slice(0, idx + 1);
      this.tail = this.tail.slice(idx + 1);
      const flushed = this.feed(line);
      if (flushed) committed.push(flushed);
    }
    return committed;
  }

  /** 流结束：冲刷剩余未提交内容（未闭合围栏如实按现状提交） */
  flush(): string[] {
    const committed: string[] = [];
    if (this.tail.length > 0) {
      const flushed = this.feed(this.tail + '\n');
      if (flushed) committed.push(flushed);
      this.tail = '';
    }
    if (this.state.lines.length > 0) {
      committed.push(this.state.lines.join(''));
      this.state = paragraph();
    }
    return committed;
  }

  /** 单行分类与块收口 */
  private feed(line: string): string | null {
    if (this.state.kind === 'fence') {
      // 围栏内：闭合行（标记一致且仅含空白后缀）→ 提交整块
      const close = this.state.fenceMarker ?? '```';
      if (line.trim() === close || (close.length >= 3 && line.trim() === close.slice(0, 3))) {
        this.state.lines.push(line);
        const block = this.state.lines.join('');
        this.state = paragraph();
        return block;
      }
      this.state.lines.push(line);
      return null;
    }

    if (line.trim() === '') {
      // 空行：当前块收口（段落/列表/表格/引用皆然；空行随块提交保留间距）
      if (this.state.lines.length > 0) {
        const block = this.state.lines.join('') + '\n';
        this.state = paragraph();
        return block;
      }
      this.state = paragraph();
      return null;
    }

    // 当前块延续（列表/表格/引用的同类行与缩进续行）
    if (this.state.kind !== 'paragraph' && this.continues(line)) {
      this.state.lines.push(line);
      return null;
    }

    // 新行分类：只有真正的块起始行才切换块；普通文本一律并入段落（段落续行是兜底）
    const nextKind = this.classifyStart(line);
    if (nextKind === null) {
      if (this.state.kind !== 'paragraph' && this.state.lines.length > 0) {
        // 上一块（列表/表格/引用）被普通文本行打断 → 提交旧块、开始新段落
        const flushed = this.state.lines.join('');
        this.state = paragraph();
        this.state.lines.push(line);
        return flushed;
      }
      this.state.lines.push(line);
      return null;
    }

    let flushed: string | null = null;
    if (this.state.lines.length > 0) {
      flushed = this.state.lines.join('');
      this.state = paragraph();
    }

    if (nextKind === 'heading') {
      // 标题/分隔线自闭合单行块：立即提交
      return flushed ? flushed + line : line;
    }
    this.state = { kind: nextKind, fenceMarker: nextKind === 'fence' ? line.trim() : null, lines: [line] };
    return flushed;
  }

  /** 块起始行分类（无匹配 → null=普通段落行） */
  private classifyStart(line: string): Exclude<BlockKind, 'paragraph'> | 'heading' | null {
    if (FENCE_OPEN.test(line)) return 'fence';
    if (HEADING.test(line) || HR.test(line)) return 'heading';
    if (LIST_ITEM.test(line)) return 'list';
    if (TABLE_ROW.test(line)) return 'table';
    if (QUOTE.test(line)) return 'quote';
    return null;
  }

  /** 当前块是否延续该行 */
  private continues(line: string): boolean {
    switch (this.state.kind) {
      case 'list': return LIST_ITEM.test(line) || /^\s{2,}\S/.test(line); // 缩进续行属于列表项
      case 'table': return TABLE_ROW.test(line);
      case 'quote': return QUOTE.test(line);
      default: return false;
    }
  }
}
