/**
 * 「用我们的服务器 · B 方案」线上协议（2026-10-10）：客户端 ↔ 召回核心之间的一次召回请求 / 结果。
 *
 * 客户端只发：提问 + 需要召回的 QA 原文（可见集已按本地口径过滤）+ 少量本地派生数据（表态、上一版
 * 上下文文件、待问队列、指代说明）。拼提示词、每岗阈值、两段打分、pads、断点全在服务端。
 * 本文件被两侧共用（客户端 src/recall-hosted.ts、服务端 src/hosted-recall-core.ts），是唯一的形状真源；
 * QA 重建必须与本地渲染一字不差（预热前缀命中依赖逐字节一致），测试有对拍。
 */
import type { AskQueueItem } from "./asks-queue.ts";
import type { ConfirmState, Review } from "./review.ts";
import { buildInjection } from "./review.ts";
import type { IntentObject } from "./types.ts";
import type { KeeperEntry } from "./types.ts";
import { INTENT_WEIGHT, type QA, type ResolvedTime, type SourceType } from "./types.ts";
import type { StageUsage } from "./usage-meter.ts";
import type { SwarmStats } from "./types.ts";
import type { ClientRecallOutcome, RecallEvent } from "./server-contract.ts";

export const WIRE_V = 1;

/** QA 的可序列化子集：渲染消息用到的字段全带；source（文件行号引用）不带 */
export interface WireQa {
  qaId: string;
  sessionId: string;
  turnIndex: number;
  tsAbs: number;
  qText: string;
  aText: string;
  /** 渲染时用的会话标题（客户端按「会话最新标题」口径解好；服务端不自己解） */
  title: string;
  sourceType: SourceType;
  qTimeResolved?: ResolvedTime[];
}

export function toWireQa(qa: QA, title: string): WireQa {
  return {
    qaId: qa.qaId,
    sessionId: qa.sessionId,
    turnIndex: qa.turnIndex,
    tsAbs: qa.tsAbs,
    qText: qa.qText,
    aText: qa.aText,
    title,
    sourceType: qa.sourceType,
    ...(qa.qTimeResolved?.length ? { qTimeResolved: qa.qTimeResolved } : {}),
  };
}

/** 线上重建的 QA：source 用占位（文件引用只在客户端有意义） */
export function wireToQa(w: WireQa): QA {
  return {
    qaId: w.qaId,
    sessionId: w.sessionId,
    turnIndex: w.turnIndex,
    prevQaId: null,
    nextQaId: null,
    tsAbs: w.tsAbs,
    qText: w.qText,
    aText: w.aText,
    qTimeResolved: w.qTimeResolved ?? [],
    sourceType: w.sourceType,
    intentWeight: INTENT_WEIGHT[w.sourceType] ?? 1,
    attachmentTypes: [],
    toolCallCount: 0,
    source: { file: "wire", lineStart: 0, lineEnd: 0 },
    shardId: w.sessionId,
  };
}

export interface WireEdgeVerdict {
  verdict: "yes" | "no" | "skip";
  edited?: string;
  statement?: string;
}

export type RecallEngine = "hosted-27b" | "deepseek-own";

export interface RecallPayloadV1 {
  v: 1;
  /** 档位（10-12）：hosted-27b（缺省）= 27B 两段打分；deepseek-own = 用户自备 key 全链路 DeepSeek 官方 */
  engine?: RecallEngine;
  sessionId: string;
  turnId: string;
  title: string;
  q: string;
  force: boolean;
  qas: WireQa[];
  /** 键 `${qaId}#${slot}` */
  edgeVerdicts: Record<string, WireEdgeVerdict>;
  /** 第 2 问起：同会话上一版上下文文件全文（守门员要用） */
  prevContextMd?: string;
  pendingAsks?: AskQueueItem[];
  /** 指代说明（hosted 现在没开，字段留作将来）；qaId → 一行说明 */
  corefNotes?: Record<string, string>;
  client?: { name?: string; version?: string };
}

