/**
 * 硬编码字段 3：把 Q 里的相对时间换算成绝对日期。
 *
 * 纯规则，不调 LLM（09-21 会议：时间是可以硬编码的 schema）。
 * 锚点 = 这条消息的发出时间，按 GMT+8 取日历日（用户本地时区）。
 *
 * 刻意不处理的：裸"周一/星期三"（常是"周一例会"这种周期性说法，猜具体日期会制造错误）；
 * 解析不了的一律不输出，宁缺毋滥。
 */
import type { ResolvedTime } from "./types.ts";

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 把毫秒时间戳变成 GMT+8 的日历日（以"UTC 午夜"表示，方便做日加减） */
function localDay(ts: number): Date {
  const d = new Date(ts + TZ_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** 周一为一周第一天：返回 d 所在周的周一 */
function mondayOf(d: Date): Date {
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  return addDays(d, -dow);
}

function monthStr(y: number, m0: number): string {
  const d = new Date(Date.UTC(y, m0, 1));
  return d.toISOString().slice(0, 7);
}

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 解析"3""十""十二""二十三"这类小数字；解析失败返回 null */
export function parseSmallNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? (CN_DIGIT[m[1]] ?? 0) : 1) * 10 + (m[2] ? (CN_DIGIT[m[2]] ?? 0) : 0);
  if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s] ?? null;
  return null;
}

/** 周一..周日 → 0..6；"天/日"都算周日 */
function weekdayIndex(ch: string): number | null {
  const map: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6, "1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5, "7": 6 };
  return map[ch] ?? null;
}

interface Rule {
  re: RegExp;
  resolve: (m: RegExpExecArray, anchor: Date) => string | null;
}

const NUM = "(\\d{1,2}|[一二两三四五六七八九十]{1,3})";

/**
 * "上/下"前面是这些字时不算时间词：晚上周一、看一下周报、马上月底……
 * （宁可漏换算，不要错换算）
 */
const NOT_AFTER = "(?<![晚早马路线身网手面台桌加以之一了底地在留剩放写看查等说往朝向])";

