/**
 * intent-lab HTTP 服务（给 Orbita Tier B 钩子）：bun run serve。
 *
 * 契约见 src/server-contract.ts（v1）。只监听 127.0.0.1，端口 INTENT_LAB_PORT 或 8723。
 *   GET  /health   服务与配置概览
 *   POST /recall   NDJSON 事件流（accepted → stage/intent/progress… → review → done/error）
 *   POST /feedback 确认卡表态 → 写边 + 按表态重建注入块
 *   POST /ingest   Orbita 的一轮问答入库（qa-orbita.jsonl，与 qa.jsonl 合并加载）
 *
 * 行为要点：
 *   - 客户端断开 = 取消：2 秒内中止全部在飞模型请求、不再派发新请求（signal 贯穿 llm/pool）。
 *   - 同一 sessionId 新的 recall 到来：先取消旧的（旧流收到一条 error）再跑新的。
 *   - 服务端不拦高峰（peakGuard 只在命令行生效），peak 只是提示字段。
 *   - INTENT_LAB_SAMPLE=N：只取前 N 条可见 QA 面试，开发冒烟用（只对服务进程生效）。
 */
import { configPath, endpointModeOf, hostedRecallServer, HOSTED_DEFAULT_MODEL, HOSTED_S4_DEFAULT_MODEL, hostedAuthBase, hostedGrantPath, loadConfig, loadHostedGrant, parseHostedLimits, parseHostedModels, parseHostedRecallMode, setLiveHostedLimits, setLiveHostedModels, setLiveHostedRecallMode, usable, type HostedGrant } from "./config.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { appendEdge, edgeVerdicts, loadEdges, type EdgeRow } from "./edges.ts";
import { historySource, titleOfSource, visibleQAs } from "./history.ts";
import { loadRecallLog, observeRecallEvent } from "./recall-log.ts";
import {
  currentJob, listSessionFiles, LOCAL_SOURCES, loadLocalState, localHiddenSessions, scanSource, sourceOfSession, sourceRoot, startLocalImport, updateLocalState,
  summarizeSessions, type LocalRow, type LocalSourceId, type SessionSummary,
} from "./local-sources.ts";
export { historySource } from "./history.ts";
import {
  appendImportedQa, appendInjected, appendIntent, appendOrbitaQa, loadImportedQAs, loadInjectedBySession, loadOrbitaQAs,
  loadPrevIntents, mergeOrbitaQAs, orbitaQaId, orbitaSeenKeys, contentIndex, contentKey, qaJsonlContentIndex, type OrbitaQaRow,
} from "./orbita-store.ts";
import { appendInvalidated, dropInvalidated, invalidateKey, invalidatedPairs, invalidatedQaCounts, loadInvalidated, type InvalidatedRow } from "./invalidation.ts";
import { padCoverageFromKeys } from "./segment.ts";
import { namedEndpointsOf, parseModelsField, s3PlanOf, s3PresetsOf } from "./models-override.ts";
import { buildInjection, confirmedKeysOf, type ConfirmState, type Review } from "./review.ts";
import { loadAskQueue, saveAskQueue, clearAskQueue, type AskQueueItem } from "./asks-queue.ts";
import { appendQuestion, applyFeedbackToContext, clearAllContext, contextDir, contextQuestionCount, loadContextMd, pruneContexts, rowsToJsonl, loadContextState } from "./context-file.ts";
import { clearAllCheckpoints, clearCheckpointsFor, type RecallCheckpoint } from "./checkpoint.ts";
import { clearAllPendingRuns, deletePendingRun, deletePendingRunsFor, loadPendingRun, prunePendingRuns, savePendingRun, type PersistedRun } from "./pending-runs.ts";
import {
  CLOSING_SCAN_PROMPT,
  type ClientRecallOutcome,
  DEFAULT_PORT,
  fmtShort,
  type AskView,
  type ContextFileV32,
  type FeedbackRequest,
  type ImportResponse,
  type IngestRequest,
  type InvalidateRequest,
  type InvalidateResponse,
  type RecallEvent,
  type RecallRequest,
  type ResetResponse,
  type S3Preset,
  type SelectedViewV32,
} from "./server-contract.ts";
import { dataDir } from "./store.ts";
import type { QA } from "./types.ts";
import type { StageUsage, UsageMeter } from "./usage-meter.ts";
import { HostedRecallError, remotePadsEntries, remotePrewarmStart, remotePrewarmStatus, remotePrewarmStop, remoteUserKeyDelete, remoteUserKeyPut, remoteUserKeyStatus, runHostedRecall, type RemotePrewarmMirror } from "./recall-hosted.ts";
import type { RecallEngine } from "./hosted-wire.ts";

import { slotNameOf, type IntentObject } from "./types.ts";
const slotName = slotNameOf; // 岗名渲染（名字在 types.ts；打分细则不在这棵树）

/** DeepSeek 官方高峰：北京时间周一至周五 9:00–12:00、14:00–18:00（节假日不识别；只提示不拦） */
export function isDeepSeekPeak(now = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3_600_000); // 用 UTC 读数代表北京时间
  const day = bj.getUTCDay();
  const h = bj.getUTCHours();
  if (day === 0 || day === 6) return false;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 解析 INTENT_LAB_ASOF：毫秒时间戳，或带时区的 ISO 8601（如 2026-09-08T21:49:42.755+08:00）。
 *  不合法直接抛错——启动时让它炸出去，不要静默忽略 */
export function parseAsOfEnv(v: string): number {
  if (/^\d{10,}$/.test(v.trim())) {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  const t = Date.parse(v.trim());
  // 至少要有「年份-」形态，避免 "123" 这类短数字串被当成公元 123 年
  if (!Number.isNaN(t) && /^-?\d{4,}-/.test(v.trim())) return t;
  throw new Error(`INTENT_LAB_ASOF 不是合法的毫秒时间戳或 ISO 8601 时间：${v}`);
}

/** 历史来源：orbita（新默认）= 只用 /import 与 /ingest 存进来的 QA；proma = 旧版读 data/qa.jsonl（实现在 src/history.ts，与预热脚本共用） */

/** 服务进程的缺省历史截止：请求里自己带了 asOf 就以请求为准（Orbita 还没有入口，先用环境变量钉住） */
export function asOfFromEnv(): number | undefined {
  const v = process.env.INTENT_LAB_ASOF;
  if (!v) return undefined;
  return parseAsOfEnv(v);
}

// ---------- 持久层（懒加载单例；测试先设 INTENT_LAB_DATA / INTENT_LAB_CONFIG 再触发） ----------

interface Persisted {
  edgeRows: EdgeRow[];
  verdicts: Map<string, ConfirmState>;
  /** 每会话上一轮意图（v3 起 S1 不再读，仅供将来诊断重放；intents.jsonl 照记） */
  prevIntents: Map<string, IntentObject>;
  injectedBySession: Map<string, Set<string>>;
  /** /ingest 存的（聊天中路 2） */
  orbitaRows: OrbitaQaRow[];
  /** /import 存的（迁移路 1，契约 v2） */
  importRows: OrbitaQaRow[];
  /** v6 作废记录（data/orbita/invalidated.jsonl，只追加） */
  invalidated: InvalidatedRow[];
}

let persisted: Persisted | null = null;

export function state(): Persisted {
  if (!persisted) {
    const edgeRows = loadEdges();
    persisted = {
      edgeRows,
      verdicts: edgeVerdicts(edgeRows),
      prevIntents: loadPrevIntents(),
      injectedBySession: loadInjectedBySession(),
      orbitaRows: loadOrbitaQAs(),
      importRows: loadImportedQAs(),
      invalidated: loadInvalidated(),
    };
  }
  return persisted;
}

/** asOf 实验用的边过滤：只用这一刻之前产生的，外加本会话自己点的（否则考试会话点过的确认卡下一轮又会问） */
export function filterEdgeRows(rows: EdgeRow[], asOf: number, sessionId: string): EdgeRow[] {
  return rows.filter((r) => r.ts <= asOf || r.sessionId === sessionId);
}

export function verdictsFor(asOf: number | undefined, sessionId: string): Map<string, ConfirmState> {
  const st = state();
  if (asOf == null) return st.verdicts;
  return edgeVerdicts(filterEdgeRows(st.edgeRows, asOf, sessionId));
}

/** 测试里换数据目录后重置单例用 */
export function resetPersisted(): void {
  persisted = null;
}

/** 测试用：清空内存里的 run，模拟服务重启（09-29 等表态的 run 落盘） */
export function forgetRunsForTest(): void {
  runs.clear();
}

/** 档位（10-12「自己配置：DeepSeek 官方」）：hosted-27b（缺省）/ deepseek-own；存在 config.json 顶层 hostedEngine */
export function hostedEngineOf(): RecallEngine {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as { hostedEngine?: unknown };
    return raw.hostedEngine === "deepseek-own" ? "deepseek-own" : "hosted-27b";
  } catch {
    return "hosted-27b";
  }
}
function writeHostedEngine(engine: RecallEngine): void {
  const p = configPath();
  const cur = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
  if (engine === "hosted-27b") delete cur.hostedEngine;
  else cur.hostedEngine = engine;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
}

// ---------- 召回驱动（可插拔，2026-10-11）----------
// 本地编排（own 端点 / hosted-client 模式）住在私有树的 src/recall-local.ts，由入口 src/server.ts 注册；
// 公开客户端树（intent-system）不带它——那边只剩「用我们的服务器」的 hosted 代理，方法不下发。
export interface LocalDriver {
  handleRecall(req: Request, body: RecallRequest): Promise<Response>;
  /** /health 的本地口径（own / hosted-client 各自判）；hosted-server 不走这里 */
  health(): { ok: boolean; error?: string };
  /** /health 与 /local/config 的蜂群展示口径（端点名 / 模型 / 预算 / 并发） */
  swarmView(): { endpoint: string; model: string; budgetMs: number; concurrency: number };
  /** 本地预热目标（B 方案端点）；null = 不需要预热 */
  prewarmTarget(): unknown | null;
  startPrewarmJob(reason: string): void;
  schedulePrewarm(rows: OrbitaQaRow[]): void;
  prewarmStatus(): Promise<Response>;
  abortPrewarm(): void;
  corefStep(onlyQaIds?: string[]): Promise<void>;
  shadowCorefForUpdate(olds: readonly OrbitaQaRow[]): void;
  startSweep(): void;
}
let localDriver: LocalDriver | null = null;
export function registerLocalDriver(d: LocalDriver): void {
  localDriver = d;
}
export function getLocalDriver(): LocalDriver | null {
  return localDriver;
}

