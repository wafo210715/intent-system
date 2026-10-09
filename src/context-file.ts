/**
 * 上下文文件（契约 v3.2 §四，用户 17:20 / 17:57 定）。
 *
 * intent-lab 每个 sessionId 维护一份 context.md 与 context.jsonl，放在 data/context/<sessionId>/：
 *   context.jsonl   条目行（契约规定形状）：每行一个入选 (qaId, 岗)
 *   context.md      给人/给主模型看的全文（契约示意格式）
 *   questions.jsonl 内部文件：每问的元数据（第几问、时间、scene、want）——md 的「这一问在做什么」要它
 *
 * 每次正常 done 追加「第 N 问」一节（N = 该会话第 N 次正常走完；gate 跳过 / error / cancel 不计）。
 * 表态后同步改（用户 17:57 定）：no → 从 md 里移除该条（jsonl 里 verdict 改 "no"，不删行）；
 *   yes → 标「你确认过」；edited → 标「你改为：<用户说法>」，连接句换成用户说法。
 *   确认卡底部「补充背景」（note，09-29 用户定）→ 写在那一问小节开头「你补充的背景：…」，同会话后面的问题也读得到。
 * done 与 /feedback 的响应都把全文带回，Orbita 覆盖写到该会话工作台。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store.ts";
import { slotNameOf } from "./types.ts";
import type { ConfirmState } from "./review.ts";

/** 契约 §四的 jsonl 行 */
export interface ContextEntryRow {
  sessionId: string;
  /** 第几问（从 1 起） */
  question: number;
  turnId: string;
  qaId: string;
  slot: number;
  score: number;
  human: string;
  assistant: string;
  connection: string;
  prediction: string;
  dupCount: number;
  verdict: null | "yes" | "no" | "edited";
  edited?: string;
}

/** 内部文件 questions.jsonl 的一行：每问元数据 */
export interface ContextQuestionRow {
  question: number;
  ts: number;
  turnId: string;
  scene: string;
  want: string;
  /** 用户在这一问确认卡上补的一句背景（/feedback 的 note）；没填就没有 */
  note?: string;
  /** 这一问的原话（09-29 起；旧行没有） */
  q?: string;
}

/** 契约 ContextFileV32：done 事件与 /feedback 响应带回的全文 */
export interface ContextFileView {
  question: number;
  md: string;
  jsonl: string;
  /** 本问新增条数（/feedback 重建时 = 该问可见条数） */
  added: number;
  notice: string;
}