export function packRecallPayload(args: {
  engine?: RecallEngine;
  sessionId: string;
  turnId: string;
  title: string;
  q: string;
  force: boolean;
  qas: QA[];
  titleOf: (sid: string) => string;
  edgeVerdicts: Map<string, ConfirmState>;
  prevContextMd?: string;
  pendingAsks?: AskQueueItem[];
  corefNotes?: Map<string, string>;
  client?: { name?: string; version?: string };
}): RecallPayloadV1 {
  return {
    v: WIRE_V,
    ...(args.engine ? { engine: args.engine } : {}),
    sessionId: args.sessionId,
    turnId: args.turnId,
    title: args.title,
    q: args.q,
    force: args.force,
    qas: args.qas.map((qa) => toWireQa(qa, args.titleOf(qa.sessionId))),
    edgeVerdicts: Object.fromEntries([...args.edgeVerdicts].map(([k, v]) => [k, { verdict: v.verdict, ...(v.edited !== undefined ? { edited: v.edited } : {}), ...(v.statement !== undefined ? { statement: v.statement } : {}) }])),
    ...(args.prevContextMd !== undefined ? { prevContextMd: args.prevContextMd } : {}),
    ...(args.pendingAsks?.length ? { pendingAsks: args.pendingAsks } : {}),
    ...(args.corefNotes?.size ? { corefNotes: Object.fromEntries(args.corefNotes) } : {}),
    ...(args.client ? { client: args.client } : {}),
  };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface UnpackedRecall {
  sessionId: string;
  turnId: string;
  title: string;
  q: string;
  force: boolean;
  qas: QA[];
  /** wire qas 的原样（预热要用 title 渲染，直接用这份，别从 QA 反推） */
  wireQas: WireQa[];
  titleOf: (sid: string) => string;
  edgeVerdicts: Map<string, ConfirmState>;
  prevContextMd: string | undefined;
  pendingAsks: AskQueueItem[];
  corefNotes: Map<string, string>;
}

export function unpackRecallPayload(raw: unknown): Parsed<UnpackedRecall> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "请求体必须是 JSON 对象" };
  const b = raw as Record<string, unknown>;
  if (b.v !== WIRE_V) return { ok: false, error: `协议版本不对（要 v${WIRE_V}）` };
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const sessionId = str(b.sessionId);
  const turnId = str(b.turnId);
  const q = str(b.q);
  if (!sessionId) return { ok: false, error: "sessionId 不能为空" };
  if (!turnId) return { ok: false, error: "turnId 不能为空" };
  if (!q.trim()) return { ok: false, error: "q 不能为空" };
  if (!Array.isArray(b.qas)) return { ok: false, error: "qas 必须是数组" };
  if (b.qas.length > 20000) return { ok: false, error: `qas 一次最多 20000 条，收到 ${b.qas.length}` };
  const wireQas: WireQa[] = [];
  const titles = new Map<string, string>();
  for (const [i, r] of (b.qas as Array<Record<string, unknown>>).entries()) {
    if (!r || typeof r !== "object") return { ok: false, error: `qas[${i}] 必须是对象` };
    const qaId = str(r.qaId);
    const sid = str(r.sessionId);
    const qText = typeof r.qText === "string" ? r.qText : "";
    const aText = typeof r.aText === "string" ? r.aText : "";
    if (!qaId || !sid) return { ok: false, error: `qas[${i}] 缺 qaId / sessionId` };
    const tsAbs = typeof r.tsAbs === "number" && Number.isFinite(r.tsAbs) ? r.tsAbs : null;
    if (tsAbs === null) return { ok: false, error: `qas[${i}].tsAbs 必须是数字` };
    const st = r.sourceType;
    if (typeof st !== "string" || !(st in INTENT_WEIGHT)) return { ok: false, error: `qas[${i}].sourceType 不认识：${String(st)}` };
    const title = str(r.title);
    if (!titles.has(sid)) titles.set(sid, title);
    let qTimeResolved: ResolvedTime[] | undefined;
    if (r.qTimeResolved !== undefined) {
      if (!Array.isArray(r.qTimeResolved)) return { ok: false, error: `qas[${i}].qTimeResolved 必须是数组` };
      qTimeResolved = (r.qTimeResolved as Array<Record<string, unknown>>).map((t) => ({ text: str(t.text), index: typeof t.index === "number" ? t.index : 0, value: str(t.value) }));
    }
    wireQas.push({
      qaId, sessionId: sid,
      turnIndex: typeof r.turnIndex === "number" ? r.turnIndex : 0,
      tsAbs, qText, aText, title,
      sourceType: st as SourceType,
      ...(qTimeResolved?.length ? { qTimeResolved } : {}),
    });
  }
  const edgeVerdicts = new Map<string, ConfirmState>();
  if (b.edgeVerdicts !== undefined) {
    if (!b.edgeVerdicts || typeof b.edgeVerdicts !== "object" || Array.isArray(b.edgeVerdicts)) return { ok: false, error: "edgeVerdicts 必须是对象" };
    for (const [k, v] of Object.entries(b.edgeVerdicts as Record<string, Record<string, unknown>>)) {
      if (!v || typeof v !== "object" || (v.verdict !== "yes" && v.verdict !== "no" && v.verdict !== "skip")) return { ok: false, error: `edgeVerdicts[${k}].verdict 必须是 yes / no / skip` };
      edgeVerdicts.set(k, {
        verdict: v.verdict as ConfirmState["verdict"],
        ...(typeof v.edited === "string" ? { edited: v.edited } : {}),
        ...(typeof v.statement === "string" ? { statement: v.statement } : {}),
      });
    }
  }
  const pendingAsks: AskQueueItem[] = [];
  if (b.pendingAsks !== undefined) {
    if (!Array.isArray(b.pendingAsks)) return { ok: false, error: "pendingAsks 必须是数组" };
    for (const [i, a] of (b.pendingAsks as Array<Record<string, unknown>>).entries()) {
      if (!a || typeof a !== "object" || typeof a.qaId !== "string" || typeof a.slot !== "number") return { ok: false, error: `pendingAsks[${i}] 缺 qaId / slot` };
      pendingAsks.push({ qaId: a.qaId, slot: a.slot, statement: str(a.statement), whyUncertain: str(a.whyUncertain), quote: str(a.quote) });
    }
  }
  if (b.prevContextMd !== undefined && typeof b.prevContextMd !== "string") return { ok: false, error: "prevContextMd 必须是字符串" };
  const corefNotes = new Map<string, string>();
  if (b.corefNotes !== undefined) {
    if (!b.corefNotes || typeof b.corefNotes !== "object" || Array.isArray(b.corefNotes)) return { ok: false, error: "corefNotes 必须是对象" };
    for (const [k, v] of Object.entries(b.corefNotes as Record<string, unknown>)) if (typeof v === "string") corefNotes.set(k, v);
  }
  return {
    ok: true,
    value: {
      sessionId, turnId, title: str(b.title), q, force: b.force === true,
      qas: wireQas.map(wireToQa),
      wireQas,
      titleOf: (sid: string) => titles.get(sid) ?? "",
      edgeVerdicts,
      prevContextMd: b.prevContextMd as string | undefined,
      pendingAsks,
      corefNotes,
    },
  };
}