/** 入库后要不要预热 / 补说明：hosted 走远端核心，本地编排走驱动（私有树）；都没有就什么都不做 */
function schedulePrewarm(rows: OrbitaQaRow[]): void {
  if (!rows.length) return;
  if (hostedRecallServer()) {
    const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
    chainPrewarm(() => remotePrewarmOnce(`增量同步 ${sessionIds.length} 个会话`, { sessionIds }), (err) =>
      console.log(`[prewarm] 远端增量预热失败（不影响入库）：${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  localDriver?.schedulePrewarm(rows);
}

// ---------- run 状态 ----------

export interface ActiveRun {
  controller: AbortController;
  finished: Promise<void>;
  /** 被同会话的新请求抢占（区别于客户端自己断开） */
  preempted: boolean;
  /** 被取消的原因（发给旧流的 error message 用：抢占 / 数据重置要区分开） */
  cancelReason: "preempt" | "reset" | null;
  done: boolean;
}

export const activeBySession = new Map<string, ActiveRun>();

interface RunState {
  runId: string;
  sessionId: string;
  turnId: string;
  q: string;
  review: Review;
  bids: Array<{ qaId: string; slot: number }>;
  qaById: Map<string, QA>;
  titleOf: (sid: string) => string;
  injectedBefore: Set<string>;
  createdAt: number;
  askItems: Map<string, AskQueueItem>; // askId → 确认项（带 quote：队列项的摘句不在本轮 bids 里）
  /** v3.2 §四：该 run 是会话的第几问（/feedback 改写上下文文件用） */
  contextQuestion: number;
  /** 这一问的断点目录：表态成功后删（09-29） */
  checkpointDir?: string;
}

/** 服务重启后从磁盘恢复等表态的 run：qaById / titleOf 按当前数据重建（09-29） */
async function restoreRun(p: PersistedRun): Promise<RunState> {
  const { qas } = await visibleQAsFor(undefined, p.sessionId);
  return {
    runId: p.runId,
    sessionId: p.sessionId,
    turnId: p.turnId,
    q: p.q,
    review: p.review,
    bids: [],
    qaById: new Map(qas.map((x) => [x.qaId, x])),
    titleOf: await titleOfNow(),
    injectedBefore: new Set(p.injectedBefore),
    createdAt: p.createdAt,
    askItems: new Map(p.askItems),
    contextQuestion: p.contextQuestion,
    ...(p.checkpointDir ? { checkpointDir: p.checkpointDir } : {}),
  };
}

const runs = new Map<string, RunState>(); // 插入序 = 时间序
const MAX_RUNS = 200;
const RUN_TTL_MS = 24 * 3_600_000;

function rememberRun(s: RunState): void {
  runs.set(s.runId, s);
  const now = Date.now();
  for (const [id, r] of runs) {
    if (runs.size <= MAX_RUNS && now - r.createdAt < RUN_TTL_MS) break;
    runs.delete(id);
  }
}

// ---------- 可见范围（加载逻辑在 src/history.ts，与 scripts/s3b-prewarm.ts 共用同一份） ----------

function rowsOf(): { importRows: OrbitaQaRow[]; orbitaRows: OrbitaQaRow[] } {
  const st = state();
  return { importRows: st.importRows, orbitaRows: st.orbitaRows };
}

export async function visibleQAsFor(asOf?: number, sessionId?: string): Promise<{ qas: QA[]; note: string }> {
  const sample = Number(process.env.INTENT_LAB_SAMPLE ?? 0);
  return visibleQAs(
    { asOf, sessionId, sample: sample > 0 ? sample : undefined, invalidated: state().invalidated },
    historySource() === "orbita" ? rowsOf() : undefined,
  );
}

export async function titleOfNow(): Promise<(sid: string) => string> {
  return titleOfSource(rowsOf());
}

export function newRunId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 请求体校验 ----------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseRecallRequest(body: unknown): Parsed<RecallRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "请求体必须是 JSON 对象" };
  const b = body as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const sessionId = str(b.sessionId);
  const turnId = str(b.turnId);
  const q = str(b.q);
  if (!sessionId) return { ok: false, error: "sessionId 不能为空" };
  if (!turnId) return { ok: false, error: "turnId 不能为空" };
  if (!q.trim()) return { ok: false, error: "q 不能为空" };
  // v3：recent 一律忽略（不报错）——本会话的上下文归主模型管
  let asOf: number | undefined;
  if (b.asOf !== undefined) {
    if (typeof b.asOf !== "number" || !Number.isFinite(b.asOf)) return { ok: false, error: "asOf 必须是毫秒时间戳数字" };
    asOf = b.asOf;
  }
  const force = b.force === true;
  // 10-08：S3 并发与时长上限（夹在端点范围内，见 /recall 落地处）；undefined = 没带，null = 带了但不足数字
  const num = (k: string): number | null | undefined => { const v = b[k]; if (v === undefined) return undefined; return typeof v === "number" && Number.isFinite(v) ? v : null; };
  const concurrency = num("concurrency");
  if (concurrency === null) return { ok: false, error: "concurrency 必须是数字" };
  const reasonConcurrency = num("reasonConcurrency");
  if (reasonConcurrency === null) return { ok: false, error: "reasonConcurrency 必须是数字" };
  const budgetMs = num("budgetMs");
  if (budgetMs === null) return { ok: false, error: "budgetMs 必须是数字" };
  // 契约 v5：请求级模型选择（gate / s1 / s4 / s3 预设）；形状错 → 400，端点名存不存在在落地时判
  const models = parseModelsField(b.models);
  if (!models.ok) return { ok: false, error: models.error };
  return { ok: true, value: { sessionId, turnId, title: str(b.title), q, force, asOf, ...(models.value ? { models: models.value } : {}), ...(concurrency !== undefined ? { concurrency } : {}), ...(reasonConcurrency !== undefined ? { reasonConcurrency } : {}), ...(budgetMs !== undefined ? { budgetMs } : {}) } };
}

function parseFeedbackRequest(body: unknown): Parsed<FeedbackRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "请求体必须是 JSON 对象" };
  const b = body as Record<string, unknown>;
  if (typeof b.runId !== "string" || !b.runId) return { ok: false, error: "runId 不能为空" };
  if (!Array.isArray(b.answers)) return { ok: false, error: "answers 必须是数组" };
  const answers: FeedbackRequest["answers"] = [];
  for (const a of b.answers as Array<Record<string, unknown>>) {
    if (!a || typeof a !== "object") return { ok: false, error: "answers 每项必须是对象" };
    if (typeof a.askId !== "string" || !a.askId) return { ok: false, error: "answers[].askId 不能为空" };
    if (a.verdict !== "yes" && a.verdict !== "no" && a.verdict !== "skip") {
      return { ok: false, error: "answers[].verdict 必须是 yes / no / skip" };
    }
    if (a.edited !== undefined && typeof a.edited !== "string") return { ok: false, error: "answers[].edited 必须是字符串" };
    answers.push({ askId: a.askId, verdict: a.verdict, edited: a.edited as string | undefined });
  }
  if (b.note !== undefined && typeof b.note !== "string") return { ok: false, error: "note 必须是字符串" };
  return { ok: true, value: { runId: b.runId, answers, note: b.note as string | undefined } };
}

function parseIngestRequest(body: unknown): Parsed<IngestRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "请求体必须是 JSON 对象" };
  const b = body as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const sessionId = str(b.sessionId);
  const turnId = str(b.turnId);
  const q = str(b.q);
  if (!sessionId) return { ok: false, error: "sessionId 不能为空" };
  if (!turnId) return { ok: false, error: "turnId 不能为空" };
  if (!q?.trim()) return { ok: false, error: "q 不能为空" };
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts)) return { ok: false, error: "ts 必须是毫秒时间戳数字" };
  // v6：机器提问标记（现在只有收尾扫描）；别的值当没带
  const kind = b.kind === "closing-scan" ? ("closing-scan" as const) : undefined;
  return { ok: true, value: { sessionId, turnId, title: str(b.title) ?? "", q, a: str(b.a) ?? "", ts: b.ts, ...(kind ? { kind } : {}) } };
}

export const jsonError = (status: number, error: string): Response => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** v6：收尾扫描的机器提问不入库——kind 标记（新 Orbita 兑底送来时）或与同步常量同文（旧 Orbita 漏拦时） */
function isClosingScan(row: { q: string; kind?: "closing-scan" }): boolean {
  return row.kind === "closing-scan" || row.q.trim() === CLOSING_SCAN_PROMPT.trim();
}

// ---------- 事件流渲染 ----------

/** v3.2 §三：selected 每条 = 守门员的一个入选 (qaId, 岗)；ask 的 quote 优先用待问队列里存的（队列项不一定在本轮 bids 里） */
function renderViews(outcome: ClientRecallOutcome, qaById: Map<string, QA>, titleOf: (sid: string) => string): { selected: SelectedViewV32[]; ask: AskView[] } {
  const { review, keeper } = outcome;
  const selected: SelectedViewV32[] = (keeper?.selected ?? []).map((e) => {
    const qa = qaById.get(e.qaId);
    return {
      qaId: e.qaId,
      when: qa ? fmtShort(qa.tsAbs) : "",
      title: qa ? titleOf(qa.sessionId) : "",
      slots: [slotName(e.slot)],
      why: e.connection,
      pending: review.ask.some((a) => a.qaId === e.qaId),
      score: e.score,
      human: e.human,
      assistant: e.assistant,
      connection: e.connection,
      prediction: e.prediction,
      dupCount: e.dupCount,
    };
  });
  const quoteOf = new Map((keeper?.asksFinal ?? []).map((a) => [`${a.qaId}#${a.slot}`, a.quote] as const));
  const ask = review.ask.map((a, i) => {
    const qa = qaById.get(a.qaId);
    return {
      askId: `a${i + 1}`,
      qaId: a.qaId,
      slot: slotName(a.slot),
      statement: a.statement,
      quote: quoteOf.get(`${a.qaId}#${a.slot}`) ?? "",
      when: qa ? fmtShort(qa.tsAbs) : "",
      title: qa ? titleOf(qa.sessionId) : "",
      whyUncertain: a.whyUncertain,
    };
  });
  return { selected, ask };
}

/** 实际注入的 qaId：被选中的岗全部被否认才不算（与 buildInjection 的丢弃规则一致） */
function injectedQaIds(review: Review, confirms: Map<string, ConfirmState>): string[] {
  return review.selected
    .filter((s) => !(s.slots.length > 0 && s.slots.every((slot) => confirms.get(`${s.qaId}#${slot}`)?.verdict === "no")))
    .map((s) => s.qaId);
}

function recordInjected(runId: string, sessionId: string, qaIds: string[]): void {
  if (!qaIds.length) return;
  appendInjected({ ts: Date.now(), runId, sessionId, qaIds });
  const set = state().injectedBySession.get(sessionId) ?? new Set<string>();
  for (const id of qaIds) set.add(id);
  state().injectedBySession.set(sessionId, set);
}

// ---------- 召回收尾（本地管线与 hosted 远端共用：单一代码源，不分叉） ----------

/** 注入块末尾带一行指引：本会话完整历史上下文在哪个文件（回答模型可用 read 工具读，Orbita 附件模式同款思路） */
function withContextGuide(injection: string, sessionId: string): string {
  if (!injection) return injection;
  return `${injection}\n\n本会话完整的历史上下文见 ${join(contextDir(sessionId), "context.md")}，需要时用 read 工具读取。`;
}

/** token 账的一行摘要（本地管线用 UsageMeter.line()，hosted 用远端回的 usage 拼一个同形状） */
function usageLine(usage: Record<string, StageUsage>): string {
  return Object.entries(usage).map(([k, u]) => `${k}:${u.promptTokens}+${u.completionTokens}${u.cachedTokens ? `(${u.cachedTokens}缓存)` : ""}`).join(" ") || "无";
}

/** 门卫跳过：gate.json 诊断 + done(skipped:"gate")。本地与 hosted 共用 */
export function finishGateSkip(args: { send: (e: RecallEvent) => void; runId: string; body: RecallRequest; gate: { needIntent: boolean; why: string; forced: boolean; ms: number }; startedAt: number }): void {
  const { send, runId, body, gate, startedAt } = args;
  const gateDir = join(dataDir(), "runs", `recall-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(join(gateDir, "gate.json"), JSON.stringify({ runId, sessionId: body.sessionId, turnId: body.turnId, qChars: body.q.length, ...gate, ts: Date.now() }, null, 2));
  send({
    type: "done", runId, injection: "", needsFeedback: false,
    skipped: "gate", gateWhy: gate.why,
    timing: { totalMs: Date.now() - startedAt, gateMs: gate.ms, s1Ms: 0, s3Ms: 0, s4Ms: 0 },
  });
  console.log(`[run] ${runId} gate-skipped：qChars=${body.q.length} gateMs=${gate.ms}`);
}

/** 召回走完后的全部后处理：review 事件 → 上下文文件 → s3 边 → done 事件 → 待问队列 → run 记录 / 落盘。
 *  s3Pass：这条 QA 的六岗分算不算「有关」（本地 = 按端点阈值；hosted = 远端已按阈值筛过的集合）。
 *  checkpoint / meter 只在本地管线有（hosted 的断点在核心内存里，token 账由远端 usage 回来）。 */
export async function finishRecallRun(args: {
  outcome: ClientRecallOutcome;
  send: (e: RecallEvent) => void;
  runId: string;
  body: RecallRequest;
  qas: QA[];
  titleOf: (sid: string) => string;
  queueMap: Record<string, AskQueueItem[]>;
  gateMs: number;
  s3Pass: (s: { qaId: string; scores: Array<number | null> }) => boolean;
  checkpoint?: RecallCheckpoint;
  meter?: UsageMeter;
}): Promise<void> {
  const { outcome, send, runId, body, qas, titleOf, queueMap, gateMs, s3Pass, checkpoint, meter } = args;
  const qaByIdAll = new Map(qas.map((x) => [x.qaId, x]));
  const { selected, ask } = renderViews(outcome, qaByIdAll, titleOf);
  send({
    type: "review",
    summary: outcome.review.summary,
    selected,
    ask,
    askRemaining: outcome.keeper?.askRemaining ?? 0,
    ...(outcome.keeper?.dedup ? { dedup: outcome.keeper.dedup } : {}),
    ...(outcome.review.missing ? { missing: outcome.review.missing } : {}),
    retried: false,
  });
  // v3.2 §四 + v3.3：正常 done 追加「第 N 问」一节，回写边后 done 事件带全文与 edgesWritten
  const contextView = appendQuestion(
    body.sessionId,
    {
      turnId: body.turnId,
      ts: Date.now(),
      scene: outcome.intent.scene,
      want: outcome.intent.want,
      q: body.q,
      entries: outcome.keeper?.selected ?? [],
      verdicts: state().verdicts,
      titleOf: (qaId) => { const qa = qaByIdAll.get(qaId); return qa ? titleOf(qa.sessionId) : ""; },
      tsOf: (qaId) => qaByIdAll.get(qaId)?.tsAbs ?? 0,
    },
  );
  // v3.2 §六：done 时对「有关」QA 写六岗 verdict=null、source="s3" 的边；边只追加不改。
  //  挪在 send 之前：done.edgesWritten 要带回写计数；过线判定由 s3Pass 给（本地阈值 / 远端已筛）
  let s3Edges = 0;
  for (const s of outcome.s3Scores) {
    if (!s3Pass(s)) continue;
    for (let slot = 1; slot <= 6; slot++) {
      const row: EdgeRow = {
        ts: Date.now(), runId, sessionId: body.sessionId, turnId: body.turnId,
        qaId: s.qaId, slot, score: s.scores[slot - 1] ?? 0, verdict: null, statement: "", source: "s3",
      };
      appendEdge(row);
      state().edgeRows.push(row);
      s3Edges++;
    }
  }
  send({
    type: "done",
    runId,
    injection: withContextGuide(outcome.injection, body.sessionId),
    needsFeedback: outcome.review.ask.length > 0,
    context: contextView,
    edgesWritten: s3Edges,
    timing: { totalMs: outcome.timing.totalMs, gateMs, s1Ms: outcome.timing.s1Ms, s3Ms: outcome.timing.s3Ms, s4Ms: outcome.timing.s4Ms },
  });

  // 只有 done 的 run 才记上一轮意图（供该会话下一轮 S1 的 prev）
  state().prevIntents.set(body.sessionId, outcome.intent);
  appendIntent({ ts: Date.now(), runId, sessionId: body.sessionId, intent: outcome.intent });
  // v3.2 §三：待问队列更新——本轮问过的移除（skip 算问过、不追问），没问完的存回；下次同会话先问剩下的
  if (outcome.keeper) {
    const askedKeys = new Set(outcome.keeper.asksFinal.map((a) => `${a.qaId}#${a.slot}`));
    const rest = (queueMap[body.sessionId] ?? []).filter((a) => !askedKeys.has(`${a.qaId}#${a.slot}`));
    const restKeys = new Set(rest.map((a) => `${a.qaId}#${a.slot}`));
    queueMap[body.sessionId] = [...rest, ...outcome.keeper.overflow.filter((a) => !restKeys.has(`${a.qaId}#${a.slot}`))];
    saveAskQueue(queueMap);
  }
  if (outcome.review.ask.length === 0) recordInjected(runId, body.sessionId, injectedQaIds(outcome.review, new Map()));
  rememberRun({
    runId,
    sessionId: body.sessionId,
    turnId: body.turnId,
    q: body.q,
    review: outcome.review,
    bids: outcome.bids,
    qaById: qaByIdAll,
    titleOf,
    injectedBefore: state().injectedBySession.get(body.sessionId) ?? new Set<string>(),
    createdAt: Date.now(),
    askItems: new Map((outcome.keeper?.asksFinal ?? []).map((a, i) => [`a${i + 1}`, a] as const)),
    contextQuestion: contextView.question,
    ...(checkpoint ? { checkpointDir: checkpoint.dir } : {}),
  });
  console.log(`[run] ${runId} tokens：${meter ? meter.line() : usageLine(outcome.usage)}`);
  // 09-29：要表态的 run 落盘（服务重启后 /feedback 仍能用），断点留到表态成功；不用表态的这轮就完了，删断点
  if (outcome.review.ask.length > 0) {
    const r = runs.get(runId)!;
    savePendingRun({
      runId, sessionId: r.sessionId, turnId: r.turnId, q: r.q, review: r.review,
      askItems: [...r.askItems], injectedBefore: [...r.injectedBefore], createdAt: r.createdAt,
      contextQuestion: r.contextQuestion, checkpointDir: checkpoint?.dir,
    });
  } else {
    checkpoint?.clear();
  }
  console.log(`[run] ${runId} done：qa=${qas.length} s3passed=${outcome.s3Stats.qaPassed} selected=${outcome.review.selected.length} ask=${outcome.review.ask.length} context=第${contextView.question}问+${contextView.added}条 s3edges=${s3Edges} totalMs=${outcome.timing.totalMs}${outcome.resumed && (outcome.resumed.intent || outcome.resumed.scores) ? ` resumed=intent:${outcome.resumed.intent}/scores:${outcome.resumed.scores}/reasons:${outcome.resumed.reasons}` : ""}${outcome.s3Stats.twoStage ? ` twoStage=复试段${outcome.s3Stats.twoStage.rescoreSegments}/复用${outcome.s3Stats.twoStage.rescoreResumed}` : ""}`);
}

// ---------- /recall ----------

async function handleRecall(req: Request, raw: unknown): Promise<Response> {
  const parsed = parseRecallRequest(raw);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const body = parsed.value;
  await refreshHostedLimits(); // 用我们的服务器：并发 / 模型名 / 编排模式按服务器下发的（最多等 3 秒，拿不到用上一次的）
  // 10-10 B 方案：服务器说编排在服务端（recallMode=server）→ 走召回核心代理，本地只发提问 + QA 原文
  if (hostedRecallServer()) return handleRecallHosted(req, body);
  // 本地编排（own 端点 / hosted 但服务器还没说 server）：私有树的 recall-local 驱动；公开树没有 → 只能用我们的服务器
  if (!localDriver) return jsonError(501, "这个版本只支持「用我们的服务器」：在管理页「设置」里输邀请码激活后再用");
  return localDriver.handleRecall(req, body);
}
// ---------- /recall · hosted（编排在服务端，B 方案 10-10）：代理召回核心 + 本地后处理 ----------

/**
 * 服务器 recallMode=server 时走这里：把「提问 + QA 原文 + 本地派生数据」发给召回核心，逐条转发它的事件流；
 * 核心的 done（带 result）回来后用本地数据做完与本地管线完全相同的后处理（finishRecallRun / finishGateSkip 共用）。
 * /feedback、上下文文件、边、待问队列全部照旧在本地——插件与管理页看到的 8723 流不变。
 */
export async function handleRecallHosted(req: Request, body: RecallRequest): Promise<Response> {
  const grant = loadHostedGrant();
  if (!grant) return jsonError(503, "用我们的服务器但还没有授权：先在管理页设置里输入邀请码激活");
  const { qas } = await visibleQAsFor(body.asOf, body.sessionId);
  const titleOf = await titleOfNow();
  const queueMap = loadAskQueue();
  const confirmedKeys = confirmedKeysOf(verdictsFor(body.asOf, body.sessionId)) ?? new Set<string>();
  const pendingAsks: AskQueueItem[] = (queueMap[body.sessionId] ?? []).filter(
    (a) => !confirmedKeys.has(`${a.qaId}#${a.slot}`),
  );
  const prevContextMd = contextQuestionCount(body.sessionId) >= 1 ? loadContextMd(body.sessionId) : undefined;
  prunePendingRuns();

  // 同一 sessionId 上一次 recall 还在跑：先取消旧的（与本地路径同一张表）
  const prev = activeBySession.get(body.sessionId);
  if (prev && !prev.done) {
    prev.preempted = true;
    prev.cancelReason = "preempt";
    prev.controller.abort();
    await Promise.race([prev.finished, new Promise((r) => setTimeout(r, 3000))]);
  }

  const runId = newRunId();
  const controller = new AbortController();
  const active: ActiveRun = { controller, finished: Promise.resolve(), preempted: false, cancelReason: null, done: false };
  activeBySession.set(body.sessionId, active);
  req.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      controller.abort(); // 断开保险第二路：本地流被 cancel 也中止远端请求
    },
    start(ctrl) {
      const enc = new TextEncoder();
      const send = (e: RecallEvent): void => {
        observeRecallEvent(runId, body, e); // 管理页「召回记录」旁听（只追加摘要，不影响流）
        try {
          ctrl.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          // 流已关（客户端断开），事件发不出去就算了
        }
      };
      const startedAt = Date.now();
      send({ type: "accepted", runId, qaTotal: qas.length, swarm: { endpoint: "hosted", model: grant.models.swarm }, budgetMs: 1_800_000, peak: isDeepSeekPeak(), startedAt });
      const heartbeatMs = Number(process.env.INTENT_LAB_HEARTBEAT_MS ?? 10_000) || 10_000;
      const heartbeat = setInterval(() => send({ type: "heartbeat", t: Date.now() }), heartbeatMs);
      let lastStage: "gate" | "s1" | "s3" | "s4" = "gate";

      active.finished = (async (): Promise<void> => {
        try {
          const r = await runHostedRecall({
            grant,
            ...(hostedEngineOf() === "deepseek-own" ? { engine: "deepseek-own" as const } : {}),
            sessionId: body.sessionId,
            turnId: body.turnId,
            title: body.title,
            q: body.q,
            force: body.force === true,
            qas,
            titleOf,
            edgeVerdicts: verdictsFor(body.asOf, body.sessionId),
            injectedBefore: state().injectedBySession.get(body.sessionId) ?? new Set<string>(),
            ...(prevContextMd !== undefined ? { prevContextMd } : {}),
            ...(pendingAsks.length ? { pendingAsks } : {}),
            send,
            signal: controller.signal,
          });
          if (r.kind === "error") return; // 核心已发 error 事件，这里转发过了
          if (r.kind === "gate-skip") {
            finishGateSkip({ send, runId, body, gate: { needIntent: false, why: r.gateWhy, forced: body.force === true, ms: r.gateMs }, startedAt });
            return;
          }
          // 核心回的 s3Scores 已是「过线」那部分（阈值在服务端）；客户端只管回写边
          const passed = new Set(r.outcome.s3Scores.map((s) => s.qaId));
          await finishRecallRun({
            outcome: r.outcome,
            send,
            runId,
            body,
            qas,
            titleOf,
            queueMap,
            gateMs: r.gateMs,
            s3Pass: (s) => passed.has(s.qaId),
          });
        } catch (err) {
          const elapsedMs = Date.now() - startedAt;
          if (err instanceof HostedRecallError) {
            send({ type: "error", stage: err.stage, message: err.message, retryable: err.retryable, elapsedMs });
            console.log(`[run] ${runId} hosted-${err.stage}-error：elapsedMs=${elapsedMs}`);
          } else if (controller.signal.aborted && active.preempted) {
            const message = active.cancelReason === "reset" ? "服务数据已重置，本次召回取消；重新发起即可" : "同一会话来了新的召回请求，本次已取消";
            send({ type: "error", stage: lastStage, message, retryable: true, elapsedMs });
            console.log(`[run] ${runId} ${active.cancelReason === "reset" ? "reset-cancelled" : "preempted"}：elapsedMs=${elapsedMs}`);
          } else if (controller.signal.aborted) {
            console.log(`[run] ${runId} cancelled：elapsedMs=${elapsedMs}`); // 客户端断开，流已关，不用发事件
          } else {
            send({ type: "error", stage: lastStage, message: err instanceof Error ? err.message : String(err), retryable: true, elapsedMs });
            console.log(`[run] ${runId} hosted-${lastStage}-error：elapsedMs=${elapsedMs}`);
          }
        } finally {
          clearInterval(heartbeat);
          active.done = true;
          if (activeBySession.get(body.sessionId) === active) activeBySession.delete(body.sessionId);
          try {
            ctrl.close();
          } catch {
            // 已关
          }
        }
      })();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
}

// ---------- /feedback ----------

async function handleFeedback(raw: unknown): Promise<Response> {
  const parsed = parseFeedbackRequest(raw);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const body = parsed.value;
  let run = runs.get(body.runId);
  if (!run) {
    // 09-29：内存里没有（服务重启过）就从磁盘恢复
    const persisted = loadPendingRun(body.runId);
    if (persisted) {
      run = await restoreRun(persisted);
      rememberRun(run);
      console.log(`[feedback] ${body.runId} 从磁盘恢复（服务重启过）`);
    }
  }
  if (!run) return jsonError(404, `run 不存在或已过期：${body.runId}`);

  const asks = run.review.ask;
  for (const a of body.answers) {
    if (!run.askItems.has(a.askId)) return jsonError(400, `askId 不属于这次 run：${a.askId}`);
  }

  const st = state();
  // 本次确认卡的表态（slot 级，带 statement 供否认行渲染）；历史表态不并入：
  // 否认过的报名 S3 已丢、已表态的确认卡项 S4 已丢，还选中必是因为别的岗
  const confirms = new Map<string, ConfirmState>();
  for (const a of body.answers) {
    const item = run.askItems.get(a.askId)!;
    const row: EdgeRow = {
      ts: Date.now(),
      runId: body.runId,
      sessionId: run.sessionId,
      turnId: run.turnId,
      qaId: item.qaId,
      slot: item.slot,
      verdict: a.verdict,
      statement: item.statement,
      ...(a.edited !== undefined ? { edited: a.edited } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    };
    appendEdge(row);
    st.edgeRows.push(row);
    st.verdicts.set(`${item.qaId}#${item.slot}`, { verdict: a.verdict, edited: a.edited, statement: item.statement }); // 后续 run 立即生效
    confirms.set(`${item.qaId}#${item.slot}`, { verdict: a.verdict, edited: a.edited, statement: item.statement });
  }

  const injection = withContextGuide(buildInjection(run.review, run.qaById, run.titleOf, confirms, body.note, run.injectedBefore), run.sessionId);
  recordInjected(body.runId, run.sessionId, injectedQaIds(run.review, confirms));
  // v3.2 §四：按表态改写上下文文件（no → md 移除；yes → 标确认；edited → 换用户说法），响应带全文
  const context = applyFeedbackToContext(
    run.sessionId,
    body.answers.map((a) => {
      const item = run.askItems.get(a.askId)!;
      return { qaId: item.qaId, slot: item.slot, verdict: a.verdict, edited: a.edited };
    }),
    {
      question: run.contextQuestion,
      titleOf: (qaId) => { const qa = run.qaById.get(qaId); return qa ? run.titleOf(qa.sessionId) : ""; },
      tsOf: (qaId) => run.qaById.get(qaId)?.tsAbs ?? 0,
      note: body.note, // 09-29：确认卡「补充背景」也写进上下文文件（附件方式下原先传不到回答模型）
    },
  );
  // 表态到手：这一问完整结束，删掉落盘的 run 与断点
  deletePendingRun(body.runId);
  if (run.checkpointDir) rmSync(run.checkpointDir, { recursive: true, force: true });
  return Response.json({ ok: true, injection, edgesWritten: body.answers.length, context } as const);
}

// ---------- /import 与 /ingest ----------

// B 方案（10-05）增量预热：swarmB 启用时，新入库的 QA 在后台补算 pads、补发预热请求。
// 处理范围是新 QA 所在会话的全部 QA，按该会话现在的标题渲染（会话改名后旧 QA 跟着重算重热，见 prewarmSessions）。
// QA 与标题在链上轮到时才取，跟召回同一口径（visibleQAsFor + titleOfNow）。
// 不阻塞响应、失败只记日志（串成一条链，避免两批同时写 pads 文件）；pads 缺失时召回照常进行（k=0，只是不命中缓存）。
//
// 指代说明（10-08）：预热完在同一条链上给新入库的可见 QA 生成指代说明（追加进 swarmB.coref.file）。
// 同样不阻塞响应、失败只记日志；漏掉的（生成时 vLLM 忙/失败）由定时扫描（sweepCoref）自动补——扫描只看
// 「可见集里还没有本版本说明行的 QA」，天然可续跑。作废的、被跨源去重藏掉的行不在可见集，不生成。
let prewarmChain: Promise<void> = Promise.resolve();
/** 把任务串到预热链上（一次只跑一个，写 pads 的只能一个写者）；onErr 不给就只记日志 */
export function chainPrewarm(task: () => Promise<void>, onErr?: (err: unknown) => void): void {
  prewarmChain = prewarmChain.then(task).catch((err) => {
    (onErr ?? ((e) => console.log(`[prewarm] 链上任务失败（不影响服务）：${e instanceof Error ? e.message : String(e)}`)))(err);
  });
}
/** 触发一次全量预热：hosted 走远端核心；本地编排走驱动（私有树） */
function startPrewarmJob(reason: string): void {
  if (hostedRecallServer()) {
    void remotePrewarmOnce(reason, "full");
    return;
  }
  localDriver?.startPrewarmJob(reason);
}

/** v6：去重索引用的行——被作废藏掉的行不进索引，同一句 / 同一 turnId 回退后重新入库不被挡。
 *  v6 增补（2026-10-09 内容更新）：走 mergeOrbitaQAs 的取代链——同 turnId 多行时链尾是当前内容；
 *  链上被作废消费掉的旧行自然不在。 */
function dedupeRowsOf(): OrbitaQaRow[] {
  const st = state();
  return dropInvalidated(mergeOrbitaQAs(st.importRows, st.orbitaRows), invalidatedQaCounts(st.invalidated));
}

/** 每个 (sessionId, turnId) 当前在库、可见的那行（链尾赢家；全被作废藏掉 = 没有赢家）。
 *  /import 与 /ingest 的内容更新判定用它：键在、内容不同 → 更新（作废旧行 + 同 qaId 追加新行）。 */
function currentByKeyOf(rows: readonly OrbitaQaRow[]): Map<string, OrbitaQaRow> {
  const out = new Map<string, OrbitaQaRow>();
  for (const r of rows) out.set(`${r.sessionId}\u0000${r.turnId}`, r); // 后写覆盖 = 链尾
  return out;
}

/** 内容更新判定：内容键相同（或都是空键时原文逐字相同）= 同一条；否则 = 内容变了。 */
function sameQaContent(current: OrbitaQaRow, incoming: { q: string; a: string }): boolean {
  const ck = contentKey(current);
  if (ck === null) return current.qText === incoming.q && current.aText === incoming.a;
  return ck === contentKey({ qText: incoming.q, aText: incoming.a });
}

/** 内容去重索引（/import、/ingest 共用）：本侧（import+orbita，作废的除外）+ proma 源的 qa.jsonl。
 *  10-08 修：proma 源下 qa.jsonl 也要比对——否则与 qa.jsonl 内容重复的行会被计为 imported 落盘
 *  （合并层把它藏住、也不预热，但磁盘上多了一条永远不可见的僵尸行）；现在入口就拦，返回 duplicates、不落盘。
 *  orbita 源不比 qa.jsonl（它根本不可见）。索引按 mtime 缓存（qaJsonlContentIndex）。 */
function contentIndexForDedupe(rows: OrbitaQaRow[]): Map<string, string> {
  const idx = contentIndex(rows);
  if (historySource() !== "proma") return idx;
  for (const [k, qaId] of qaJsonlContentIndex()) if (!idx.has(k)) idx.set(k, qaId);
  return idx;
}

/** v2 路 1：迁移完成后 Orbita 把全部根会话的 QA 送来；与 /ingest 共用去重键，可重复调用（幂等） */
function handleImport(raw: unknown): Response {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return jsonError(400, "请求体必须是 { rows: [...] }");
  const rowsRaw = (raw as { rows?: unknown }).rows;
  if (!Array.isArray(rowsRaw)) return jsonError(400, "rows 必须是数组");
  if (rowsRaw.length > 500) return jsonError(400, `一次最多 500 行，收到 ${rowsRaw.length} 行（由 Orbita 分批）`);
  const r = importRows(rowsRaw);
  if ("error" in r) return jsonError(400, r.error);
  return Response.json(r satisfies ImportResponse);
}

/** /import 的入库核心（2026-10-10 抽出）：HTTP 的 /import 与本机来源（local-sources）共用同一条路径 */
function importRows(rowsRaw: readonly unknown[], { prewarm = true }: { prewarm?: boolean } = {}): ImportResponse | { error: string } {
  const st = state();
  const dedupeRows = dedupeRowsOf();
  const currentByKey = currentByKeyOf(dedupeRows);
  // 09-29 加的内容去重，2026-10-08 升 v2（只看内容不看时间）：重新迁移 / Proma 子会话会带来换了 id
  // 甚至换了时间戳的同一条消息，跨源迁移的行只有原文内容靠得住；10-08 起 proma 源同比对 qa.jsonl
  const seenContent = contentIndexForDedupe(dedupeRows);
  let imported = 0;
  let duplicates = 0;
  let skippedScan = 0;
  let updated = 0;
  const freshRows: OrbitaQaRow[] = [];
  const updatedOlds: OrbitaQaRow[] = [];
  for (const rowRaw of rowsRaw) {
    const parsed = parseIngestRequest(rowRaw);
    if (!parsed.ok) return { error: `第 ${imported + duplicates + skippedScan + updated + 1} 行：${parsed.error}` };
    const b = parsed.value;
    if (isClosingScan(b)) {
      skippedScan++; // v6：收尾扫描的机器提问不入库（历史迁移里的也不例外）
      continue;
    }
    const key = `${b.sessionId}\u0000${b.turnId}`;
    const ck = contentKey({ qText: b.q, aText: b.a });
    const current = currentByKey.get(key);
    if (current !== undefined && sameQaContent(current, b)) {
      duplicates++; // 同 turn 同内容：真的重复
      continue;
    }
    const clash = ck !== null ? seenContent.get(ck) : undefined; // 新内容撞上「别的行」的内容键（qa.jsonl 跨源 / orbita 别的 turn）
    if (current === undefined && clash !== undefined) {
      duplicates++; // 键不在但内容与已有行同（换了 turnId 的同一句）
      continue;
    }
    if (current !== undefined && clash !== undefined && clash !== current.qaId) {
      // v6 增补（2026-10-09 晚，验收修）：更新路径的新内容撞上别的行——作废旧行、不追加新行
      // （等价 duplicate）。场景：q 口径更新后 orbita 行的内容与 qa.jsonl（proma 基座，本来就带
      // 引用）一字不差；跨源保留 qa.jsonl 那份（边、表态、指代说明都挂在它的 qaId 上），
      // orbita 内部保留最早的那行。
      const inv: InvalidatedRow = {
        ts: Date.now(),
        sessionId: b.sessionId,
        turnId: b.turnId,
        qaId: current.qaId,
        reason: "hidden-as-duplicate",
      };
      appendInvalidated([inv]);
      st.invalidated.push(inv);
      duplicates++;
      continue;
    }
    const row: OrbitaQaRow = {
      qaId: orbitaQaId(b.sessionId, b.turnId),
      sessionId: b.sessionId,
      turnIndex: 0,
      prevQaId: null,
      nextQaId: null,
      tsAbs: b.ts,
      qText: b.q,
      aText: b.a,
      qTimeResolved: [],
      sourceType: "human-direct",
      intentWeight: 1,
      attachmentTypes: [],
      toolCallCount: 0,
      source: { file: "orbita", lineStart: 0, lineEnd: 0 },
      shardId: b.sessionId,
      turnId: b.turnId,
      title: b.title,
    };
    if (current !== undefined) {
      // v6 增补（2026-10-09 内容更新）：同 turnId 但内容变了（Orbita 侧 q 口径改了：
      // 引用 / 粘贴文本进 q）→ 作废旧行（v6 机制，reason=content-updated）+ 同 qaId
      // 追加新行：取代链尾可见、旧行被作废藏掉。qaId 不变——边、表态、 pads 键都还在，
      // pads 按内容 hash 重算、指代说明按内容 hash 重生成（shadowCorefForUpdate 遮蔽旧说明）
      const inv: InvalidatedRow = {
        ts: Date.now(),
        sessionId: b.sessionId,
        turnId: b.turnId,
        qaId: current.qaId,
        reason: "content-updated",
      };
      appendInvalidated([inv]);
      st.invalidated.push(inv);
      updatedOlds.push(current);
      updated++;
    } else {
      imported++;
    }
    appendImportedQa(row);
    st.importRows.push(row);
    currentByKey.set(key, row);
    freshRows.push(row);
    if (ck !== null) seenContent.set(ck, row.qaId);
  }
  // B 方案：新入库 / 更新的 QA 后台补算 pads + 补热，不阻塞响应。本机来源（管理页同步）不在这里补：
  // 导入任务结束后由预热任务（startPrewarmJob）统一做，带进度、可停、有召回时让路
  if (prewarm) schedulePrewarm(freshRows);
  else if (freshRows.length) void localDriver?.corefStep(freshRows.map((r) => r.qaId)).catch(() => undefined);
  localDriver?.shadowCorefForUpdate(updatedOlds); // 内容更新：遮蔽旧指代说明，扫描按新内容补生成（本地编排才有）
  return { ok: true, imported, duplicates, skipped: skippedScan, updated };
}

/** v2：清空全部来自 Orbita 的数据（QA 两个来源 + 意图 + 注入记录 + 边）；data/runs 保留 */
async function handleReset(): Promise<Response> {
  // 在跑的 recall 先全部取消（流会收到一条 error），等它们停下再清文件
  const running = [...activeBySession.values()].filter((r) => !r.done);
  for (const r of running) {
    r.preempted = true;
    r.cancelReason = "reset";
    r.controller.abort();
  }
  if (running.length) await Promise.race([Promise.all(running.map((r) => r.finished)), new Promise((r) => setTimeout(r, 3000))]);

  const st = state();
  const cleared = {
    imported: st.importRows.length,
    ingested: st.orbitaRows.length,
    intents: st.prevIntents.size,
    injected: [...st.injectedBySession.values()].reduce((a, b) => a + b.size, 0),
    edges: st.edgeRows.length,
  };
  const dir = dataDir();
  for (const f of ["qa-import.jsonl", "qa-orbita.jsonl", join("orbita", "intents.jsonl"), join("orbita", "injected.jsonl"), "edges.jsonl"]) {
    const p = join(dir, f);
    mkdirSync(dirname(p), { recursive: true }); // 全新数据目录下 orbita/ 还不存在
    writeFileSync(p, "");
  }
  clearAllContext(dir); // v3.2 §四：上下文文件一并清空
  clearAllCheckpoints(); // 断点指向的 QA 已清，一并清空
  clearAllPendingRuns(); // 等表态的 run 也作废
  clearAskQueue(dir); // v3.2 §三：待问队列指向的 QA 已清，一并清空（cleared 报文仍是五类，不改契约）
  resetPersisted(); // 内存按空文件重建
  runs.clear(); // run 状态（/feedback 用）也一并失效——数据都清了，旧注入块重建不了
  console.log(`[reset] imported=${cleared.imported} ingested=${cleared.ingested} intents=${cleared.intents} injected=${cleared.injected} edges=${cleared.edges}`);
  return Response.json({ ok: true, cleared } satisfies ResetResponse);
}

function handleIngest(raw: unknown): Response {
  const parsed = parseIngestRequest(raw);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const b = parsed.value;
  if (isClosingScan(b)) return Response.json({ ok: true, qaId: "", duplicate: true, skipped: "closing-scan" } as const);
  const st = state();
  // 去重键与 /import 共用：迁移已有的 (sessionId, turnId) 聊天中也不重复入库；
  // v6：被作废藏掉的行不进索引（回退后重发同一句能正常入库）；
  // 10-08：内容去重同比对 qa.jsonl（proma 源）——与 qa.jsonl 重复的行不再落盘，返回已有那条的 qaId；
  // 10-09 内容更新：同 turnId 内容变了（重发 / 口径变更）→ 作废旧行 + 同 qaId 追加新行（updated:true）
  const dedupeRows = dedupeRowsOf();
  const currentByKey = currentByKeyOf(dedupeRows);
  const seenContentAll = contentIndexForDedupe(dedupeRows);
  const qaId = orbitaQaId(b.sessionId, b.turnId);
  const current = currentByKey.get(`${b.sessionId}\u0000${b.turnId}`);
  if (current !== undefined && sameQaContent(current, b)) {
    return Response.json({ ok: true, qaId, duplicate: true } as const);
  }
  // 同一条消息已在库（换了会话 id / 时间戳）：不重复入库，返回已有那条的 qaId
  const ck = contentKey({ qText: b.q, aText: b.a });
  const clash = ck !== null ? seenContentAll.get(ck) : undefined;
  if (current === undefined && clash !== undefined) {
    return Response.json({ ok: true, qaId: clash, duplicate: true } as const);
  }
  if (current !== undefined && clash !== undefined && clash !== current.qaId) {
    // v6 增补（2026-10-09 晚，验收修）：更新路径的新内容撞上别的行（qa.jsonl 跨源 / orbita 别的
    // turn）→ 作废旧行、不追加新行（等价 duplicate，返回幸存那行的 qaId）。
    // 场景：q 口径更新后与 proma 基座一字不差；同一句话不召回两次
    const inv: InvalidatedRow = { ts: Date.now(), sessionId: b.sessionId, turnId: b.turnId, qaId: current.qaId, reason: "hidden-as-duplicate" };
    appendInvalidated([inv]);
    st.invalidated.push(inv);
    return Response.json({ ok: true, qaId: clash, duplicate: true } as const);
  }
  const row: OrbitaQaRow = {
    qaId,
    sessionId: b.sessionId,
    turnIndex: 0,
    prevQaId: null,
    nextQaId: null,
    tsAbs: b.ts,
    qText: b.q,
    aText: b.a,
    qTimeResolved: [],
    sourceType: "human-direct",
    intentWeight: 1,
    attachmentTypes: [],
    toolCallCount: 0,
    source: { file: "orbita", lineStart: 0, lineEnd: 0 },
    shardId: b.sessionId,
    turnId: b.turnId,
    title: b.title,
  };
  if (current !== undefined) {
    // v6 增补（2026-10-09 内容更新）：作废旧行（v6 机制）+ 同 qaId 追加新行，链尾可见。
    // qaId 不变：边、表态、pads 键都还在；pads 按内容 hash 重算、指代说明按新内容重生成
    const inv: InvalidatedRow = { ts: Date.now(), sessionId: b.sessionId, turnId: b.turnId, qaId, reason: "content-updated" };
    appendInvalidated([inv]);
    st.invalidated.push(inv);
    localDriver?.shadowCorefForUpdate([current]);
  }
  appendOrbitaQa(row);
  st.orbitaRows.push(row);
  schedulePrewarm([row]); // B 方案：新入库 / 更新的 QA 后台补算 pads + 补热，不阻塞响应
  return Response.json({ ok: true, qaId, duplicate: false, ...(current !== undefined ? { updated: true } : {}) } as const);
}

// ---------- /invalidate（契约 v6：会话回退后的作废） ----------

function parseInvalidateRequest(body: unknown): Parsed<InvalidateRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "请求体必须是 JSON 对象" };
  const b = body as Record<string, unknown>;
  if (typeof b.sessionId !== "string" || !b.sessionId.trim()) return { ok: false, error: "sessionId 不能为空" };
  if (!Array.isArray(b.turnIds)) return { ok: false, error: "turnIds 必须是数组" };
  if (b.turnIds.length > 500) return { ok: false, error: `一次最多 500 个 turnId，收到 ${b.turnIds.length} 个` };
  const turnIds: string[] = [];
  for (const v of b.turnIds as unknown[]) {
    if (typeof v !== "string" || !v.trim()) return { ok: false, error: "turnIds 每项必须是非空字符串" };
    const t = v.trim();
    if (!turnIds.includes(t)) turnIds.push(t); // 请求内去重
  }
  return { ok: true, value: { sessionId: b.sessionId.trim(), turnIds } };
}

/** 该会话此刻的上下文文件（重生成后的全量）；没有文件 / 空文件 → null（Orbita 侧删本地副本） */
async function contextViewOf(sessionId: string): Promise<{ md: string; jsonl: string } | null> {
  if (contextQuestionCount(sessionId) === 0) return null;
  const md = loadContextMd(sessionId);
  if (md === undefined) return null;
  const { entries } = loadContextState(sessionId);
  return { md, jsonl: rowsToJsonl(entries) };
}

/** v6：Orbita 会话回退成功后调——被回退轮次的 QA 软删（不再被召回）、上下文小节去掉、
 *  断点 / 等表态 run / 待问队列项清掉。幂等；库里没有的 turnId 不记（免得挡住它以后真的入库），只报数。 */
async function handleInvalidate(raw: unknown): Promise<Response> {
  const parsed = parseInvalidateRequest(raw);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const { sessionId, turnIds } = parsed.value;
  const st = state();
  const existing = invalidatedPairs(st.invalidated);
  const known = new Set([...st.importRows, ...st.orbitaRows].map((r) => invalidateKey(r.sessionId, r.turnId)));
  const now = Date.now();
  const fresh: InvalidatedRow[] = [];
  let unknown = 0;
  for (const tid of turnIds) {
    const key = invalidateKey(sessionId, tid);
    if (existing.has(key)) continue; // 幂等：已作废过的不再记
    if (!known.has(key)) {
      unknown++; // 库里没这轮（从没 /ingest 过）——不记，免得挡住它以后真的入库
      continue;
    }
    fresh.push({ ts: now, sessionId, turnId: tid, qaId: orbitaQaId(sessionId, tid) });
    existing.add(key);
  }
  if (fresh.length) {
    appendInvalidated(fresh);
    st.invalidated.push(...fresh);
  }
  const turnSet = new Set(turnIds);
  // 待问队列：指向被作废 QA 的项删掉（那喋确认卡不用再问了）
  const queueMap = loadAskQueue();
  const invalidatedQaIds = new Set(invalidatedQaCounts(st.invalidated).keys());
  let queueRemoved = 0;
  for (const sid of Object.keys(queueMap)) {
    const items = queueMap[sid] ?? [];
    const kept = items.filter((i) => !invalidatedQaIds.has(i.qaId));
    if (kept.length !== items.length) {
      queueRemoved += items.length - kept.length;
      queueMap[sid] = kept;
    }
  }
  if (queueRemoved) saveAskQueue(queueMap);
  // 内存里等表态的 run、落盘的 pending-run、断点：被回退那一问不会再表态 / 重试了
  for (const [runId, run] of runs) {
    if (run.sessionId === sessionId && turnSet.has(run.turnId)) runs.delete(runId);
  }
  const pendingRemoved = deletePendingRunsFor(sessionId, turnSet);
  const checkpointsRemoved = clearCheckpointsFor(sessionId, turnSet);
  // 上下文文件：该会话去掉那些问的小节（重编号）；任何会话里引用了被作废 QA 的条目也去掉
  const tsById = new Map([...st.importRows, ...st.orbitaRows].map((r) => [r.qaId, r.tsAbs] as const));
  const pruned = pruneContexts(dataDir(), {
    turnIdsBySession: new Map([[sessionId, turnSet]]),
    hiddenQaIds: invalidatedQaIds,
    titleOf: await titleOfNow(),
    tsOf: (qaId) => tsById.get(qaId) ?? 0,
  });
  const mine = pruned.get(sessionId.replace(/[^a-zA-Z0-9:_-]/g, "_"));
  const context = await contextViewOf(sessionId);
  console.log(
    `[invalidate] ${sessionId}：新作废 ${fresh.length}，未知 ${unknown}，上下文去 ${mine?.removedQuestions ?? 0} 问 / ${mine?.removedEntries ?? 0} 条，` +
      `待问队列去 ${queueRemoved}，pending-run 去 ${pendingRemoved}，断点去 ${checkpointsRemoved}，其他会话上下文动 ${pruned.size - (mine ? 1 : 0)} 份`,
  );
  return Response.json({ ok: true, invalidated: fresh.length, unknown, context } satisfies InvalidateResponse);
}


// ---------- 本机来源（2026-10-10）：Claude Code / Codex 的会话文件直接入库 + 管理页 /ui ----------

/** 本机接口的防护：只认本机 Host；写操作若带 Origin 必须是本页（挡其他网页借浏览器调本机服务）。
 *  覆盖 /ui、/local/*，以及核心写接口 /recall /feedback /import /reset /ingest /invalidate。
 *  插件 / curl 不带 Origin，照常放行。之后加本机令牌时也加在这里。 */
function localGuard(req: Request, url: URL): Response | null {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (host !== "127.0.0.1" && host !== "localhost") return jsonError(403, "只接受本机访问");
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== `${url.protocol}//${url.host}`) return jsonError(403, "跨站请求被拒绝");
  }
  return null;
}

