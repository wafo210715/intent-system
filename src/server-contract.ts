/**
 * Tier B 契约类型（v1）：intent-lab HTTP 服务 ↔ Orbita 钩子的对接接口。
 * 真源在审核会话的 spec/tier-b-contract.ts；两边靠这份契约对接，不许单边改。
 * 本文件只放类型与常量，不含实现。
 */

export const CONTRACT_VERSION = 1 as const;

/** 服务默认端口（环境变量 INTENT_LAB_PORT 可改）；只监听 127.0.0.1 */
export const DEFAULT_PORT = 8723;

/** v3 起 stage 含 "gate"（门卫在最前，round 恒为 1） */
export type RecallStage = "gate" | "s1" | "s3" | "s4";

/** 给人看的时间一律 GMT+8「MM-DD HH:mm」；时间戳一律毫秒 epoch */
export function fmtShort(ts: number): string {
  return new Date(ts + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
}

export interface SelectedView {
  qaId: string;
  /** MM-DD HH:mm */
  when: string;
  /** 该 QA 所在会话标题 */
  title: string;
  /** 岗名 */
  slots: string[];
  why: string;
  /** 在确认卡里、用户还没表态 */
  pending: boolean;
}

export interface AskView {
  /** run 内唯一 */
  askId: string;
  qaId: string;
  /** 岗名 */
  slot: string;
  /** 可点对/不对的陈述 */
  statement: string;
  /** 该 QA 在该岗报名时的原文摘句 */
  quote: string;
  when: string;
  title: string;
  whyUncertain: string;
}

/* ================================================================ 契约 v3.2 增量（2026-09-27 00:50，块 4：去重、守门员摘句、确认卡分轮、上下文文件、回写）
 * 真源见审核会话 spec/tier-b-contract.ts 末尾；只加不改，旧客户端解析不炸。 */

export const CONTRACT_VERSION_4 = 4 as const;

/** v3.2 §三：selected 每条对应一个入选 (qaId, 岗)，带守门员的逐字摘句与去重份数 */
export interface SelectedViewV32 extends SelectedView {
  /** 该岗分数（0–1，一位小数） */
  score: number;
  /** 用户原话里逐字摘的一段；摘不到时为原话全文 */
  human: string;
  /** 助手回答里逐字补的一段；不需要时为空串 */
  assistant: string;
  connection: string;
  prediction: string;
  /** 去重合并的份数，≥ 1 */
  dupCount: number;
}

/** v3.2 §四：done 事件与 /feedback 响应带回的上下文文件（Orbita 覆盖写到会话工作台） */
/* ================================================================ 召回结果（2026-10-11，B 方案）
 * 本地管线（私有树）与召回核心（服务端）产出的一次召回结果都是这个形状；客户端后处理
 * （注入块 / 上下文文件 / 边 / 待问队列）只依赖它。 */
import type { IntentObject, KeeperEntry, SwarmStats } from "./types.ts";
import type { AskQueueItem } from "./asks-queue.ts";
import type { Review } from "./review.ts";

export interface ClientRecallTiming {
  totalMs: number;
  s1Ms: number;
  s3Ms: number;
  s4Ms: number;
  s4PromptTokens: number;
}

export interface ClientRecallOutcome {
  intent: IntentObject;
  review: Review;
  bids: Array<{ qaId: string; slot: number }>;
  /** 「全部不表态」版本的注入块；needsFeedback=true 时等 /feedback 按表态重建 */
  injection: string;
  retried: boolean;
  dropped: string[];
  timing: ClientRecallTiming;
  s3Stats: SwarmStats;
  /** 每条 QA 的六岗分数（回写 s3 边用；hosted 下只含过线条目） */
  s3Scores: Array<{ qaId: string; scores: Array<number | null> }>;
  usage: Record<string, { calls: number; promptTokens: number; cachedTokens: number; completionTokens: number; thinkingTokens: number }>;
  runDir: string;
  /** 守门员：摘句条目、本轮要问的 ask、没问完存队列的、队列剩余数 */
  keeper?: {
    selected: KeeperEntry[];
    asksFinal: AskQueueItem[];
    overflow: AskQueueItem[];
    askRemaining: number;
    missing: string | null;
    dupGroups: number;
    dedup: { before: number; after: number };
    humanFallbacks: number;
  };
  edgeDropped: number;
  resumed?: { intent: boolean; scores: number; reasons: number };
}

export interface ContextFileV32 {
  /** 该会话第几问（从 1 起） */
  question: number;
  md: string;
  jsonl: string;
  /** 本问新增条数 */
  added: number;
  notice: string;
}

/* ================================================================ 契约 v3.3 增量（2026-09-27 02：00）
 * 只加两个可选字段，阶段条按节点逐格显示：review.dedup（去重前后的入选 (QA, 岗) 条数，before ≥ after）；
 * done.edgesWritten（本次回写的边数，门卫跳过时不给）。真源见审核会话 spec/tier-b-contract.ts 末尾。 */
export interface ReviewEventV33 {
  type: "review";
  summary: string;
  selected: SelectedViewV32[];
  ask: AskView[];
  askRemaining: number;
  missing?: string;
  retried: false;
  /** 去重前后的入选 (QA, 岗) 条数（before ≥ after；没合并时相等） */
  dedup?: { before: number; after: number };
}
/** v3.4：progress 事件的联合形状（真源 spec/tier-b-contract.ts 末尾 ProgressEventV34） */
export type ProgressEventV34 =
  | { type: "progress"; stage: "s3"; round: 1; step: 1 | 2; done: number; total: number; passed: number; etaMs: number | null }
  | { type: "progress"; stage: "s4"; round: 1; done: number; total: number; passed: number; etaMs: null };

export interface DoneEventV33 {
  type: "done";
  runId: string;
  injection: string;
  needsFeedback: boolean;
  skipped?: "gate";
  gateWhy?: string;
  context?: ContextFileV32;
  /** 本次 done 回写的边数（§六）；门卫跳过时不给 */
  edgesWritten?: number;
  timing: { totalMs: number; gateMs: number; s1Ms: number; s3Ms: number; s4Ms: number };
}

export type RecallEvent =
  | {
      type: "accepted";
      runId: string;
      qaTotal: number;
      swarm: { endpoint: string; model: string };
      budgetMs: number;
      peak: boolean;
      startedAt: number;
    }
  | { type: "stage"; stage: RecallStage; status: "start" | "done"; round: 1 | 2; ms?: number }
  | { type: "gate"; needIntent: boolean; why: string; forced: boolean }
  /** v3：S1 完成后发，多给 want，Orbita 展示 scene 与 want */
  | { type: "intent"; scene: string; want: string }
  | { type: "progress"; stage: "s3"; round: 1 | 2; step: 1 | 2; done: number; total: number; passed: number; etaMs: number | null }
  /** v3.4：S4 流式进度——done = 已写出的 selected 条数（数流里出现的 "qaId"）、total = 候选 (QA, 岗) 条数、passed = 已收到字符数；思考阶段 done=0、passed 照样涨 */
  | { type: "progress"; stage: "s4"; round: 1; done: number; total: number; passed: number; etaMs: null }
  | { type: "retry"; missing: string }
  | { type: "review"; summary: string; selected: SelectedViewV32[]; ask: AskView[]; askRemaining: number; missing?: string; retried: false; dedup?: { before: number; after: number } }
  | { type: "heartbeat"; t: number }
  | {
      type: "done";
      runId: string;
      injection: string;
      /** = ask.length>0；false 时 injection 为最终注入块；true 时为「全部不表态」版本，等 /feedback */
      needsFeedback: boolean;
      /** v3：门卫判定不做意图分析时为 "gate"；正常走完不给 */
      skipped?: "gate";
      /** v3：门卫跳过时附上它的理由（与 gate 事件同一句） */
      gateWhy?: string;
      /** v3.2 §四：正常走完时带回上下文文件全文；门卫跳过时不给 */
      context?: ContextFileV32;
      /** v3.3：本次 done 回写的边数（§六，有关 QA × 6）；门卫跳过时不给 */
      edgesWritten?: number;
      timing: { totalMs: number; gateMs: number; s1Ms: number; s3Ms: number; s4Ms: number };
    }
  | {
      type: "error";
      stage: RecallStage | "config" | "budget";
      message: string;
      retryable: boolean;
      elapsedMs: number;
    };

export interface RecallRequest {
  sessionId: string;
  /** Orbita 回显那条用户消息的 item id */
  turnId: string;
  /** 会话标题，没有就空串 */
  title: string;
  /** 用户原话，不含注入 */
  q: string;
  /** v3：收到 recent 一律忽略（不报错），本会话上下文归主模型管 */
  recent?: Array<{ q: string; a: string }>;
  /** v3：true = 跳过门卫直接做意图分析（卡片「手动跑一遍」用）。缺省 false */
  force?: boolean;
  /** 只看这一刻之前的历史，实验用 */
  asOf?: number;
  /** v5：请求级模型选择（gate / s1 / s4 各自可指端点，s3 选预设）；不带 = 沿用服务端配置 */
  models?: RecallModelsField;
  /** 10-08：S3 第一步并发。服务端夹在 [1, 端点上限]（本地 vLLM 缺省 256 / 端点 maxRecallConcurrency）；缺省 = 端点配置 */
  concurrency?: number;
  /** 10-08：S3 第二步（写理由）并发，夹法同 concurrency；缺省 = 端点配置或同第一步 */
  reasonConcurrency?: number;
  /** 10-08：本次召回总时长上限毫秒，夹在 [1000, 端点 recallBudgetMs]——只能调低不能超过配置；缺省 = 端点配置 */
  budgetMs?: number;
}

export interface FeedbackAnswer {
  askId: string;
  verdict: "yes" | "no" | "skip";
  /** 改字 = 矫正，可与任何 verdict 并存 */
  edited?: string;
}

export interface FeedbackRequest {
  runId: string;
  answers: FeedbackAnswer[];
  /** 用户补的一句背景 */
  note?: string;
}

export interface FeedbackResponse {
  ok: true;
  injection: string;
  edgesWritten: number;
}

/** v3.2 §四：表态后重写过的上下文文件全文（/feedback 响应带） */
export interface FeedbackResponseV32 extends FeedbackResponse {
  context: ContextFileV32;
}

export interface IngestRequest {
  sessionId: string;
  turnId: string;
  title: string;
  q: string;
  a: string;
  ts: number;
  /** v6：机器提问的标记（现在只有 "closing-scan"，Orbita 的收尾扫描）；服务端收到直接忽略不入库。
   *  Orbita 新版根本不会把扫描轮送来（客户端先拦），这个字段是旧版兑底 */
  kind?: "closing-scan";
}

export interface IngestResponse {
  ok: true;
  qaId: string;
  duplicate: boolean;
  /** v6 增补（2026-10-09）：true = 同 turnId 内容变了，作废旧行、按新内容入库了一条 */
  updated?: true;
  /** v6："closing-scan" = 这条是收尾扫描的机器提问，没入库（qaId 空串） */
  skipped?: "closing-scan";
}

/* ---------------------------------------------------------------- POST /import（v2 新增，路 1：迁移完成后一次性送来） */

export interface ImportRequest {
  /** 每行与 IngestRequest 同形；与 /ingest 共用去重键 (sessionId, turnId) */
  rows: IngestRequest[];
}

export interface ImportResponse {
  ok: true;
  imported: number;
  duplicates: number;
  /** v6：被跳过的收尾扫描行数（不入库也不算重复） */
  skipped?: number;
  /** v6 增补（2026-10-09）：同 (sessionId, turnId) 已在库但内容变了 → 作废旧行、按新内容入库的行数 */
  updated?: number;
}

/* ---------------------------------------------------------------- POST /reset（v2 新增：每组测试前两边清空，intent-lab 这边清这五类） */

export type ResetRequest = Record<string, never>;

export interface ResetResponse {
  ok: true;
  cleared: { imported: number; ingested: number; intents: number; injected: number; edges: number };
}

export interface HealthResponse {
  ok: true;
  contract: typeof CONTRACT_VERSION;
  qaVisible: number;
  swarm: { endpoint: string; model: string };
  main: { model: string };
  /** S3 端点配置的 recallBudgetMs，缺省 300000 */
  budgetMs: number;
  /** 此刻是否 DeepSeek 官方高峰（只提示不拦） */
  peak: boolean;
}

/* ================================================================ 契约 v3 增量（2026-09-26 19:40，块 2：①② 请求只带原话、门卫、S1 只读原话）
 * 只改 /recall；/feedback /ingest /import /reset 其余不变；/health 的 contract 改为 3 并加 gate 字段。
 * 真源见审核会话 spec/tier-b-contract.ts 末尾，不许单边改。 */

export const CONTRACT_VERSION_3 = 3 as const;

/** v3 请求：去掉 recent（服务端收到 recent 一律忽略，不报错）；加 force */
export interface RecallRequestV3 {
  sessionId: string;
  turnId: string;
  title: string;
  /** 用户原话，不含任何注入 */
  q: string;
  /** true = 跳过门卫，直接做意图分析（卡片「手动跑一遍」用）。缺省 false */
  force?: boolean;
  asOf?: number;
}

export type RecallStageV3 = "gate" | "s1" | "s3" | "s4";

/** v3 事件增量：stage 加 "gate"；新 gate 事件；intent 多带 want；done 多 skipped/gateWhy/timing.gateMs */
export interface GateEvent {
  type: "gate";
  needIntent: boolean;
  /** 一句给用户看的中文 */
  why: string;
  forced: boolean;
}

export interface DoneEventV3Fields {
  /** 门卫判定不做意图分析时为 "gate"；正常走完不给 */
  skipped?: "gate";
  /** 门卫跳过时附上它的理由（与 gate 事件同一句） */
  gateWhy?: string;
}

export interface HealthResponseV3 extends Omit<HealthResponseV2, "contract"> {
  contract: typeof CONTRACT_VERSION_3;
  gate: { endpoint: string; model: string };
}

export const CONTRACT_VERSION_2 = 2 as const;

/* ================================================================ 契约 v6 增量（2026-10-08）：作废（/invalidate）+ 门卫 / S1 独立端点
 * 只加不改：v1–v5 的行为一字不动；不调 /invalidate 的客户端完全无感。
 * 真源 spec/tier-b-contract.ts 末尾。 */

export const CONTRACT_VERSION_6 = 6 as const;

/** Orbita 收尾扫描的提问全文（常量真源在 Orbita src/renderer/src/features/chat/carryover-parse.ts 的
 *  CLOSING_SCAN_PROMPT，这里同步一份做兑底：旧版 Orbita 把扫描轮 /ingest 进来时直接忽略）。
 *  两边措辞一起改；不匹配也只是兑底失效，新 Orbita 根本不送。 */
export const CLOSING_SCAN_PROMPT = `这个会话已经完成了。回看整段对话，把还没做完的事（答应要做的、被岔开的、明确延后的）扫描出来。
只输出一个 fenced json 代码块，不要输出任何其他内容：
{"carryovers": [{"title": "一句话事项", "detail": "上下文摘录"}]}
没有就输出 {"carryovers": []}。
输出前逐条自检，结果会被程序严格解析，任何一条不合格整份作废：
- 整块是合法 JSON（字符串里的双引号与换行已转义，没有尾逗号、没有注释）；
- 每一项恰好有 title 和 detail 两个键，不重复、不缺、不多；
- title 是非空字符串，detail 是字符串，都不能是 null。
发现问题就整块重新生成，只交出通过自检的那一版。`;

/** v6：POST /invalidate 的请求体——Orbita 会话回退成功后，把被回退轮次的 turnId 送来。
 *  turnId 与 /ingest 时的同一份（回显 item id）。 */
export interface InvalidateRequest {
  sessionId: string;
  turnIds: string[];
}

/** v6：作废结果。幂等：重复送同一批 turnId，第二次 invalidated=0 照样 ok。
 *  unknown = 库里没这个 turnId 的轮（从未 /ingest 过）：不记作废（免得挡住它之后真的入库），只报数。
 *  context = 该会话重生成后的上下文文件全文（Orbita 覆盖写到会话工作台）；
 *  null = 该会话没有上下文文件了（从没跑过召回，或小节全部被去掉）——Orbita 侧删掉本地副本。 */
export interface InvalidateResponse {
  ok: true;
  /** 本次新记下的作废条数 */
  invalidated: number;
  /** 库里没找到的 turnId 个数 */
  unknown: number;
  context: { md: string; jsonl: string } | null;
}

/** v6：/health 加 s1 端点（S1 与 S4 从此可以分开配）。s4 字段为 v6 增补（2026-10-08，增量字段未升 contract，旧客户端忽略） */
export interface HealthResponseV6 extends Omit<HealthResponseV5, "contract"> {
  contract: typeof CONTRACT_VERSION_6;
  /** S1 意图识别用的端点（配置没配 s1 时 = main） */
  s1: { endpoint: string; model: string };
  /** S4 守门员用的端点（配置没配 s4 时 = main） */
  s4: { endpoint: string; model: string };
}

export const CONTRACT_VERSION_5 = 5 as const;

/* ================================================================ 契约 v5 增量（2026-10-07）：/recall 请求级模型选择（models）
 * 只加不改：不带 models 的请求与 v4 行为一字不差（各环节沿用服务端配置）。
 * gate / s1 / s4 各可指一个命名端点或内联 OpenAI 兼容端点；s3 只接受三套预设
 * （S3 依赖缓存、占位符与每岗阈值，不接受任意端点）。真源 spec/tier-b-contract.ts 末尾。 */

/** v5：S3 预设。two-stage = swarm 端点 + 两段打分（线上默认）；b-only = swarm 端点关掉两段打分、
 *  用 B 方案那套每岗线；deepseek = 配置里的 endpoints.deepseek，旧顺序单段。 */
export type S3Preset = "two-stage" | "b-only" | "deepseek";

/** v5：门卫 / S1 / S4 的模型选择——配置里的端点名（"swarm" / "main" / "gate" / "s1" / endpoints.*），
 *  或一个内联 OpenAI 兼容端点（Orbita 把自己配好的厂商直接发来；intent-lab 只监听 127.0.0.1）。 */
export type StageModelChoice =
  | string
  | {
      baseUrl: string;
      apiKey: string;
      model: string;
      /** 固定 temperature（门卫 / S1 走本地小模型时给 0）；缺省沿用环节自己的缺省（也是 0） */
      temperature?: number;
      /** false = 关思考（vLLM 的 Qwen 系：并入请求体 extra.chat_template_kwargs.enable_thinking=false）。只支持 false */
      thinking?: false;
      /** 该环节的输出 token 上限；缺省沿用环节自己的上限（门卫 200 / S1 800 / S4 端点 maxOutputTokens） */
      maxTokens?: number;
    };

/** v5：/recall 请求体的 models 字段。全部可选；不带 = 沿用服务端配置 */
export interface RecallModelsField {
  gate?: StageModelChoice;
  s1?: StageModelChoice;
  s4?: StageModelChoice;
  /** 缺省 = 不带（沿用服务端当前行为，线上即 two-stage） */
  s3?: S3Preset;
}

/** v5：/health 报的命名端点条目（只有名字与 model，**不给 apiKey**），供客户端下拉框用 */
export interface NamedEndpointView {
  model: string;
}

export interface HealthResponseV5 extends Omit<HealthResponseV2, "contract"> {
  contract: typeof CONTRACT_VERSION_5;
  gate: { endpoint: string; model: string };
  /** 当前配置下能跑的 S3 预设（请求 models.s3 只能从中选） */
  s3Presets: S3Preset[];
  /** 配置里填全的命名端点（swarm / main / gate / endpoints.*），只有名字与 model */
  endpoints: Record<string, NamedEndpointView>;
}

/** 历史从哪来：orbita（serve 的新默认）= 只用 /import 与 /ingest 存进来的 QA；
 *  proma = 旧版直接读 data/qa.jsonl（环境变量 INTENT_LAB_SOURCE=proma 才用） */
export type HistorySource = "orbita" | "proma";

export interface HealthResponseV2 extends Omit<HealthResponse, "contract"> {
  contract: typeof CONTRACT_VERSION_2;
  source: HistorySource;
  /** /import 存进来的条数 */
  qaImported: number;
  /** /ingest 存进来的条数 */
  qaIngested: number;
}
