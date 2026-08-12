// src/build/spec.ts — L3-1 规格契约（概念编译器的输入闸门）
// 设计：规则脑关键词→模具（零 key 可用）；LLM 增强开放域（有 key 时）；契约校验（3 条验收/禁主观词）
// A21：分级诊断（error/warning/info）——编译器的语义分析阶段输出
export interface Spec {
  title: string;
  summary: string;
  scaffold: string;
  acceptance: string[];
}

export interface SpecDiagnostic {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

/** 模具集合（llmSpec.ts 校验 LLM 输出合法性复用） */
export const SCAFFOLDS = ['ledger', 'todo', 'note', 'anim', 'generic'] as const;

// 规则脑模具关键词表（P0-1 扩充：高频需求词 → generic 基线 CRUD 模板；
// 规则顺序：specific 在前，通用兜底在后）
const RULES: Array<{ re: RegExp; scaffold: string }> = [
  { re: /记账|账本|财务|收支|ledger|bookkeep/i, scaffold: 'ledger' },
  { re: /待办|任务清单|todo|task list/i, scaffold: 'todo' },
  { re: /笔记|知识库|note|wiki/i, scaffold: 'note' },
  { re: /动画|分镜|anim/i, scaffold: 'anim' },
  // ── P0-1：常见需求词扩充（映射 generic 基线 CRUD）──
  { re: /计算器|calculator|算税|算利率|换算器/i, scaffold: 'generic' },
  { re: /爬虫|抓取数据|采集|crawler|spider/i, scaffold: 'generic' },
  { re: /博客|blog|文章发布/i, scaffold: 'generic' },
  { re: /问卷|投票|survey|poll|表单收集/i, scaffold: 'generic' },
  { re: /聊天室|chat room|chatroom|即时通讯|聊天机器人|chatbot/i, scaffold: 'generic' },
  { re: /天气|weather/i, scaffold: 'generic' },
  { re: /翻译|翻译器|词典|translate|dictionary/i, scaffold: 'generic' },
  { re: /时钟|钟表|计时|倒计时|clock|stopwatch|timer/i, scaffold: 'generic' },
  { re: /画板|画布|白板|绘图|draw|canvas|白板/i, scaffold: 'generic' },
  { re: /短链|短链接|短网址|shorten|短码/i, scaffold: 'generic' },
  { re: /文件管理|文件整理|file manager|批量重命名/i, scaffold: 'generic' },
  { re: /图表|图表生成|数据可视化|chart|dashboard|看板/i, scaffold: 'generic' },
  { re: /下载|downloader|离线保存/i, scaffold: 'generic' },
  { re: /提醒|提醒器|备忘|reminder|闹钟/i, scaffold: 'generic' },
  { re: /密码|密码生成|密钥生成|password|passphrase/i, scaffold: 'generic' },
  { re: /随机|随机数|抽签|抽奖|random|lottery/i, scaffold: 'generic' },
  { re: /OCR|文字识别|图片转文字/i, scaffold: 'generic' },
  { re: /RSS|订阅源|feed 阅读/i, scaffold: 'generic' },
  { re: /音乐|播放器|播放列表|music|player/i, scaffold: 'generic' },
  { re: /图片|图片处理|压缩图片|缩略图|image|thumbnail/i, scaffold: 'generic' },
  { re: /日记|日志记录|diary|journal/i, scaffold: 'note' },
  // ── 校准完善：零配置离线可用的价值实锤——高频个人/小团队需求模板扩充 ──
  { re: /简历|个人主页|名片|portfolio|resume/i, scaffold: 'generic' },
  { re: /日程|日历|安排表|行程|calendar|schedule|排班/i, scaffold: 'generic' },
  { re: /商城|购物|商品|订单|shop|store|shopping/i, scaffold: 'generic' },
  { re: /论坛|社区|帖子|讨论|forum|bbs|话题/i, scaffold: 'generic' },
  { re: /新闻|资讯|头条|news|headline/i, scaffold: 'generic' },
  { re: /相册|照片|图库|画廊|album|gallery|photo/i, scaffold: 'generic' },
  { re: /书签|收藏|稍后读|bookmark|favorite|read later/i, scaffold: 'generic' },
  { re: /题库|测验|考试|练习|quiz|exam|flashcard/i, scaffold: 'generic' },
  { re: /考勤|打卡|签到|attendance|check.?in/i, scaffold: 'generic' },
  { re: /库存|仓库管理|进货|出货|inventory|stock/i, scaffold: 'generic' },
  { re: /员工|人事|通讯录|联系人|hr|employee|contacts/i, scaffold: 'generic' },
  { re: /账单|发票|报销|invoice|receipt|reimburse/i, scaffold: 'generic' },
  { re: /菜谱|食谱|点餐|菜单|recipe|menu|restaurant/i, scaffold: 'generic' },
  { re: /运动|健身|打卡.*(?:跑步|运动)|健康|fitness|workout|steps/i, scaffold: 'generic' },
  { re: /旅行|旅游|游记|出行|trip|travel|itinerary/i, scaffold: 'generic' },
  { re: /电影|影单|书单|收藏夹.*(?:电影|书)|watchlist|reading list/i, scaffold: 'generic' },
  { re: /会议|会议纪要|minutes|meeting/i, scaffold: 'note' },
  { re: /公告|通知公告|通知栏|notice|announcement/i, scaffold: 'generic' },
  { re: /二手|转让|求购|闲置|marketplace|sell|buy used/i, scaffold: 'generic' },
  { re: /住宿|民宿|预订|酒店|hotel|booking|reservation/i, scaffold: 'generic' },
  { re: /快递|物流|包裹|shipment|tracking/i, scaffold: 'generic' },
  { re: /系统|网站|应用|工具|页面|管理|平台/i, scaffold: 'generic' },
];

const SUBJECTIVE = /良好|合理|美观|优雅|好用|顺畅/;

/** A21：分级诊断（error=阻断编译 / warning=可编译但提示 / info=信息） */
export function diagnoseSpec(s: Spec): SpecDiagnostic[] {
  const out: SpecDiagnostic[] = [];
  if (!s.title) out.push({ level: 'error', code: 'spec.title.missing', message: '标题必填' });
  if (!s.summary) out.push({ level: 'error', code: 'spec.summary.missing', message: '摘要必填' });
  if (!SCAFFOLDS.includes(s.scaffold as any)) {
    out.push({ level: 'error', code: 'spec.scaffold.invalid', message: `模具必须∈${SCAFFOLDS.join('/')}` });
  }
  if (s.acceptance.length !== 3) {
    out.push({
      level: s.acceptance.length === 0 ? 'error' : 'warning',
      code: 'spec.acceptance.count',
      message: `验收 ${s.acceptance.length}/3 条（建议恰 3 条，可验收可机器验证）`,
    });
  }
  for (const a of s.acceptance) {
    if (SUBJECTIVE.test(a)) out.push({ level: 'error', code: 'spec.acceptance.subjective', message: `验收含主观词：${a}` });
  }
  if (s.title && s.title.length > 30) out.push({ level: 'warning', code: 'spec.title.long', message: '标题过长（>30 字符），建议精简' });
  if (s.summary && s.summary.length > 500) out.push({ level: 'warning', code: 'spec.summary.long', message: '摘要过长（>500 字符），建议收敛需求范围' });
  if (s.scaffold && SCAFFOLDS.includes(s.scaffold as any)) {
    out.push({ level: 'info', code: 'spec.scaffold.hit', message: `模具命中：${s.scaffold}` });
  }
  return out;
}

export function validateSpec(s: Spec): { ok: boolean; reason?: string } {
  const errors = diagnoseSpec(s).filter(d => d.level === 'error');
  if (errors.length) return { ok: false, reason: errors.map(e => e.message).join('；') };
  return { ok: true };
}

export function makeSpec(input: string, _opts: { key: string | null }): Spec {
  // 规则脑优先
  for (const r of RULES) {
    if (r.re.test(input)) {
      const spec: Spec = {
        title: input.slice(0, 14),
        summary: input,
        scaffold: r.scaffold,
        acceptance: [
          '能完成核心数据的新增与展示',
          '数据本地持久化，重启不丢失',
          '提供清晰的用户操作入口',
        ],
      };
      return validateSpec(spec).ok ? spec : { ...spec, scaffold: 'generic' };
    }
  }
  // 开放域：有 key 时 LLM 补充（agent 层接入）；无 key 诚实拒答
  return { title: '', summary: '', scaffold: 'unknown', acceptance: [] };
}