const isLocalSource = (v: unknown): v is LocalSourceId => typeof v === "string" && (LOCAL_SOURCES as readonly string[]).includes(v);

/** 本机来源导入 / 同步结束：有新内容就开始（或接着）预热——在管理页里做完，不留到对话里 */
function onLocalImportDone(job: { imported: number; updated: number; mode: string }): void {
  if (job.imported + job.updated > 0 || job.mode === "full") startPrewarmJob(`本机来源${job.mode === "full" ? "导入" : "同步"}完成`);
}

/** 本机来源一批行 → /import 同一条入库路径 */
function importLocalBatch(rows: LocalRow[]): { imported: number; duplicates: number; updated: number } {
  const r = importRows(rows, { prewarm: false });
  if ("error" in r) throw new Error(r.error);
  return { imported: r.imported, duplicates: r.duplicates, updated: r.updated ?? 0 };
}

/** 每个会话当前在库可见的条数（作废的不算；被排除的照算，排除只影响召回） */
function storedCountBySession(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of dedupeRowsOf()) m.set(r.sessionId, (m.get(r.sessionId) ?? 0) + 1);
  return m;
}

interface ProjectView { path: string; sessions: number; found: number; stored: number; lastTs: number; excluded: boolean }

function projectViews(id: LocalSourceId, sessions: SessionSummary[], stored: Map<string, number>): ProjectView[] {
  const st = loadLocalState();
  const excluded = new Set(st.excludedProjects[id]);
  const by = new Map<string, ProjectView>();
  for (const s of sessions) {
    if (s.kind !== "user" || s.rows === 0) continue;
    const path = s.project ?? "（无项目目录）";
    const v = by.get(path) ?? { path, sessions: 0, found: 0, stored: 0, lastTs: 0, excluded: excluded.has(path) };
    v.sessions += 1;
    v.found += s.rows;
    v.stored += stored.get(s.sessionId) ?? 0;
    v.lastTs = Math.max(v.lastTs, s.lastTs);
    by.set(path, v);
  }
  return [...by.values()].sort((a, b) => b.lastTs - a.lastTs);
}

