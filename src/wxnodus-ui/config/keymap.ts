// src/wxnodus-ui/config/keymap.ts — 键位配置层（supremacy 3.3 / 缺陷 B-01 落地，2026-08-18）
// 机制参考：codex keymap 配置（键位可配而非写死）——实现原创。
// 设计：命名动作 → 键位规范（KeySpec）映射；settings.keymap JSON 覆盖默认表（EFF 模式：
// 默认值=既有行为零漂移；非法动作名/非法键位规范一律忽略并回退默认——绝不因误配崩 UI）。
// 诚实口径：wxnodus 不做「伪 vim」——全模态 vim 编辑不宣称；本层提供 codex 式自定义键位
// （pager 导航/关闭等既有 vim 风格键位已可配），模态编辑能力如接入再如实标注。
export interface KeySpec {
  key: string;           // 特殊键名（enter/escape/tab/up/down/left/right/backspace/delete/home/end）或单字符
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/** 可配置动作（当前消费面：pager 关闭/导航——后续动作扩展同表） */
export interface Keymap {
  /** pager 翻页器关闭（默认 escape / ctrl+c / q） */
  pagerClose: KeySpec[];
  /** pager 上/下行（默认 ↑/k 与 ↓/j） */
  pagerUp: KeySpec[];
  pagerDown: KeySpec[];
  /** pager 半页（默认 PageUp/b / PageDown/空格） */
  pagerHalfUp: KeySpec[];
  pagerHalfDown: KeySpec[];
  /** pager 首/尾（默认 g / G） */
  pagerTop: KeySpec[];
  pagerBottom: KeySpec[];
}

export const DEFAULT_KEYMAP: Keymap = {
  pagerClose: [{ key: 'escape' }, { key: 'c', ctrl: true }, { key: 'q' }],
  pagerUp: [{ key: 'up' }, { key: 'k' }],
  pagerDown: [{ key: 'down' }, { key: 'j' }],
  pagerHalfUp: [{ key: 'pageup' }, { key: 'b' }],
  pagerHalfDown: [{ key: 'pagedown' }, { key: ' ' }],
  pagerTop: [{ key: 'g' }],
  pagerBottom: [{ key: 'G' }],
};

const SPEC_KEYS = new Set(['enter', 'escape', 'tab', 'up', 'down', 'left', 'right', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'space']);

/** 键位规范解析（'ctrl+j' / 'shift+enter' / 'enter' / 'k' / 'G'——大小写敏感：G 与 g 不同键） */
export function parseKeySpec(spec: string): KeySpec | null {
  const s = String(spec ?? '').trim();
  if (!s || s.length > 40) return null;
  const parts = s.split('+').map(p => p.trim());
  const mods = parts.slice(0, -1).map(p => p.toLowerCase());
  const rawKey = parts[parts.length - 1];
  if (!rawKey) return null;
  const ctrl = mods.includes('ctrl');
  const shift = mods.includes('shift');
  const meta = mods.includes('meta') || mods.includes('cmd');
  if (mods.some(m => !['ctrl', 'shift', 'meta', 'cmd'].includes(m))) return null;
  // 键名：命名键大小写不敏感（ENTER→enter）；单字符保留原始大小写（G 与 g 不同键）
  const keyLower = rawKey.toLowerCase();
  const key = keyLower === 'space' ? ' ' : (SPEC_KEYS.has(keyLower) ? keyLower : rawKey);
  if (!SPEC_KEYS.has(key) && key.length !== 1) return null;
  // 单字符键禁止误配修饰（'ctrl+enter' 合法；'ctrl+abc' 非法）
  return {
    key,
    ...(ctrl ? { ctrl: true } : {}),
    ...(shift ? { shift: true } : {}),
    ...(meta ? { meta: true } : {}),
  };
}

/** 输入事件是否命中键位规范（ch=输入字符；key=ink 事件对象） */
export function matchesKey(
  key: { input?: string; return?: boolean; escape?: boolean; tab?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; backspace?: boolean; delete?: boolean; home?: boolean; end?: boolean; pageUp?: boolean; pageDown?: boolean; ctrl?: boolean; shift?: boolean; meta?: boolean },
  ch: string,
  spec: KeySpec,
): boolean {
  const keyName = spec.key;
  const matchesNamed = keyName === 'enter' ? key.return === true
    : keyName === 'escape' ? key.escape === true
    : keyName === 'tab' ? key.tab === true
    : keyName === 'up' ? key.upArrow === true
    : keyName === 'down' ? key.downArrow === true
    : keyName === 'left' ? key.leftArrow === true
    : keyName === 'right' ? key.rightArrow === true
    : keyName === 'backspace' ? key.backspace === true
    : keyName === 'delete' ? key.delete === true
    : keyName === 'home' ? key.home === true
    : keyName === 'end' ? key.end === true
    : keyName === 'pageup' ? key.pageUp === true
    : keyName === 'pagedown' ? key.pageDown === true
    : false;
  if (matchesNamed) return true;
  if (SPEC_KEYS.has(keyName)) return false; // 命名键已判定未命中
  // 单字符键：字符匹配（大小写敏感）+ 修饰一致
  if (ch !== keyName) return false;
  if (!!spec.ctrl !== !!key.ctrl) return false;
  if (!!spec.shift !== !!key.shift) return false;
  if (!!spec.meta !== !!key.meta) return false;
  return true;
}

/** 事件是否命中任一规范 */
export function matchesAny(
  key: Parameters<typeof matchesKey>[0],
  ch: string,
  specs: KeySpec[],
): boolean {
  return specs.some(s => matchesKey(key, ch, s));
}

/** settings.keymap JSON 覆盖合并（无效动作名/非法规范忽略回退默认——误配绝不崩 UI） */
export function resolveKeymap(settingsKeymap: unknown): Keymap {
  const out: Keymap = {
    pagerClose: [...DEFAULT_KEYMAP.pagerClose],
    pagerUp: [...DEFAULT_KEYMAP.pagerUp],
    pagerDown: [...DEFAULT_KEYMAP.pagerDown],
    pagerHalfUp: [...DEFAULT_KEYMAP.pagerHalfUp],
    pagerHalfDown: [...DEFAULT_KEYMAP.pagerHalfDown],
    pagerTop: [...DEFAULT_KEYMAP.pagerTop],
    pagerBottom: [...DEFAULT_KEYMAP.pagerBottom],
  };
  if (!settingsKeymap || typeof settingsKeymap !== 'object' || Array.isArray(settingsKeymap)) return out;
  const src = settingsKeymap as Record<string, unknown>;
  for (const action of Object.keys(out) as Array<keyof Keymap>) {
    const raw = src[action];
    if (raw === undefined) continue;
    const list = Array.isArray(raw) ? raw.map(r => String(r)) : [String(raw)];
    const specs = list.map(parseKeySpec).filter((s): s is KeySpec => s !== null);
    if (specs.length) out[action] = specs; // 全部非法 → 保留默认（诚实回退）
  }
  return out;
}

// ── 活动键位（模块级单例——与 permissions.setReadonlyTools 同模式）：TUI 配置水合
// （useConfigWatcher applyDisplay）时 setActiveKeymap；useKeyBindings 消费 getActiveKeymap。
let ACTIVE_KEYMAP: Keymap = resolveKeymap(undefined);

/** 配置水合时更新活动键位（settings.keymap 生效热更新） */
export function setActiveKeymap(km: Keymap): void {
  ACTIVE_KEYMAP = km;
}

export function getActiveKeymap(): Keymap {
  return ACTIVE_KEYMAP;
}