const RULES: Rule[] = [
  // ---- 周内具体日：上周三 / 这周五 / 本星期一 / 下礼拜二 ----
  {
    re: new RegExp(`${NOT_AFTER}(上上|上|这|本|下)(?:个)?(?:周|星期|礼拜)([一二三四五六日天1-7])`, "g"),
    resolve: (m, a) => {
      const shift = { 上上: -14, 上: -7, 这: 0, 本: 0, 下: 7 }[m[1] as "上" | "这" | "本" | "下" | "上上"];
      const wd = weekdayIndex(m[2] ?? "");
      if (shift === undefined || wd === null) return null;
      return fmt(addDays(mondayOf(a), shift + wd));
    },
  },
  // ---- 整周：上周 / 这周 / 下周（后面不跟星期几） ----
  {
    re: new RegExp(`${NOT_AFTER}(上上|上|这|本|下)(?:个)?(?:周|星期|礼拜)(?![一二三四五六日天1-7末报期边围年岁刊转全到记])`, "g"),
    resolve: (m, a) => {
      const shift = { 上上: -14, 上: -7, 这: 0, 本: 0, 下: 7 }[m[1] as "上"];
      if (shift === undefined) return null;
      const mon = addDays(mondayOf(a), shift);
      return `${fmt(mon)}..${fmt(addDays(mon, 6))}`;
    },
  },
  // ---- 月：上个月 / 这个月 / 下个月 / 本月 / 上月 ----
  {
    re: new RegExp(`${NOT_AFTER}(上|这|本|下)(?:个)?月(?![\\d一二三四五六七八九十]{1,3}[日号]|[亮光饼球色桥台])`, "g"),
    resolve: (m, a) => {
      const shift = { 上: -1, 这: 0, 本: 0, 下: 1 }[m[1] as "上"];
      if (shift === undefined) return null;
      return monthStr(a.getUTCFullYear(), a.getUTCMonth() + shift);
    },
  },
  // ---- 年：去年 / 今年 / 明年 / 前年 ----
  {
    re: /(前年|去年|今年|明年)/g,
    resolve: (m, a) => {
      const shift = { 前年: -2, 去年: -1, 今年: 0, 明年: 1 }[m[1] as "去年"];
      if (shift === undefined) return null;
      return String(a.getUTCFullYear() + shift);
    },
  },
  // ---- X月X日 / X月X号：取锚点年份；若落在四个月以后，当作去年（六月说"12月9号"多半指去年） ----
  // 放在"N 天前"之前："4月14日前"要先被认成日期，而不是"14 日前"
  {
    re: new RegExp(`${NUM}月${NUM}[日号]`, "g"),
    resolve: (m, a) => {
      const mo = parseSmallNumber(m[1] ?? "");
      const da = parseSmallNumber(m[2] ?? "");
      if (mo === null || da === null || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
      let d = new Date(Date.UTC(a.getUTCFullYear(), mo - 1, da));
      if (d.getTime() - a.getTime() > 120 * DAY_MS) d = new Date(Date.UTC(a.getUTCFullYear() - 1, mo - 1, da));
      return fmt(d);
    },
  },
  // ---- N 天前 / N 周前 / N 个月前 ----
  // 不收"N 日前"：实际数据里它多半是截止说法（"屆满五日前""14 日前完成"），不是"N 天以前"
  {
    re: new RegExp(`${NUM}(天|周|星期|个月)(?:之)?前`, "g"),
    resolve: (m, a) => {
      const n = parseSmallNumber(m[1] ?? "");
      if (n === null) return null;
      const unit = m[2];
      if (unit === "天") return fmt(addDays(a, -n));
      if (unit === "周" || unit === "星期") return fmt(addDays(a, -7 * n));
      return monthStr(a.getUTCFullYear(), a.getUTCMonth() - n);
    },
  },
  // ---- 单字日：大前天 / 前天 / 昨天 / 今天 / 明天 / 后天 ----
  {
    re: /(大前天|前天|昨天|昨日|今天|今日|明天|后天)/g,
    resolve: (m, a) => {
      const shift = { 大前天: -3, 前天: -2, 昨天: -1, 昨日: -1, 今天: 0, 今日: 0, 明天: 1, 后天: 2 }[m[1] as "昨天"];
      return shift === undefined ? null : fmt(addDays(a, shift));
    },
  },
  // ---- 英文常见说法 ----
  {
    re: /\b(yesterday|today|tomorrow|last week|this week|next week|last month|this month)\b/gi,
    resolve: (m, a) => {
      const k = (m[1] ?? "").toLowerCase();
      if (k === "yesterday") return fmt(addDays(a, -1));
      if (k === "today") return fmt(a);
      if (k === "tomorrow") return fmt(addDays(a, 1));
      if (k.endsWith("week")) {
        const shift = k.startsWith("last") ? -7 : k.startsWith("next") ? 7 : 0;
        const mon = addDays(mondayOf(a), shift);
        return `${fmt(mon)}..${fmt(addDays(mon, 6))}`;
      }
      return monthStr(a.getUTCFullYear(), a.getUTCMonth() + (k.startsWith("last") ? -1 : 0));
    },
  },
];

/**
 * 在 text 中找出全部相对时间表达并换算。
 * 同一段文字只被第一条命中的规则占用（规则按"更具体优先"排序）。
 */
/**
 * 引用块（用户选中的助手原文、引用的文件）里的"上周/今天"不是这条消息说的时间，
 * 按消息时间换算会错。用等长空格遮掉，保持下标不变。
 */
function maskQuoted(text: string): string {
  return text.replace(/<(quoted_context|quoted_file|quoted_message)[^>]*>[\s\S]*?<\/\1>/g, (s) => " ".repeat(s.length));
}

export function resolveRelativeTimes(rawText: string, anchorTs: number): ResolvedTime[] {
  const text = maskQuoted(rawText);
  const anchor = localDay(anchorTs);
  const taken: Array<[number, number]> = [];
  const out: ResolvedTime[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      const value = rule.resolve(m, anchor);
      if (value === null) continue;
      taken.push([start, end]);
      out.push({ text: m[0], index: start, value });
    }
  }
  return out.sort((x, y) => x.index - y.index);
}