async function handleLocalSources(): Promise<Response> {
  const st = loadLocalState();
  const stored = storedCountBySession();
  const visibleHidden = localHiddenSessions();
  const sources = [];
  for (const id of LOCAL_SOURCES) {
    const sessions = summarizeSessions(await scanSource(id));
    const user = sessions.filter((s) => s.kind === "user" && s.rows > 0);
    let storedTotal = 0;
    let active = 0;
    for (const s of user) {
      const n = stored.get(s.sessionId) ?? 0;
      storedTotal += n;
      if (!visibleHidden(s.sessionId)) active += n;
    }
    const skipped: Record<string, number> = {};
    for (const s of sessions) if (s.kind !== "user") skipped[s.kind] = (skipped[s.kind] ?? 0) + 1;
    sources.push({
      id,
      root: sourceRoot(id),
      found: listSessionFiles(id).length > 0,
      ...st.sources[id],
      sessions: user.length,
      rowsFound: user.reduce((n, s) => n + s.rows, 0),
      rowsStored: storedTotal,
      rowsActive: active,
      skippedSessions: skipped,
      job: currentJob(id),
      projects: projectViews(id, sessions, stored),
    });
  }
  // Orbita 推送来的（/import /ingest 的非本机行）只给条数
  let orbita = 0;
  for (const [sid, n] of stored) if (sourceOfSession(sid) === null) orbita += n;
  return Response.json({ ok: true, sources, orbita: { rowsStored: orbita } });
}