/** 预热请求体：同一份 WireQa；scope 全量或按会话 */
export interface PrewarmPayloadV1 {
  v: 1;
  qas: WireQa[];
  scope: "full" | { sessionIds: string[] };
}

export function packPrewarmPayload(qas: QA[], titleOf: (sid: string) => string, scope: "full" | { sessionIds: string[] }): PrewarmPayloadV1 {
  return { v: WIRE_V, qas: qas.map((qa) => toWireQa(qa, titleOf(qa.sessionId))), scope };
}

export function unpackPrewarmPayload(raw: unknown): Parsed<{ wireQas: WireQa[]; qas: QA[]; titleOf: (sid: string) => string; sessionIds: Set<string> | null }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "请求体必须是 JSON 对象" };
  const b = raw as Record<string, unknown>;
  if (b.v !== WIRE_V) return { ok: false, error: `协议版本不对（要 v${WIRE_V}）` };
  const probe = unpackRecallPayload({ ...b, v: WIRE_V, sessionId: "prewarm", turnId: "prewarm", q: "prewarm", title: "", force: false });
  if (!probe.ok) return probe;
  let sessionIds: Set<string> | null = null;
  if (b.scope === "full") sessionIds = null;
  else if (b.scope && typeof b.scope === "object" && Array.isArray((b.scope as Record<string, unknown>).sessionIds)) {
    sessionIds = new Set(((b.scope as { sessionIds: unknown[] }).sessionIds).filter((s): s is string => typeof s === "string" && !!s));
  } else return { ok: false, error: 'scope 必须是 "full" 或 { sessionIds: [...] }' };
  return { ok: true, value: { wireQas: probe.value.wireQas, qas: probe.value.qas, titleOf: probe.value.titleOf, sessionIds } };
}

