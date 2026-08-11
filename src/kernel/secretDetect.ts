// src/kernel/secretDetect.ts — 语音转写敏感检测（密钥安全通道红线）
// 语音说"设置密钥 sk-xxx"若走普通提交，明文会进会话历史并发给模型提供商——红线。
// 本模块在 voice.transcript 注入 composer 前拦截：命中敏感模式 → 走专用通道
// （本地 /key set 加密存储），转写文本不进历史/模型/显示。
// 纯函数——直接单测（合成转写文本）。

export type SecretMatchKind = 'apiKey' | 'keyCommand' | 'password'

export interface SecretMatch {
  kind: SecretMatchKind
  /** 提取的密钥/口令串（keyCommand 引导场景为空串） */
  secret: string
  /** 完整转写文本 */
  full: string
  /** 密钥打码后的安全版本（可安全显示/记录） */
  redacted: string
}

// sk- 前缀 API 密钥（OpenAI 系）：8+ 位字母数字下划线连字符
const SK_KEY_RE = /\b(sk-[A-Za-z0-9_\-]{8,})\b/
// password/密码 赋值（中英文冒号均可；中文前无词边界——用分隔符前导替代 \b）
const PASSWORD_RE = /(?:^|[\s，。！？、；;])(?:password|密码)\s*[:=：]\s*([^\s，。！？,.;；]+)/i
// /key 命令变体（可能带密钥）
const KEY_CMD_WITH = /^\/key\s+(?:set\s+)?(\S+.*)$/i
const KEY_CMD_BARE = /^\/key\s*$/i
// 中文"设置/配置密钥"（无密钥内容——引导用户说出密钥）
const SET_KEY_CN = /(?:设置|配置|录入|输入)\s*(?:api\s*)?(?:密钥|key)|(?:密钥|key)\s*(?:设置|配置)/i

/**
 * 检测转写文本是否含敏感内容。命中返回匹配（含打码版本），否则 null。
 * 优先级：/key 命令变体 > sk- 密钥 > password/密码 赋值 > 中文"设置密钥"。
 */
export function detectSecretInTranscript(text: string): SecretMatch | null {
  const t = String(text ?? '').trim();
  if (!t) return null;

  const cmdWith = t.match(KEY_CMD_WITH);
  if (cmdWith) {
    const secret = cmdWith[1]!.trim();
    return { kind: 'keyCommand', secret, full: t, redacted: t.replace(secret, '••••') };
  }
  if (KEY_CMD_BARE.test(t)) {
    return { kind: 'keyCommand', secret: '', full: t, redacted: t };
  }

  const sk = t.match(SK_KEY_RE);
  if (sk) {
    const secret = sk[1]!;
    return { kind: 'apiKey', secret, full: t, redacted: t.replace(secret, '••••') };
  }

  const pw = t.match(PASSWORD_RE);
  if (pw) {
    const secret = pw[1]!;
    return { kind: 'password', secret, full: t, redacted: t.replace(secret, '••••') };
  }

  if (SET_KEY_CN.test(t)) {
    return { kind: 'keyCommand', secret: '', full: t, redacted: t };
  }

  return null;
}