async function handleLocalSessions(url: URL): Promise<Response> {
  const id = url.searchParams.get("source");
  const project = url.searchParams.get("project");
  if (!isLocalSource(id)) return jsonError(400, "source 必须是 claude 或 codex");
  const st = loadLocalState();
  const excluded = new Set(st.excludedSessions);
  const stored = storedCountBySession();
  const sessions = summarizeSessions(await scanSource(id))
    .filter((s) => s.kind === "user" && s.rows > 0 && (project === null || (s.project ?? "（无项目目录）") === project))
    .sort((a, b) => b.lastTs - a.lastTs)
    .map((s) => ({ sessionId: s.sessionId, title: s.title, found: s.rows, files: s.files.length, stored: stored.get(s.sessionId) ?? 0, lastTs: s.lastTs, excluded: excluded.has(s.sessionId) }));
  return Response.json({ ok: true, sessions });
}

async function handleLocalPost(path: string, raw: unknown): Promise<Response> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = b.source;
  if (!isLocalSource(id)) return jsonError(400, "source 必须是 claude 或 codex");
  if (path === "/local/import") {
    const mode = b.mode === "full" ? "full" : "sync";
    const job = startLocalImport(id, mode, importLocalBatch, onLocalImportDone);
    return Response.json({ ok: true, job }, { status: 202 });
  }
  if (path === "/local/settings") {
    updateLocalState((s) => {
      if (b.consent === "yes" || b.consent === "no" || b.consent === "unasked") s.sources[id].consent = b.consent;
      if (typeof b.enabled === "boolean") s.sources[id].enabled = b.enabled;
    });
    return Response.json({ ok: true, state: loadLocalState().sources[id] });
  }
  if (path === "/local/exclude") {
    const excluded = b.excluded !== false;
    const toggle = (list: string[], v: string): string[] => (excluded ? [...new Set([...list, v])] : list.filter((x) => x !== v));
    if (typeof b.project === "string") updateLocalState((s) => void (s.excludedProjects[id] = toggle(s.excludedProjects[id], b.project as string)));
    else if (typeof b.sessionId === "string") updateLocalState((s) => void (s.excludedSessions = toggle(s.excludedSessions, b.sessionId as string)));
    else return jsonError(400, "要给 project 或 sessionId");
    return Response.json({ ok: true });
  }
  if (path === "/local/clear") {
    // 物理删除（与 /reset 同一做法，只限这个来源）：qa-import.jsonl 里这个来源的行、以及挂在它们
    // 上的作废记录一并去掉，增量水位清空。不能用作废软删：同内容重新导入时，合并层会把新行与
    // 被作废的旧行合成一条再藏掉，重导回不来。表态 / 边按 qaId 挂着，保留——重导后自动接上。
    const job = currentJob(id);
    if (job && (job.phase === "scan" || job.phase === "import")) return jsonError(409, "这个来源正在导入，等它结束再清空");
    const isMine = (sessionId: unknown): boolean => typeof sessionId === "string" && sourceOfSession(sessionId) === id;
    const cleared = rewriteJsonl(join(dataDir(), "qa-import.jsonl"), (r) => !isMine(r.sessionId));
    rewriteJsonl(join(dataDir(), "orbita", "invalidated.jsonl"), (r) => !isMine(r.sessionId));
    updateLocalState((s) => {
      const root = sourceRoot(id);
      for (const file of Object.keys(s.synced)) if (file.startsWith(root)) delete s.synced[file];
      for (const [sid, v] of Object.entries(s.sessions)) if (v.source === id) delete s.sessions[sid];
      s.sources[id].lastSyncAt = null;
    });
    resetPersisted(); // 内存按新文件重建
    console.log(`[local] 清空 ${id}：删除 ${cleared} 行`);
    return Response.json({ ok: true, cleared });
  }
  return jsonError(404, `没有这个接口：POST ${path}`);
}

