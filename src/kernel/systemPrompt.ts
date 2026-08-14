// src/kernel/systemPrompt.ts — structured system prompt (intelligence baseline, self-built)
// All control text lives in the i18n catalogs (zh-CN/en, same keys) — this file is CJK-free:
// lang=en yields a fully English prompt (KF-029 contract). Copywriting rules: docs/copy-guide.md.
// Open compatibility: the lang option makes /lang effective (en -> English output rules);
// a prompts/system.md file under dataDir fully replaces the built-in prompt (external persona/workflow, hot reload)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mode } from './permissions.js';
import { translate, type MessageKey } from '../application/i18n/i18nService.js';
import type { Locale } from '../domain/config/configSchema.js';

const MODE_RULE_KEYS: Record<Mode, MessageKey> = {
  smart: 'system.mode.smart',
  auto: 'system.mode.auto',
  goal: 'system.mode.goal',
  manual: 'system.mode.manual',
  plan: 'system.mode.plan',
  yolo: 'system.mode.yolo',
};

export interface SysPromptOpts {
  mode: Mode;
  cwd: string;
  model: string;
  hasImageIn: boolean;
  sessionId?: string;
  /** /lang setting: 'en' switches output rules to English (other locales keep their own) */
  lang?: string;
  /** W2-01: locale (zh-CN/en) — behavior sections come from the i18n catalog (no text branching in code) */
  locale?: Locale;
  /** dataDir: prompts/system.md replaces the built-in prompt when present (hot reload) */
  dataDir?: string;
  /** W7/KF-004: persona (settings.personality real consumption — appended as a Persona section) */
  persona?: string;
}

const EN_OUTPUT_RULES: readonly string[] = [
  '1. Reply in English (keep code and commands verbatim).',
  '2. Annotate code blocks with their language; explain each file when changing several.',
  '3. Conclusion first, then details; use lists or tables for long content.',
  '4. Terminal layout: headings with ## (### for deeper levels); numbered steps 1. 2.;',
  '   conclusion paragraphs start with **Conclusion:**; wrap key numbers/paths/commands in backticks;',
  '   keep lines <= 80 chars.',
];

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [key, value]) => text.split(`{${key}}`).join(value), template);

/** External prompt override: prompts/system.md under dataDir replaces everything (re-read on each build) */
function externalPromptOverride(dataDir: string | undefined): string | null {
  if (!dataDir) return null;
  try {
    const text = readFileSync(join(dataDir, 'prompts', 'system.md'), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(opts: SysPromptOpts): string {
  const now = new Date();
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const locale: Locale = opts.locale ?? (lang === 'en' ? 'en' : 'zh-CN');
  const localeTag = lang === 'en' ? 'en-US' : 'zh-CN';
  const external = externalPromptOverride(opts.dataDir);

  const envBlock = [
    '## ' + translate(locale, 'system.envHeading'),
    '- ' + fill(translate(locale, 'system.env.cwd'), { cwd: opts.cwd }),
    '- ' + fill(translate(locale, opts.hasImageIn ? 'system.env.modelImage' : 'system.env.model'), { model: opts.model }),
    '- ' + fill(translate(locale, 'system.env.session'), { session: opts.sessionId ?? 'default' }),
    '- ' + fill(translate(locale, 'system.env.time'), { time: now.toLocaleString(localeTag, { hour12: false }) }),
  ].join('\n');

  if (external) {
    return `${external}\n\n${envBlock}`;
  }

  const outputRules = lang === 'en'
    ? [...EN_OUTPUT_RULES]
    : ([1, 2, 3, 4] as const).map((index) => `${index}. ${translate(locale, `system.output.${index}` as MessageKey)}`);

  const lines: string[] = [
    translate(locale, 'system.role'),
    '',
    '## ' + translate(locale, 'system.principlesHeading'),
    `0. ${translate(locale, 'system.behavior')}`,
    ...([1, 2, 3, 4, 5, 6, 7] as const).map((index) => `${index}. ${translate(locale, `system.p${index}` as MessageKey)}`),
    '',
    fill(translate(locale, 'system.modeHeading'), { mode: opts.mode }),
    translate(locale, MODE_RULE_KEYS[opts.mode] ?? MODE_RULE_KEYS.smart),
    '',
    '## ' + translate(locale, 'system.outputHeading'),
    ...outputRules,
    '',
    envBlock,
  ];
  if (opts.persona && opts.persona.trim()) {
    lines.push('', fill(translate(locale, 'system.persona'), { persona: opts.persona.trim() }));
  }
  return lines.join('\n');
}