export function contextDir(sessionId: string, dir = dataDir()): string {
  // sessionId 里可能有路径字符（Orbita 会话 id 通常是 uuid，但兜底替换掉）
  const safe = sessionId.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return join(dir, "context", safe);
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export function loadContextState(sessionId: string, dir = dataDir()): { questions: ContextQuestionRow[]; entries: ContextEntryRow[] } {
  const d = contextDir(sessionId, dir);
  return {
    questions: readJsonl<ContextQuestionRow>(join(d, "questions.jsonl")),
    entries: readJsonl<ContextEntryRow>(join(d, "context.jsonl")),
  };
}

/** 该会话已正常走完的问数（决定下一问是第几问、以及是否给守门员带上上下文文件） */
export function contextQuestionCount(sessionId: string, dir = dataDir()): number {
  return loadContextState(sessionId, dir).questions.length;
}

/** 上一版 context.md 全文（没有就 undefined；守门员从第 2 问起带上它） */
export function loadContextMd(sessionId: string, dir = dataDir()): string | undefined {
  const p = join(contextDir(sessionId, dir), "context.md");
  if (!existsSync(p)) return undefined;
  const md = readFileSync(p, "utf8");
  return md.trim() ? md : undefined;
}

const slotName = slotNameOf;
/** 完整时间「2026-09-26 16:20」（契约示意：第 N 问标题里用完整日期） */
const fmtFull = (ts: number): string => new Date(ts + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
/** 短时间「09-26 16:20」（条目行里用，与契约 §四示意一致） */
const fmtShortCtx = (ts: number): string => new Date(ts + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");

/** 中文量词：1 条 → 一条、2 → 两条，其余数字条 */
function cnCount(n: number): string {
  return n === 1 ? "一条" : n === 2 ? "两条" : `${n} 条`;
}

export function rowsToJsonl(entries: ContextEntryRow[]): string {
  return entries.map((r) => JSON.stringify(r)).join("\n") + (entries.length ? "\n" : "");
}

/**
 * 第 N 问一节在 md 里的行号区间（从 1 起，含首尾）。09-29：上下文文件上千行时，回答模型分段读、
 * 读不到最新一节就以为「文件只到上一问」；notice 带上行号，它可以直接跳过去。
 */
export function sectionLineRange(md: string, question: number): [number, number] | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## 第 ${question} 问`));
  if (start < 0) return null;
  const next = lines.findIndex((l, i) => i > start && l.startsWith("## 第 "));
  let last = next < 0 ? lines.length : next; // 下一节标题的下标 = 本节最后一行的行号
  while (last > start + 1 && (lines[last - 1] ?? "").trim() === "") last--; // 去掉节尾空行
  return [start + 1, last];
}

/** notice 里的位置说明：「（在 <绝对路径>/context.md 第 a–b 行）」；找不到就空串。
 *  10-10 起带全路径：插件 toast 里用户要能直接找到磁盘上的文件 */
function whereIs(md: string, question: number, sessionId: string, dir: string): string {
  const r = sectionLineRange(md, question);
  return r ? `（在 ${join(contextDir(sessionId, dir), "context.md")} 第 ${r[0]}–${r[1]} 行）` : "";
}

/** md 渲染：按问分节、按岗分段；verdict=no 不渲染；yes/edited 带标记；edited 的连接句换成用户说法 */
export function renderContextMd(
  questions: ContextQuestionRow[],
  entries: ContextEntryRow[],
  titleOf: (qaId: string) => string,
  tsOf: (qaId: string) => number,
): string {
  const lines: string[] = ["# 意图系统为这个会话整理的上下文", ""];
  for (const q of questions) {
    const visible = entries.filter((e) => e.question === q.question && e.verdict !== "no");
    lines.push(`## 第 ${q.question} 问（${fmtFull(q.ts)}）${q.question > 1 ? `· 新增 ${visible.length} 条` : ""}`);
    if (q.q) lines.push(`你的原话：${q.q.length > 200 ? `${q.q.slice(0, 200)}…` : q.q}`);
    lines.push(`这一问在做什么：${q.scene}，想要 ${q.want}`);
    if (q.note) lines.push(`你补充的背景：${q.note}`);
    lines.push("");
    const slots = [...new Set(visible.map((e) => e.slot))].sort((a, b) => a - b);
    for (const slot of slots) {
      lines.push(`### 岗 ${slot} · ${slotName(slot)}`);
      for (const e of visible.filter((x) => x.slot === slot).sort((a, b) => tsOf(a.qaId) - tsOf(b.qaId))) {
        const marks: string[] = [`${e.score.toFixed(1)}`];
        if (e.dupCount > 1) marks.push(`出现 ${e.dupCount} 次`);
        if (e.verdict === "yes") marks.push("你确认过");
        if (e.verdict === "edited" && e.edited) marks.push(`你改为：${e.edited}`);
        lines.push(`▸ ${fmtShortCtx(tsOf(e.qaId))}《${titleOf(e.qaId)}》· ${marks.join(" · ")}`);
        lines.push(`  原文（你的原话，逐字）：${e.human}`);
        if (e.assistant) lines.push(`  原文（助手回答里补的一段）：${e.assistant}`);
        lines.push(`  连接：${e.verdict === "edited" && e.edited ? e.edited : e.connection}`);
        lines.push(`  预测：${e.prediction}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

function persist(sessionId: string, questions: ContextQuestionRow[], entries: ContextEntryRow[], md: string, dir: string): void {
  const d = contextDir(sessionId, dir);
  mkdirSync(d, { recursive: true });
  writeJsonl(join(d, "questions.jsonl"), questions);
  writeJsonl(join(d, "context.jsonl"), entries);
  writeFileSync(join(d, "context.md"), md);
}

/** done 后追加「第 N 问」：条目带历史表态（同 (qaId, 岗) 表过 yes/edited 的直接带标记，no 的报名 S3 已丢） */
export function appendQuestion(
  sessionId: string,
  opts: {
    turnId: string;
    ts: number;
    scene: string;
    want: string;
    /** 用户这一问的原话（09-29：写进小节，回答模型能把「第 N 问」对上是哪条消息） */
    q?: string;
    /** 守门员选中的条目 */
    entries: Array<{ qaId: string; slot: number; score: number; human: string; assistant: string; connection: string; prediction: string; dupCount: number }>;
    /** 历史表态（键 `${qaId}#${slot}`），决定初始 verdict */
    verdicts?: Map<string, ConfirmState>;
    titleOf: (qaId: string) => string;
    tsOf: (qaId: string) => number;
  },
  dir = dataDir(),
): ContextFileView {
  const loaded = loadContextState(sessionId, dir);
  // 09-29：同一 turnId 再次走完（确认失败后重试、「做一次意图分析」）是同一问重来——替换原来那一节，不新增一问
  const same = loaded.questions.find((q) => q.turnId === opts.turnId);
  const question = same ? same.question : loaded.questions.length + 1; // 第 N 问 = 第 N 次正常走完（同一轮只算一次）
  const questions = loaded.questions.filter((q) => q.question !== question);
  const entries = loaded.entries.filter((e) => e.question !== question);
  const rows: ContextEntryRow[] = opts.entries.map((e) => {
    const prev = opts.verdicts?.get(`${e.qaId}#${e.slot}`);
    const verdict: ContextEntryRow["verdict"] = prev ? (prev.edited ? "edited" : prev.verdict === "skip" ? null : prev.verdict) : null;
    return {
      sessionId,
      question,
      turnId: opts.turnId,
      qaId: e.qaId,
      slot: e.slot,
      score: e.score,
      human: e.human,
      assistant: e.assistant,
      connection: e.connection,
      prediction: e.prediction,
      dupCount: e.dupCount,
      verdict,
      ...(verdict === "edited" && prev?.edited ? { edited: prev.edited } : {}),
    };
  });
  const nextQuestions: ContextQuestionRow[] = [
    ...questions,
    { question, ts: opts.ts, turnId: opts.turnId, scene: opts.scene, want: opts.want, ...(opts.q ? { q: opts.q } : {}) },
  ].sort((a, b) => a.question - b.question);
  const nextEntries = [...entries, ...rows];
  const md = renderContextMd(nextQuestions, nextEntries, opts.titleOf, opts.tsOf);
  persist(sessionId, nextQuestions, nextEntries, md, dir);
  const added = rows.length;
  const slotCounts = new Map<number, number>();
  for (const r of rows) slotCounts.set(r.slot, (slotCounts.get(r.slot) ?? 0) + 1);
  const dist = [...slotCounts.entries()].sort((a, b) => a[0] - b[0]).map(([slot, n]) => `岗 ${slot} ${cnCount(n)}`).join("、");
  const redo = same ? "（同一轮重来，替换了上一次的结果）" : "";
  const notice = added > 0
    ? `上下文文件更新了：第 ${question} 问${redo}新增 ${added} 条（${dist}），理由写在文件里${whereIs(md, question, sessionId, dir)}。`
    : `上下文文件更新了：第 ${question} 问${redo}没有取回相关条目${whereIs(md, question, sessionId, dir)}。`;
  return { question, md, jsonl: rowsToJsonl(nextEntries), added, notice };
}

/** /feedback 按表态改写：全会话同 (qaId, 岗) 的行一起改（边是全局的，md 要一致）；skip 不动 */
export function applyFeedbackToContext(
  sessionId: string,
  answers: Array<{ qaId: string; slot: number; verdict: "yes" | "no" | "skip"; edited?: string }>,
  opts: { question: number; titleOf: (qaId: string) => string; tsOf: (qaId: string) => number; note?: string },
  dir = dataDir(),
): ContextFileView {
  const loaded = loadContextState(sessionId, dir);
  const entries = loaded.entries;
  // 补充背景：记到这一问的元数据上（同一问再次表态时以最后一次为准；空串 = 没填，不覆盖）
  const note = opts.note?.trim() ?? "";
  const questions = note ? loaded.questions.map((q) => (q.question === opts.question ? { ...q, note } : q)) : loaded.questions;
  const byKey = new Map(answers.map((a) => [`${a.qaId}#${a.slot}`, a]));
  let confirmed = 0;
  let removed = 0;
  let rewritten = 0;
  const nextEntries = entries.map((e) => {
    const a = byKey.get(`${e.qaId}#${e.slot}`);
    if (!a) return e;
    if (a.edited !== undefined) {
      // edited 可与任何 verdict 并存（改字 = 矫正）：verdict 记 edited，连接句换成用户说法
      rewritten++;
      return { ...e, verdict: "edited" as const, edited: a.edited };
    }
    if (a.verdict === "yes") {
      confirmed++;
      return { ...e, verdict: "yes" as const, edited: undefined };
    }
    if (a.verdict === "no") {
      removed++;
      return { ...e, verdict: "no" as const, edited: undefined };
    }
    return e; // 纯 skip：不动
  });
  const md = renderContextMd(questions, nextEntries, opts.titleOf, opts.tsOf);
  persist(sessionId, questions, nextEntries, md, dir);
  const parts: string[] = [];
  if (confirmed) parts.push(`确认${cnCount(confirmed)}`);
  if (removed) parts.push(`移除${cnCount(removed)}`);
  if (rewritten) parts.push(`按你的说法改写${cnCount(rewritten)}`);
  if (note) parts.push("记下你补充的背景");
  const notice = parts.length
    ? `上下文文件已按你的表态更新：第 ${opts.question} 问${parts.join("、")}${whereIs(md, opts.question, sessionId, dir)}。`
    : `上下文文件已按你的表态更新（第 ${opts.question} 问，没有变化）${whereIs(md, opts.question, sessionId, dir)}。`;
  const added = nextEntries.filter((e) => e.question === opts.question && e.verdict !== "no").length;
  return { question: opts.question, md, jsonl: rowsToJsonl(nextEntries), added, notice };
}

/** /reset 用：整个 data/context 目录清空 */
export function clearAllContext(dir = dataDir()): void {
  const p = join(dir, "context");
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- 作废（契约 v6）：会话回退后重生成上下文文件
 *
 * 那一问的小节直接去掉、后面的小节重编号成连续的「第 1..N 问」——不冒「已回退」墓碑：
 * 上下文文件是给回答模型读的，墓碑行只会污染它的阅读（用户在确认框里已看到回退发生）。
 * 别的会话上下文里若引用了被作废的 QA（跨会话召回取回的条目），那些条目也一并去掉。
 * 小节全部去掉的会话：目录整个删掉（contextQuestionCount 归零，下一问从第 1 问重新计）。 */

/** 一个会话的重生成结果（没有剩余小节时 md/jsonl 为空串） */
export interface PrunedContext {
  removedQuestions: number;
  removedEntries: number;
  /** 剩余小节数；0 = 目录已删（上下文文件不复存在） */
  remaining: number;
  md: string;
  jsonl: string;
}

/** 重生成受影响的上下文文件：turnIdsBySession = 各会话被回退的轮；hiddenQaIds = 全部被作废的 qaId。
 *  返回变过的会话 → 结果（没变的会话不在里面）。titleOf / tsOf 用全部行（含被作废的）查——
 *  标题与时间不会因为作废而变。 */
export function pruneContexts(
  dir: string,
  opts: {
    turnIdsBySession: ReadonlyMap<string, ReadonlySet<string>>;
    hiddenQaIds: ReadonlySet<string>;
    titleOf: (qaId: string) => string;
    tsOf: (qaId: string) => number;
  },
): Map<string, PrunedContext> {
  const root = join(dir, "context");
  const out = new Map<string, PrunedContext>();
  if (!existsSync(root)) return out;
  const hiddenQaIds = opts.hiddenQaIds;
  for (const name of readdirSync(root)) {
    const d = join(root, name);
    try {
      if (!existsSync(join(d, "questions.jsonl"))) continue;
      const loaded = loadContextState(name, dir); // contextDir 的目录名 = 会话 id（safe 替换后的）
      const revertTurns = opts.turnIdsBySession.get(name) ?? new Set<string>();
      const keptQuestions = loaded.questions.filter((q) => !revertTurns.has(q.turnId));
      const droppedQuestions = new Set(loaded.questions.filter((q) => revertTurns.has(q.turnId)).map((q) => q.question));
      const keptEntries0 = loaded.entries.filter((e) => !droppedQuestions.has(e.question) && !hiddenQaIds.has(e.qaId));
      const removedQuestions = loaded.questions.length - keptQuestions.length;
      const removedEntries = loaded.entries.length - keptEntries0.length;
      if (removedQuestions === 0 && removedEntries === 0) continue;
      // 重编号：去掉几问后后面的小节往前撜，保持「第 1..N 问」连续（不给回答模型留空洞）
      const renumber = new Map<number, number>();
      keptQuestions.forEach((q, i) => renumber.set(q.question, i + 1));
      const questions = keptQuestions.map((q) => ({ ...q, question: renumber.get(q.question) ?? q.question }));
      const entries = keptEntries0.map((e) => ({ ...e, question: renumber.get(e.question) ?? e.question }));
      if (questions.length === 0) {
        rmSync(d, { recursive: true, force: true });
        out.set(name, { removedQuestions, removedEntries, remaining: 0, md: "", jsonl: "" });
        continue;
      }
      const md = renderContextMd(questions, entries, opts.titleOf, opts.tsOf);
      persist(name, questions, entries, md, dir);
      out.set(name, { removedQuestions, removedEntries, remaining: questions.length, md, jsonl: rowsToJsonl(entries) });
    } catch {
      // 坏目录 / 并发删除：跳过
    }
  }
  return out;
}