/** 按行过滤重写一个 JSONL（原子写）；返回删掉的行数。坏行原样保留。 */
function rewriteJsonl(path: string, keep: (row: Record<string, unknown>) => boolean): number {
  if (!existsSync(path)) return 0;
  let removed = 0;
  const out: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (row && typeof row === "object" && !keep(row as Record<string, unknown>)) removed++;
    else out.push(line);
  }
  if (removed === 0) return 0;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, out.length ? out.join("\n") + "\n" : "");
  renameSync(tmp, path);
  return removed;
}

// ---------- 预热任务（2026-10-10）：管理页同步完就开始，不留到对话里 ----------
//
// B 方案的缓存要先预热（给每段算占位符 + 把可缓存前缀推进 vLLM）。第一次是全量（几千条约一小时，独占 GPU），
// 不该在用户提问时才发生——那时召回要么不命中缓存（很慢），要么跟预热抢卡。所以：
//   - 本机来源导入 / 同步结束后自动开始；管理页可看进度、停、继续；
//   - 全部可见 QA 都过一遍：已新鲜的段只算 hash 跳过（便宜），没做过 / 内容变了的才真去预热；
//   - 有召回在跑就暂停派发，把 GPU 让给用户；
//   - 与 Orbita /import /ingest 的增量预热串在同一条链上（同一个 pads 文件只能一个写者）。
// 只在当前蜂群端点启用了 B 方案（swarmB.padsFile，如「用我们的服务器」）时有意义；否则 unavailable。

interface PrewarmJobState {
  phase: "idle" | "queued" | "running" | "paused" | "done" | "stopped" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  qas: number;
  segs: number;
  failed: number;
  /** 按真正跑过的条目外推的剩余毫秒（跳过的新鲜条目不算速度） */
  etaMs: number | null;
  error: string | null;
}

export const prewarmJob: PrewarmJobState = { phase: "idle", startedAt: null, finishedAt: null, done: 0, total: 0, qas: 0, segs: 0, failed: 0, etaMs: null, error: null };

// ---------- hosted（编排在服务端）时的预热代理：任务在召回核心跑，本地只触发 / 轮询 / 停 ----------

let remotePrewarmTimer: ReturnType<typeof setInterval> | null = null;
let remotePadsCache: { at: number; entries: Record<string, { k: number; warmed: boolean }> | null } | null = null;
let remoteStatusCache: { at: number; m: RemotePrewarmMirror | null } | null = null;
let remoteRateCache: { at: number; v: number | null } | null = null;
/** 核心实测的预热速率（条/秒）：导入前估「预计约 N 分钟」用；60 秒缓存，拿不到 null（UI 兜底 6） */
async function remotePrewarmRate(grant: HostedGrant): Promise<number | null> {
  if (!remoteRateCache || Date.now() - remoteRateCache.at > 60_000) {
    const m = await remotePrewarmStatus(grant);
    remoteRateCache = { at: Date.now(), v: m?.ratePerSec ?? null };
  }
  return remoteRateCache.v;
}

function stopRemotePrewarmPoll(): void {
  if (remotePrewarmTimer) {
    clearInterval(remotePrewarmTimer);
    remotePrewarmTimer = null;
  }
}

function pollRemotePrewarm(grant: HostedGrant): void {
  stopRemotePrewarmPoll();
  remotePrewarmTimer = setInterval(() => {
    void (async () => {
      const m = await remotePrewarmStatus(grant);
      if (!m) return;
      Object.assign(prewarmJob, m);
      if (m.phase !== "running" && m.phase !== "paused" && m.phase !== "queued") stopRemotePrewarmPoll();
    })();
  }, 3_000);
}

/** 触发一次远端预热（全量或按会话增量）。已在跑就什么都不做；进度靠轮询镜像进 prewarmJob */
async function remotePrewarmOnce(reason: string, scope: "full" | { sessionIds: string[] }): Promise<void> {
  if (prewarmJob.phase === "running" || prewarmJob.phase === "paused" || prewarmJob.phase === "queued") {
    console.log(`[prewarm] 已有预热在跑/排队，忽略本次触发（${reason}）`);
    return;
  }
  const grant = loadHostedGrant();
  if (!grant) return;
  Object.assign(prewarmJob, { phase: "queued", startedAt: Date.now(), finishedAt: null, done: 0, total: 0, qas: 0, segs: 0, failed: 0, etaMs: null, error: null });
  console.log(`[prewarm] 远端预热任务排队（${reason}）`);
  const { qas } = await visibleQAsFor();
  const titleOf = await titleOfNow();
  const inScope = scope === "full" ? qas : qas.filter((qa) => new Set(scope.sessionIds).has(qa.sessionId));
  if (scope !== "full" && !inScope.length) return;
  let r = await remotePrewarmStart(grant, inScope, titleOf, scope);
  if (!r.ok && /HTTP 401/.test(r.error ?? "")) {
    // 刚激活的密钥：核心按文件 mtime 缓存有效密钥清单（5 秒），头几秒可能还没看到——等一个缓存周期重试一次
    console.log(`[prewarm] 远端预热 401（新激活的密钥核心可能还没看到），6 秒后重试一次`);
    await new Promise((res) => setTimeout(res, 6_000));
    r = await remotePrewarmStart(grant, inScope, titleOf, scope);
  }
  if (!r.ok) {
    prewarmJob.phase = "error";
    prewarmJob.error = r.error ?? "远端预热没启动";
    console.log(`[prewarm] 远端预热启动失败：${prewarmJob.error}`);
    return;
  }
  pollRemotePrewarm(grant);
}

