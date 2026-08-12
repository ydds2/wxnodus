// src/kernel/commandLevels.ts — 命令分级（AI 自主调用通道 wx_cmd 的裁决依据）
// 四级（对应「按等级确认危险操作的自主调用」）：
//   safe    纯查询/只读——AI 直接执行，不弹确认
//   confirm 常规副作用（写文件/切会话/压缩）——走现有模式确认链
//   danger  高危（执行任意命令序列/外发数据/挂起进程）——强制人工确认，AI 预审不可放行
//   redline 权限/密钥/安全/退出——AI 通道一律拒绝，提示手动执行
// 白名单制：未命中表项 → 保守 confirm（用户确认后 bus 会处理未知命令，无害）；
// 非命令输入（不以 / 开头）→ redline（防任意文本注入执行）。
export type CommandLevel = 'safe' | 'confirm' | 'danger' | 'redline';

export const COMMAND_LEVEL_LABEL: Record<CommandLevel, string> = {
  safe: '安全', confirm: '确认', danger: '危险', redline: '红线',
};
export const COMMAND_LEVEL_ICON: Record<CommandLevel, string> = {
  safe: '🟢', confirm: '🟡', danger: '🟠', redline: '🔴',
};

// 白名单表：键为命令串（子命令精确键优先——最长前缀匹配，'/key set' 先于 '/key' 命中）
export const COMMAND_LEVELS: Record<string, CommandLevel> = {
  // ── safe：查询/只读，AI 直接执行 ──
  '/help': 'safe', '/usage': 'safe', '/sessions': 'safe', '/context': 'safe', '/status': 'safe',
  '/doctor': 'safe', '/version': 'safe', '/memory': 'safe', '/hole': 'safe', '/evidence': 'safe',
  '/compliance': 'safe', '/audit': 'safe', '/logs': 'safe', '/bench': 'safe', '/map': 'safe',
  '/calc': 'safe', '/hash': 'safe', '/base64': 'safe', '/uuid': 'safe', '/rand': 'safe', '/json': 'safe',
  '/sql': 'safe', '/units': 'safe', '/csv': 'safe', '/claw': 'safe', '/vision': 'safe', '/img': 'safe',
  '/video': 'safe', '/jobs': 'safe', '/search': 'safe', '/web': 'safe', '/term': 'safe', '/term attach': 'safe', '/task': 'safe', '/cron list': 'safe',
  '/script list': 'safe', '/script show': 'safe', '/script dry-run': 'safe', '/script verify': 'safe',
  '/script ci': 'safe', '/script watch list': 'safe',
  '/jobs list': 'safe', '/jobs show': 'safe', '/jobs logs': 'safe', '/jobs tree': 'safe',
  '/plan': 'safe', '/perm': 'safe', '/perm rule list': 'safe',
  '/sandbox': 'safe', '/security': 'safe', '/security status': 'safe',
  '/theme': 'safe', '/lang': 'safe', '/config': 'safe', '/versions': 'safe',
  '/skill list': 'safe', '/skill inspect': 'safe', '/fs': 'safe',
  '/checkpoint list': 'safe', '/snapshot list': 'safe', '/undo list': 'safe',
  // ── confirm：常规副作用，走现有模式确认链 ──
  '/clear': 'confirm', '/undo': 'confirm', '/resume': 'confirm', '/new': 'confirm', '/title': 'confirm',
  '/fork': 'confirm', '/checkpoint': 'confirm', '/snapshot': 'confirm', '/model': 'confirm',
  '/thinking': 'confirm', '/hooks': 'confirm', '/key': 'confirm',
  '/compact': 'confirm', '/digest': 'confirm', '/curator': 'confirm',
  '/build': 'confirm', '/forge': 'confirm', '/skill': 'confirm', '/skill new': 'confirm',
  '/skill install': 'confirm', '/learn': 'confirm', '/assimilate': 'confirm', '/gate': 'confirm', '/fdr': 'confirm',
  '/flow': 'confirm', '/import': 'confirm', '/consent': 'confirm', '/encrypt': 'confirm',
  '/backup': 'confirm', '/export': 'confirm', '/theme dark': 'confirm', '/theme light': 'confirm',
  '/theme wxnodus': 'confirm', '/lang zh': 'confirm', '/lang en': 'confirm', '/config set': 'confirm',
  '/init': 'confirm', '/render': 'confirm', '/capture': 'confirm', '/input': 'confirm',
  '/mcp': 'confirm', '/plugin': 'confirm', '/proxy': 'confirm', '/webhook': 'confirm',
  '/a2a': 'confirm', '/acp': 'confirm', '/swarm': 'confirm', '/duo': 'confirm',
  '/cron': 'confirm', '/cron add': 'confirm', '/cron del': 'confirm', '/timer': 'confirm',
  '/delegate': 'confirm', '/goal': 'confirm', '/btw': 'confirm',
  '/rewind': 'confirm', '/reload-skills': 'confirm', '/script': 'confirm',
  '/script record': 'confirm', '/script stop': 'confirm', '/script watch': 'confirm',
  '/jobs retry': 'confirm', '/jobs pause': 'confirm', '/jobs resume': 'confirm', '/jobs clean': 'confirm',
  '/cron run': 'confirm',
  '/security sudo off': 'confirm', '/security secret off': 'confirm',
  // P0-1/P0-2：浏览器（打开页面/交互——副作用外联）与自定义 agent（派发执行）
  '/browser': 'confirm', '/browser open': 'confirm', '/browser close': 'safe',
  '/agent': 'confirm', '/agent list': 'safe', '/agent run': 'confirm',
  // 全方面：/arena 多模型对战——执行任务（消耗 token 与模型调用），需确认
  '/arena': 'confirm',
  // 深度：/review 任务自查——只读子代理执行，需确认（AI 调用）
  '/review': 'confirm',
  // ── danger：高危，强制人工确认（AI 预审不可放行）──
  '/deploy': 'danger', '/script run': 'danger',
  '/webhook add': 'danger', '/webhook del': 'danger',
  '/gateway': 'danger', '/gateway start': 'danger', '/a2a serve': 'danger', '/acp serve': 'danger',
  // 任务系统：AI 发起任意 shell 后台执行 / 取消 → 强制人工确认
  '/jobs run': 'danger', '/jobs kill': 'danger',
  // 后台终端：注入输入=执行命令，AI 发起必须人工确认
  '/term write': 'danger', '/term kill': 'danger', '/term new': 'confirm',
  // ── redline：AI 通道一律拒绝，提示手动执行 ──
  '/quit': 'redline', '/yolo': 'redline', '/afk': 'redline',
  '/perm smart': 'redline', '/perm auto': 'redline', '/perm manual': 'redline', '/perm plan': 'redline',
  '/perm yolo': 'redline', '/perm goal': 'redline', '/perm rule': 'redline',
  '/sandbox L0': 'redline', '/sandbox L1': 'redline', '/sandbox L2': 'redline', '/sandbox L3': 'redline',
  '/key set': 'redline', '/key off': 'redline', '/self-evolve': 'redline',
  '/security sudo on': 'redline', '/security secret on': 'redline', '/security all': 'redline',
  '/plan on': 'redline', '/plan off': 'redline',
};

/** 命令分级：最长前缀匹配（子命令优先）——命中返回等级；未命中保守 confirm；非命令 redline */
export function classifyCommand(input: string): CommandLevel {
  const cmd = String(input ?? '').trim();
  if (!cmd.startsWith('/')) return 'redline';
  const tokens = cmd.split(/\s+/);
  for (let n = tokens.length; n >= 1; n--) {
    const lv = COMMAND_LEVELS[tokens.slice(0, n).join(' ')];
    if (lv) {
      // 密钥直接注入变体（/key <密钥> 不写子命令）→ 与 /key set 同级红线（模型不可代改密钥）
      if (lv === 'confirm' && tokens[0] === '/key' && tokens.length > 1 && !/^(set|off)$/i.test(tokens[1]!)) {
        return 'redline';
      }
      return lv;
    }
  }
  return 'confirm';
}