/** 核心回给客户端的一次召回结果：客户端拿它在本地做全部后处理（注入块 / 上下文文件 / 边 / 队列） */
export interface RecallResultV1 {
  intent: IntentObject;
  review: Review;
  keeper: {
    selected: KeeperEntry[];
    asksFinal: AskQueueItem[];
    overflow: AskQueueItem[];
    askRemaining: number;
    missing: string | null;
    dupGroups: number;
    dedup: { before: number; after: number };
    humanFallbacks: number;
  } | null;
  /** 过线的 QA（至少一岗 ≥ pass 线）与它的六岗分——客户端据此回写 s3 边；**没过线的不发**（省流量） */
  s3Passed: Array<{ qaId: string; scores: Array<number | null> }>;
  timing: { totalMs: number; s1Ms: number; s3Ms: number; s4Ms: number; s4PromptTokens: number };
  usage: Record<string, StageUsage>;
  resumed?: { intent: boolean; scores: number; reasons: number };
  s3Stats?: SwarmStats & { qaPassed?: number };
  edgeDropped?: number;
}

export function packRecallResult(outcome: ClientRecallOutcome, passed: Array<{ qaId: string; scores: Array<number | null> }>): RecallResultV1 {
  return {
    intent: outcome.intent,
    review: outcome.review,
    keeper: outcome.keeper
      ? {
          selected: outcome.keeper.selected,
          asksFinal: outcome.keeper.asksFinal,
          overflow: outcome.keeper.overflow,
          askRemaining: outcome.keeper.askRemaining,
          missing: outcome.keeper.missing,
          dupGroups: outcome.keeper.dupGroups,
          dedup: outcome.keeper.dedup,
          humanFallbacks: outcome.keeper.humanFallbacks,
        }
      : null,
    s3Passed: passed,
    timing: outcome.timing,
    usage: outcome.usage,
    ...(outcome.resumed ? { resumed: outcome.resumed } : {}),
    ...(outcome.s3Stats ? { s3Stats: outcome.s3Stats } : {}),
    ...(outcome.edgeDropped ? { edgeDropped: outcome.edgeDropped } : {}),
  };
}

export function unpackRecallResult(raw: unknown): Parsed<RecallResultV1> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "result 必须是对象" };
  const r = raw as Record<string, unknown>;
  if (!r.intent || typeof r.intent !== "object") return { ok: false, error: "result.intent 缺失" };
  if (!r.review || typeof r.review !== "object") return { ok: false, error: "result.review 缺失" };
  if (!Array.isArray(r.s3Passed)) return { ok: false, error: "result.s3Passed 必须是数组" };
  if (!r.timing || typeof r.timing !== "object") return { ok: false, error: "result.timing 缺失" };
  // 细节字段（keeper / usage / resumed）形状由后续使用方自然暴露；这里只挡结构级错误
  return { ok: true, value: raw as RecallResultV1 };
}

/** 客户端侧：远端 result + 本地数据 → 与本地管线同形的 RecallOutcome（bids 留空：ask 摘句走 keeper.asksFinal） */
export function outcomeFromResult(
  result: RecallResultV1,
  qaById: Map<string, QA>,
  titleOf: (sid: string) => string,
  injectedBefore: Set<string>,
): ClientRecallOutcome {
  return {
    intent: result.intent,
    review: result.review,
    bids: [],
    injection: buildInjection(result.review, qaById, titleOf, new Map(), undefined, injectedBefore),
    retried: false,
    dropped: [],
    timing: result.timing,
    s3Stats: result.s3Stats ?? {
      qaTotal: 0, batches: 0, failedBatches: 0, qaPassed: 0, passRate: 0, bidsBySlot: {}, gateRejected: 0, rejectReasons: {}, repairReasons: {}, truncRetried: 0,
      promptTokens: 0, completionTokens: 0, cachedTokens: 0, wallMs: result.timing.s3Ms, callMsP50: 0, callMsP95: 0, callAttempts: 0, failedCalls: 0,
      scoreMs: 0, reasonMs: 0, segments: 0,
    },
    s3Scores: result.s3Passed,
    usage: result.usage ?? {},
    runDir: "",
    keeper: result.keeper ?? undefined,
    edgeDropped: result.edgeDropped ?? 0,
    ...(result.resumed ? { resumed: result.resumed } : {}),
  };
}

/** 召回核心的事件流：与本地 /recall 的契约事件同形，只有 done 换成带 result（注入块 / 上下文文件在客户端重建）。
 *  客户端逐条转发其余事件，收到 done 再做本地后处理——插件与管理页看到的流与本地版一字不差 */
export type CoreRecallEvent =
  | RecallEvent
  | { type: "done"; runId: string; result: RecallResultV1; gateMs: number; timing: RecallResultV1["timing"]; engine?: RecallEngine }
  | { type: "done"; runId: string; skipped: "gate"; gateWhy: string; timing: { totalMs: number; gateMs: number; s1Ms: number; s3Ms: number; s4Ms: number }; engine?: RecallEngine };