async function handlePrewarmStatus(): Promise<Response> {
  if (hostedEngineOf() === "deepseek-own") {
    return Response.json({ ok: true, prewarm: { available: false, notApplicable: true, reason: "自己配置（DeepSeek）模式不需要预热" } });
  }
  if (hostedRecallServer()) {
    const grant = loadHostedGrant();
    if (!grant) return Response.json({ ok: true, prewarm: { available: false } });
    // 跑着时用本地镜像（3 秒轮询）；闲着时现问一次核心（5 秒缓存，管理页别把它问炸）
    const running = prewarmJob.phase === "running" || prewarmJob.phase === "paused" || prewarmJob.phase === "queued";
    if (!running) {
      if (!remoteStatusCache || Date.now() - remoteStatusCache.at > 5_000) remoteStatusCache = { at: Date.now(), m: await remotePrewarmStatus(grant) };
      if (remoteStatusCache.m) Object.assign(prewarmJob, remoteStatusCache.m);
    }
    // 覆盖率：远端 pads 键集（只有键与 k，无原文）+ 本地段数
    let coverage: { segs: number; warmed: number } | null = null;
    if (!remotePadsCache || Date.now() - remotePadsCache.at > 10_000) remotePadsCache = { at: Date.now(), entries: await remotePadsEntries(grant) };
    if (remotePadsCache.entries) {
      const { qas } = await visibleQAsFor();
      coverage = padCoverageFromKeys(remotePadsCache.entries, qas);
    }
    const rate = await remotePrewarmRate(grant);
    return Response.json({ ok: true, prewarm: { available: true, ...prewarmJob, ratePerSec: rate, ...(coverage ? { coverage } : {}) } });
  }
  // 本地编排：本地预热目标的状态与覆盖率（私有树的 recall-local 驱动）
  if (localDriver) return localDriver.prewarmStatus();
  return Response.json({ ok: true, prewarm: { available: false } });
}

export function startLocalSync(): void {
  const every = Number(process.env.INTENT_LAB_LOCAL_SYNC_MS ?? 5 * 60_000);
  if (!(every > 0)) return;
  const tick = (): void => {
    const st = loadLocalState();
    for (const id of LOCAL_SOURCES) if (st.sources[id].consent === "yes") startLocalImport(id, "sync", importLocalBatch, onLocalImportDone);
  };
  setTimeout(tick, 5_000);
  setInterval(tick, every);
}

// ---------- 管理页：召回记录 / 表态 / 配置（2026-10-10） ----------

function handleLocalRecalls(url: URL): Response {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  return Response.json({ ok: true, recalls: loadRecallLog(limit) });
}

/** 表态 = /feedback 写的边（verdict yes / no，或带 edited）；同 (qaId, 岗) 取最新；skip 视作已撤销 */
async function handleLocalVerdicts(): Promise<Response> {
  const latest = new Map<string, EdgeRow>();
  for (const r of state().edgeRows) if (r.verdict != null) latest.set(`${r.qaId}#${r.slot}`, r);
  const { qas } = await visibleQAsFor();
  const qaById = new Map(qas.map((q) => [q.qaId, q]));
  const titleOf = await titleOfNow();
  const verdicts = [...latest.values()]
    .filter((r) => r.verdict === "yes" || r.verdict === "no" || (r.edited ?? "") !== "")
    .sort((a, b) => b.ts - a.ts)
    .map((r) => {
      const qa = qaById.get(r.qaId);
      const src = sourceOfSession(qa?.sessionId ?? r.qaId.replace(/^orbita:/, ""));
      return {
        qaId: r.qaId, slot: r.slot, slotName: slotNameOf(r.slot), verdict: r.verdict, statement: r.statement,
        edited: r.edited ?? null, note: r.note ?? null, ts: r.ts, runId: r.runId,
        from: qa ? `${src === "claude" ? "Claude" : src === "codex" ? "Codex" : "Orbita"} · ${titleOf(qa.sessionId) || "(无标题)"} · ${fmtShort(qa.tsAbs)}` : r.qaId,
      };
    });
  return Response.json({ ok: true, verdicts });
}

/** 撤销表态：追加一条 verdict=skip 的边（只追加；同键取最新 → 回到不表态，之后可能再问） */
function handleRevokeVerdict(raw: unknown): Response {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof b.qaId !== "string" || typeof b.slot !== "number") return jsonError(400, "要给 qaId 与 slot");
  const st = state();
  const prev = [...st.edgeRows].reverse().find((r) => r.qaId === b.qaId && r.slot === b.slot && r.verdict != null);
  const row: EdgeRow = {
    ts: Date.now(), runId: "local-revoke", sessionId: prev?.sessionId ?? "", turnId: prev?.turnId ?? "",
    qaId: b.qaId, slot: b.slot, verdict: "skip", statement: prev?.statement ?? "", note: "管理页撤销",
  };
  appendEdge(row);
  st.edgeRows.push(row);
  st.verdicts = edgeVerdicts(st.edgeRows);
  return Response.json({ ok: true });
}

const CONFIG_STAGES = ["main", "swarm"] as const;

function readRawConfig(p: string): Record<string, any> | null {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  } catch {
    return null;
  }
}

/** 配置读：不回显 key，只说配没配。mode = own（自己配置）/ hosted（用我们的服务器：只报授权状态，不露地址与密钥） */
async function handleGetConfig(): Promise<Response> {
  const p = configPath();
  const raw = readRawConfig(p) ?? {};
  const mode = raw.endpointMode === "hosted" ? "hosted" : "own";
  const view: Record<string, unknown> = { path: p, mode, hostedOnly: !localDriver }; // 公开客户端树：没有本地编排驱动，只能用我们的服务器
  for (const k of CONFIG_STAGES) {
    const ep = raw[k];
    view[k] = ep ? { baseUrl: ep.baseUrl ?? "", model: ep.model ?? "", hasKey: typeof ep.apiKey === "string" && ep.apiKey !== "" } : null;
  }
  const g = loadHostedGrant();
  view.engine = hostedEngineOf();
  view.userKey = g ? await remoteUserKeyStatus(g) : null;
  view.hosted = g
    ? { granted: true, user: g.user ?? null, model: g.models.swarm, s4Model: g.models.s4, source: g.source }
    : { granted: false, user: null, model: HOSTED_DEFAULT_MODEL, source: null, authConfigured: hostedAuthBase() !== "" };
  const sv = swarmViewOf(loadConfig());
  view.recallBudgetMs = sv.budgetMs;
  view.recallConcurrency = sv.concurrency;
  return Response.json({ ok: true, config: view });
}

/**
 * 配置写。mode=hosted：只记 endpointMode（要已授权）；端点、并发、预算都由授权与服务器决定，用户不填。
 * mode=own：改自己的 main / swarm（baseUrl、model、apiKey 给了才改）与蜂群的预算 / 并发。
 * 其余字段原样保留；文件权限 600。
 */
async function handlePostConfig(raw: unknown): Promise<Response> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const p = configPath();
  const cur = readRawConfig(p);
  if (cur === null) return jsonError(500, `配置文件不是合法 JSON，没改：${p}`);
  const mode = b.mode === "hosted" ? "hosted" : b.mode === "own" ? "own" : cur.endpointMode === "hosted" ? "hosted" : "own";
  if (mode === "hosted") {
    if (!loadHostedGrant()) return jsonError(400, "还没有我们服务器的授权：先输入邀请码激活");
    cur.endpointMode = "hosted";
    // 档位切换（key 的设置/删除走 /local/user-key）
    if (b.engine === "deepseek-own") {
      if (!(await remoteUserKeyStatus(loadHostedGrant()!))?.set) return jsonError(400, "还没设置 DeepSeek key：先在下面填一次");
      cur.hostedEngine = "deepseek-own";
    } else {
      delete cur.hostedEngine;
    }
  } else {
    for (const k of CONFIG_STAGES) {
      const inc = b[k];
      if (!inc || typeof inc !== "object") continue;
      const ep = { ...(cur[k] ?? {}) };
      if (typeof inc.baseUrl === "string") ep.baseUrl = inc.baseUrl.trim();
      if (typeof inc.model === "string") ep.model = inc.model.trim();
      if (typeof inc.apiKey === "string" && inc.apiKey.trim() !== "") ep.apiKey = inc.apiKey.trim();
      if (k === "swarm") {
        if (Number.isFinite(inc.recallBudgetMs) && inc.recallBudgetMs > 0) ep.recallBudgetMs = Math.round(inc.recallBudgetMs);
        if (Number.isFinite(inc.recallConcurrency) && inc.recallConcurrency > 0) ep.recallConcurrency = Math.round(inc.recallConcurrency);
      }
      cur[k] = ep;
    }
    cur.endpointMode = "own";
  }
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
  return handleGetConfig();
}

