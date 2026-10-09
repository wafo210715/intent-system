/**
 * intent-lab 的核心数据类型。
 *
 * QA 是存储的最小单位：原文永不改写（S0 只加三行硬编码字段）。
 * 边和簇在后续阶段（S3/S7）才会写入，P0 只建空文件。
 */

/** QA 的来源：决定它承载多少"人的意图"（见 coordination-vs-orchestration v2 的 QA 非平等性） */
export type SourceType =
  /** 用户自己打字发起的一轮：权重 1 */
  | "human-direct"
  /** 助手用 AskUserQuestion 发问、用户作答：选项框架是 agent 给的，权重 0.5 */
  | "agent-to-human"
  /** 协作子 agent 会话（索引里有 parentSessionId）：权重 0，不进意图库 */
  | "agent-self"
  /** 定时任务触发的会话（索引里有 sourceAutomationId）：权重 0 */
  | "automation";

export const INTENT_WEIGHT: Record<SourceType, number> = {
  "human-direct": 1,
  "agent-to-human": 0.5,
  "agent-self": 0,
  automation: 0,
};

/** "昨天/上周"等相对时间换算成的绝对日期（硬编码字段 3） */
export interface ResolvedTime {
  /** 原文里的那几个字 */
  text: string;
  /** 在 q_text 中的起始下标 */
  index: number;
  /** 单日 YYYY-MM-DD，区间 YYYY-MM-DD..YYYY-MM-DD，或整月 YYYY-MM / 整年 YYYY */
  value: string;
}

/** 指回原始会话文件的行号区间（含首尾），需要 thinking / 工具流时再去读 */
export interface SourceRef {
  file: string;
  lineStart: number;
  lineEnd: number;
}

export interface QA {
  /** `${sessionId}:${turnIndex}`；AskUserQuestion 派生的 QA 追加 `:ask{n}` */
  qaId: string;
  sessionId: string;
  turnIndex: number;
  /** 硬编码 1：同一会话内前后 QA（只串 human-direct 主轮次） */
  prevQaId: string | null;
  nextQaId: string | null;
  /** 硬编码 2：绝对时间（毫秒，来自原始行的 _createdAt） */
  tsAbs: number;
  qText: string;
  aText: string;
  /** 硬编码 3 */
  qTimeResolved: ResolvedTime[];
  sourceType: SourceType;
  intentWeight: number;
  /** Q 里除文本外的附件块类型（image / document 等），只记类型不内联 */
  attachmentTypes: string[];
  /** 本轮助手调用了多少次工具（给会话打分用，判断讨论型还是执行型） */
  toolCallCount: number;
  source: SourceRef;
  /** 管辖：初始按会话分（待定 C） */
  shardId: string;
  /**
   * fork 出来的会话会把母会话的历史原样复制一份（同样的文字、同样的时间戳）。
   * 这类副本记下原件 qaId，权重置 0，不进意图库——否则同一条 QA 会在竞拍里出现两次。
   */
  duplicateOf?: string;
}

/** 会话元数据：来自 Proma 的 agent-sessions.json 索引 */
export interface SessionMeta {
  sessionId: string;
  title: string;
  workspaceId: string | null;
  createdAt: number;
  updatedAt: number;
  sourceType: SourceType;
  /** 数据来自哪个 Proma 实例 */
  origin: "proma-dev" | "proma";
  /** 会话文件存在但索引里没有这条 */
  indexMissing: boolean;
  qaCount: number;
  file: string;
}


/* ================================================================
 * 跨模块共享的纯数据形状与基础工具（2026-10-11 从各管线模块搬来，供客户端/服务端两侧共用；
 * 提示词与打分细节留在各自模块里，不随这些类型走）。 */

/** S1 意图识别的输出（读法）；定义在此处供存储 / 线上协议 / 展示共用 */
export interface IntentObject {
  /** 一句话场景："我们在聊……" */
  scene: string;
  /** 这次提问想要得到什么 */
  want: string;
  /** 约束：时间范围（能从问题里读出的）、关键词 */
  constraints: { after?: string | null; before?: string | null; keywords: string[] };
}

/** 六个岗的名称（id → 名称；打分细则与提示词在管线模块里，这里只有展示用的名字） */
export const SLOT_NAMES = [
  { id: 1, name: "同一件事" },
  { id: 2, name: "同一目的" },
  { id: 3, name: "同构机制" },
  { id: 4, name: "取舍标准" },
  { id: 5, name: "约束条件" },
  { id: 6, name: "时序与修订" },
] as const;

export const slotNameOf = (id: number): string => SLOT_NAMES.find((s) => s.id === id)?.name ?? `岗${id}`;

/** S3 第二步的一条报名（连接 / 预测 / 摘句）；分数与段号可选 */
export interface Bid {
  qaId: string;
  slot: number;
  connection: string;
  prediction: string;
  /** 从用户原话逐字摘的一句，证明连接不是推想出来的（v3.5 起作为上下文条目的 human） */
  evidence: string;
  /** 助手回答里逐字补的一段；不需要或校验失败为空串（v3.5） */
  assistant: string;
  /** 两步打分（块 3）：该 (QA, 岗) 的第一步分数与最高分段号 */
  score?: number;
  segIndex?: number;
}

/** S3 蜂群一趟的统计（计数与耗时；不含任何提示词） */
export interface SwarmStats {
  qaTotal: number;
  batches: number;
  failedBatches: number;
  qaPassed: number;
  passRate: number;
  bidsBySlot: Record<number, number>;
  gateRejected: number;
  /** 被门槛打回的原因分布 */
  rejectReasons: Record<string, number>;
  /** 解析时兜住的结构偏差（见 parseSwarmOutput） */
  repairReasons: Record<string, number>;
  /** 单条截断后换温度重试成功的次数 */
  truncRetried: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  wallMs: number;
  callMsP50: number;
  callMsP95: number;
  /** call 闭包的调用次数（含截断重试与拆半重试的每一次） */
  callAttempts: number;
  /** 其中抛错的次数——服务端用它判 S3 是否坏了，不能静默降级 */
  failedCalls: number;
  /** 两步打分：第一步（打分）与第二步（理由）各自的耗时；segments = 打分段的总量 */
  scoreMs: number;
  reasonMs: number;
  segments: number;
  /** 两段打分（10-06）：海选用时、复试段数与用时；没启用就不带。rescoreResumed = 断点续传复用的复试段数 */
  twoStage?: { screen: number; screenMs: number; rescoreSegments: number; rescoreQas: number; rescoreResumed: number; rescoreMs: number; qPad: number | null };
}

/** 上下文条目（v3.5：S3 第二步产出，不经主模型筛选） */
export interface KeeperEntry {
  qaId: string;
  slot: number;
  /** 该岗分数（去重合并后的最高分，0–1） */
  score: number;
  /** 用户原话里逐字摘的一段（= S3 的 evidence）；摘不到时为原话全文（humanFallback = true） */
  human: string;
  /** 助手回答里逐字补的一段；不需要或校验失败为空串 */
  assistant: string;
  connection: string;
  prediction: string;
  /** 去重合并的份数，≥ 1 */
  dupCount: number;
  humanFallback: boolean;
}