/** 写配置文件的 endpointMode（其余字段原样；600） */
function setEndpointMode(mode: "own" | "hosted"): void {
  const p = configPath();
  const cur = readRawConfig(p) ?? {};
  cur.endpointMode = mode;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * 邀请码激活：向我们的激活服务 POST {base}/activate {code, device}，换回这台电脑的专属密钥，
 * 写进 hosted.json（600），并切到「用我们的服务器」。激活服务的契约见 scripts/hosted-auth-server.ts。
 */
async function handleHostedActivate(raw: unknown): Promise<Response> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const code = typeof b.code === "string" ? b.code.trim() : "";
  if (!code) return jsonError(400, "请输入邀请码");
  const base = hostedAuthBase();
  if (!base) return jsonError(503, "激活服务地址还没配置（INTENT_LAB_HOSTED_AUTH）");
  let res: Response;
  try {
    res = await fetch(`${base}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device: { os: process.platform, host: hostname() } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return jsonError(502, `连不上激活服务（${err instanceof Error ? err.message : String(err)}）`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return jsonError(res.status === 404 || res.status === 400 || res.status === 403 ? 400 : 502, String(body.error ?? `激活失败（HTTP ${res.status}）`));
  if (typeof body.baseUrl !== "string" || !body.baseUrl || typeof body.apiKey !== "string" || !body.apiKey) return jsonError(502, "激活服务返回的授权不完整");
  const grant = {
    baseUrl: body.baseUrl, apiKey: body.apiKey, model: typeof body.model === "string" && body.model ? body.model : HOSTED_DEFAULT_MODEL,
    ...(typeof body.user === "string" ? { user: body.user } : {}),
    limits: parseHostedLimits(body.limits), // 服务器下发的并发（旧版激活服务不带 = 缺省）
    // 服务器下发的模型名（旧版激活服务不带：swarm = 返回的 model，s4 = 当前约定的缺省）
    models: parseHostedModels(body.models, { swarm: typeof body.model === "string" && body.model ? body.model : HOSTED_DEFAULT_MODEL, s4: HOSTED_S4_DEFAULT_MODEL }),
    recallMode: parseHostedRecallMode(body.recallMode), // 10-10 B 方案：旧服务器不带 = client
    activatedAt: Date.now(),
  };
  setLiveHostedLimits(null);
  setLiveHostedModels(null);
  const gp = hostedGrantPath();
  mkdirSync(dirname(gp), { recursive: true });
  const tmp = `${gp}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(grant, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, gp);
  setEndpointMode("hosted");
  console.log(`[hosted] 已激活：${grant.user ?? "(未具名)"}`);
  // 先导入后激活的老流程补一枪（10-11 用户实测：导入时还不是 hosted-server，自动预热静默没触发）：
  // 激活成功这一刻已有可见 QA 且预热从没跑过 → 自动补一次远端预热，不用用户自己去点
  if (hostedRecallServer()) {
    const { qas } = await visibleQAsFor();
    if (qas.length && prewarmJob.phase === "idle") void startPrewarmJob("激活后补预热（之前导入过的历史）");
  }
  return handleGetConfig();
}

/**
 * 刷新服务器下发的并发与模型名：GET {激活服务}/config → { limits, models }。服务启动、每次召回前、预热开始前调；
 * 3 秒拿不到就用上一次的（文件里存着），第一次就失败按缺省 256 / 256 / 16。文件授权时写回 hosted.json。
 */
export async function refreshHostedLimits(): Promise<void> {
  const g = loadHostedGrant();
  const base = hostedAuthBase();
  if (!g || !base || readRawConfig(configPath())?.endpointMode !== "hosted") return;
  let limits;
  let models;
  let recallMode;
  try {
    const res = await fetch(`${base}/config`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return;
    const body = (await res.json()) as { limits?: unknown; models?: unknown; recallMode?: unknown };
    limits = parseHostedLimits(body.limits, g.limits);
    models = parseHostedModels(body.models, g.models);
    recallMode = parseHostedRecallMode(body.recallMode, g.recallMode); // 10-10 B 方案：编排模式也随 /config 下发
  } catch {
    return; // 拿不到：沿用上一次
  }
  setLiveHostedLimits(limits);
  setLiveHostedModels(models);
  setLiveHostedRecallMode(recallMode);
  if (g.source !== "file") return;
  try {
    const gp = hostedGrantPath();
    const cur = JSON.parse(readFileSync(gp, "utf8")) as Record<string, unknown>;
    if (JSON.stringify(cur.limits) === JSON.stringify(limits) && JSON.stringify(cur.models) === JSON.stringify(models) && cur.recallMode === recallMode) return; // 没变（文件里已是这份）
    cur.limits = limits;
    cur.models = models;
    cur.recallMode = recallMode;
    const tmp = `${gp}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, gp);
  } catch {
    // 写不回去也不影响本进程（liveHostedLimits 已更新）
  }
}

/** 解除授权：删掉 hosted.json（尽力通知激活服务作废这把密钥），切回「自己配置」 */
async function handleHostedRevoke(): Promise<Response> {
  const g = loadHostedGrant();
  if (g?.source === "env") return jsonError(400, "授权来自环境变量 INTENT_LAB_HOSTED_URL / KEY，在页面上解除不了");
  const base = hostedAuthBase();
  if (g && base) {
    await fetch(`${base}/deactivate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: g.apiKey }), signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }
  rmSync(hostedGrantPath(), { force: true });
  setLiveHostedLimits(null);
  setLiveHostedModels(null);
  setEndpointMode("own");
  return handleGetConfig();
}

const UI_FILE = join(import.meta.dir, "..", "ui", "index.html");

// ---------- 路由 ----------

const CORE_MUTATING = new Set(["/recall", "/feedback", "/import", "/reset", "/ingest", "/invalidate"]);

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path === "/health" && req.method === "GET") return handleHealth();
  const isUiOrLocal = path === "/ui" || path === "/local" || path.startsWith("/local/");
  const isCoreMutating = req.method === "POST" && CORE_MUTATING.has(path);
  if (isUiOrLocal || isCoreMutating) {
    const denied = localGuard(req, url);
    if (denied) return denied;
  }
  if (isUiOrLocal) {
    if (path === "/ui" && req.method === "GET") {
      return existsSync(UI_FILE) ? new Response(Bun.file(UI_FILE), { headers: { "content-type": "text/html; charset=utf-8" } }) : jsonError(404, "ui/index.html 不存在");
    }
    if (path === "/local/sources" && req.method === "GET") return handleLocalSources();
    if (path === "/local/sessions" && req.method === "GET") return handleLocalSessions(url);
    if (path === "/local/recalls" && req.method === "GET") return handleLocalRecalls(url);
    if (path === "/local/verdicts" && req.method === "GET") return handleLocalVerdicts();
    if (path === "/local/config" && req.method === "GET") {
      await refreshHostedLimits();
      return handleGetConfig();
    }
    if (path === "/local/apps" && req.method === "GET") return Response.json({ ok: true, apps: loadLocalState().apps });
    if (path === "/local/prewarm" && req.method === "GET") return handlePrewarmStatus();
    if (req.method === "POST") {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return jsonError(400, "请求体不是合法 JSON");
      }
      if (path === "/local/verdicts/revoke") return handleRevokeVerdict(raw);
      if (path === "/local/config") return handlePostConfig(raw);
      if (path === "/local/hosted/activate") return handleHostedActivate(raw);
      if (path === "/local/prewarm") {
        const action = (raw as { action?: string } | null)?.action;
        if (action === "stop") {
          if (!hostedRecallServer()) localDriver?.abortPrewarm();
          if (hostedRecallServer()) {
            const g = loadHostedGrant();
            if (g) void remotePrewarmStop(g);
            stopRemotePrewarmPoll();
            Object.assign(prewarmJob, { phase: "stopped", finishedAt: Date.now(), etaMs: null });
          }
        } else if (action === "start") {
          if (!hostedRecallServer() && !localDriver?.prewarmTarget()) return jsonError(400, "当前模型端点不需要预热（没有启用 B 方案）");
          startPrewarmJob("管理页手动开始");
        } else return jsonError(400, "action 要是 start 或 stop");
        return handlePrewarmStatus();
      }
      if (path === "/local/hosted/revoke") {
        // 解除授权时一并删服务器上的自备 key
        const g0 = loadHostedGrant();
        if (g0) void remoteUserKeyDelete(g0);
        return handleHostedRevoke();
      }
      if (path === "/local/user-key") {
        const g = loadHostedGrant();
        if (!g) return jsonError(400, "先激活（用我们的服务器）才能设置自备 key");
        const bb = raw as { action?: string; key?: string } | null;
        if (bb?.action === "delete") {
          const ok = await remoteUserKeyDelete(g);
          writeHostedEngine("hosted-27b");
          return Response.json({ ok });
        }
        const key = bb?.key ?? "";
        if (!key.trim()) return jsonError(400, "key 不能为空");
        // 先拿这个 key 对 DeepSeek 官方做一次极小校验（列模型），失败给清楚的中文错误
        try {
          const probe = await fetch("https://api.deepseek.com/v1/models", { headers: { authorization: `Bearer ${key.trim()}` }, signal: AbortSignal.timeout(10_000) });
          if (probe.status === 401) return jsonError(400, "DeepSeek 说这个 key 无效（401）：检查有没有复制全、账户里能不能看到它");
          if (!probe.ok) return jsonError(502, `DeepSeek 校验没通过（HTTP ${probe.status}）：稍后再试或联系我们`);
        } catch (err) {
          return jsonError(502, `连不上 DeepSeek 官方做校验：${err instanceof Error ? err.message : String(err)}`);
        }
        const r = await remoteUserKeyPut(g, key.trim());
        if (!r.ok) return jsonError(502, `key 没存上（我们的服务器）：${r.error ?? "没响应"}`);
        return Response.json({ ok: true, last4: r.last4 });
      }
      if (path === "/local/apps") {
        const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const st = updateLocalState((s) => {
          if (typeof b.claude === "boolean") s.apps.claude = b.claude;
          if (typeof b.codex === "boolean") s.apps.codex = b.codex;
        });
        return Response.json({ ok: true, apps: st.apps });
      }
      return handleLocalPost(path, raw);
    }
  }
  if (path === "/recall" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonError(400, "请求体不是合法 JSON");
    }
    return handleRecall(req, raw);
  }
  if (path === "/feedback" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonError(400, "请求体不是合法 JSON");
    }
    return handleFeedback(raw);
  }
  if (path === "/import" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonError(400, "请求体不是合法 JSON");
    }
    return handleImport(raw);
  }
  if (path === "/reset" && req.method === "POST") return handleReset();
  if (path === "/ingest" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonError(400, "请求体不是合法 JSON");
    }
    return handleIngest(raw);
  }
  if (path === "/invalidate" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonError(400, "请求体不是合法 JSON");
    }
    return handleInvalidate(raw);
  }
  return jsonError(404, `没有这个接口：${req.method} ${path}`);
}

/** 蜂群展示口径：hosted-server = 授权 + 服务器下发；本地编排 = 驱动；都没有 = own 配置 */
function swarmViewOf(cfg: ReturnType<typeof loadConfig>): { endpoint: string; model: string; budgetMs: number; concurrency: number } {
  if (hostedRecallServer()) {
    const g = loadHostedGrant();
    return { endpoint: "hosted", model: g?.models.swarm ?? "", budgetMs: 1_800_000, concurrency: g?.limits.recallConcurrency ?? 256 };
  }
  if (localDriver) return localDriver.swarmView();
  return { endpoint: process.env.INTENT_LAB_SWARM_ENDPOINT ?? "swarm", model: cfg.swarm?.model ?? "", budgetMs: cfg.swarm?.recallBudgetMs ?? 300_000, concurrency: cfg.swarm?.recallConcurrency ?? 50 };
}

async function handleHealth(): Promise<Response> {
  const cfg = loadConfig();
  const swarm = cfg.swarm ? { name: process.env.INTENT_LAB_SWARM_ENDPOINT ?? "swarm", ep: cfg.swarm } : null;
  const sv = swarmViewOf(cfg);
  const source = historySource();
  const asOf = source === "proma" ? asOfFromEnv() : undefined; // qaVisible 反映生效截止（仅 proma 源有）
  const { qas } = await visibleQAsFor(asOf);
  const hosted = hostedRecallServer();
  const localH = localDriver?.health();
  // 未激活（endpointMode=hosted 但还没授权）：给统一的「先激活」提示——不管有没有本地驱动（公开树没有）
  // 未激活 = 想用/只能用我们的服务器却还没授权：公开树无本地驱动（全新安装还没写 endpointMode 也算），
  // 或配置明确写了 hosted
  const activationMissing = (!localDriver || endpointModeOf() === "hosted") && !loadHostedGrant();
  const h = hosted
    ? { ok: true }
    : activationMissing
      ? { ok: false, error: "还没有我们服务器的授权：先在管理页输入邀请码激活（概览第 ① 步）" }
      : (localH ?? (swarm && usable(cfg.main) ? { ok: true } : { ok: false, error: `swarm / main 端点未配置完整（INTENT_LAB_SWARM_ENDPOINT=${process.env.INTENT_LAB_SWARM_ENDPOINT ?? "swarm"}）` }));
  const ok = h.ok;
  return Response.json({
    ok,
    ...(ok ? {} : { error: h.error }),
    // 增量字段（10-12）：公开客户端没激活时插件据此提示「先激活」，不再走召回（会 501）
    ...(activationMissing ? { needsActivation: true } : {}),
    contract: 6 as const, // v6：/invalidate 作废 + 门卫 / S1 独立端点（health 加 s1）；v1–v5 字段全保留。s4 字段为 v6 增补（增量字段，未升 contract，旧客户端忽略）
    gate: (() => { const g = usable(cfg.gate) ? { endpoint: "gate", ep: cfg.gate! } : { endpoint: "swarm", ep: cfg.swarm ?? { model: "" } }; return { endpoint: g.endpoint, model: g.ep.model }; })(),
    s1: (() => { const s = usable(cfg.s1) ? { endpoint: "s1", model: cfg.s1!.model } : { endpoint: "main", model: cfg.main?.model ?? "" }; return s; })(),
    s4: (() => { const s = usable(cfg.s4) ? { endpoint: "s4", model: cfg.s4!.model } : { endpoint: "main", model: cfg.main?.model ?? "" }; return s; })(),
    source,
    qaImported: state().importRows.length,
    qaIngested: state().orbitaRows.length,
    qaVisible: qas.length,
    swarm: { endpoint: sv.endpoint, model: sv.model },
    main: { model: cfg.main?.model ?? "" },
    budgetMs: sv.budgetMs,
    peak: isDeepSeekPeak(),
    // v5：当前配置下能跑的 S3 预设与命名端点清单（只给名字与 model，不给 apiKey）
    s3Presets: s3PresetsOf(swarm, cfg),
    // 10-08：各 S3 预设（含不选预设时的 config）的 S3 缺省并发与上限——Orbita「跟随服务端 · N」用
    s3Concurrency: (() => {
      const out: Record<string, { default: number; max: number }> = {};
      const one = (preset: S3Preset | undefined): void => {
        const p = s3PlanOf(cfg, swarm, preset);
        if (!p.ok) return;
        out[preset ?? "config"] = { default: p.value.ep.recallConcurrency ?? 50, max: p.value.ep.maxRecallConcurrency ?? 256 };
      };
      one(undefined);
      for (const p of s3PresetsOf(swarm, cfg)) one(p);
      return out;
    })(),
    endpoints: namedEndpointsOf(cfg),
  });
}

export function buildServer(port = Number(process.env.INTENT_LAB_PORT ?? DEFAULT_PORT)): { port: number; stop: () => void } {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle, idleTimeout: 0 });
  return { port: server.port ?? port, stop: () => server.stop(true) };
}
