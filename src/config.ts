/**
 * 本地配置：放在仓库之外（~/.config/intent-lab/config.json），密钥不可能被 commit。
 *
 * {
 *   "main":  { "baseUrl": "...", "apiKey": "...", "model": "..." },   // S1 / S4 长上下文主模型（没单独配 gate / s1 / s4 时的缺省）
 *   "swarm": { "baseUrl": "https://api.deepseek.com", "apiKey": "sk-...", "model": "..." },  // S3 蜂群
 *   "endpoints": { "vllm27b": { "baseUrl": "http://…:8100/v1", "apiKey": "…", "model": "…", "timeoutMs": 600000 } },  // 备选端点，swarm --endpoint <名字> 选用
 *   "excludeSessions": ["c7e42462-…"]   // 考试时屏蔽的会话（复述过考点的）
 * }
 * 所有端点都是 OpenAI 兼容的 /chat/completions（baseUrl 要带到 /v1 这一级，DeepSeek 除外）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 并入请求体的额外字段，例如 DeepSeek 关思考：{ "thinking": { "type": "disabled" } } */
  extra?: Record<string, unknown>;
  /** 不该用这个端点的 UTC 时段（左闭右开），例如 DeepSeek 高峰 [[1,4],[6,10]] */
  avoidUtcHours?: Array<[number, number]>;
  /** 单次请求超时，默认 180 秒；本地 vLLM 高并发时单条要排队，放宽到 600 秒 */
  timeoutMs?: number;
  /** 一次 recall（服务端 /recall）的总时长上限毫秒数，缺省 300000；超时本轮不回答 */
  recallBudgetMs?: number;
  /** 服务端 /recall 的 S3 并发，缺省 50；本地 27B 实测 128 */
  recallConcurrency?: number;
  /** S3 第二步（写理由）的并发，默认同 recallConcurrency。第二步每条要写几百 token，同时跑的请求多显卡更划算；
   *  本地 vLLM 不要超过它的 --max-num-seqs（我们服务器上是 256） */
  reasonConcurrency?: number;
  /** 思考预算（thinking 算进 max_tokens 的主模型用，如 kimi-k3）：实际上限 = 调用点上限 + 该值。
   *  缺省 0（不思考或思考不计费的端点不用设） */
  thinkingTokens?: number;
  /** 固定 temperature（10-06）：有的网关只接受某个值（kimi-k3 现在只收 1），给了就覆盖调用方传的 temperature */
  fixedTemperature?: number;
  /** v3.4：S4 输出上限（主模型用，不设人为截断）。缺省 131072（kimi-k3 试）；
   *  网关拒绝并报上限时按报的值回退一次 */
  maxOutputTokens?: number;
  /** B 方案：这个端点是本地 vLLM 时启用（顺序 + 占位符 + 期望分 + 每岗一条线） */
  swarmB?: SwarmBConfig;
  /** S3 第一步消息顺序（10-08）：未设 = 旧顺序（说明 → 提问+意图 → QA）；"qa-first" = 新顺序
   *  （说明 → QA → 提问+意图+SCORE_ASK），读分方式与阈值完全不变。给自带前缀缓存的 API 端点用
   *  （DeepSeek 预设）——同一条 QA 的前缀跨召回一字不差，命中硬盘缓存省钱提速 */
  s3ScoreOrder?: "qa-first";
  /** 预热时同时处理的 QA 条数（2026-10-10）；缺省 16。「用我们的服务器」时由服务器下发 */
  prewarmConcurrency?: number;
  /** /recall 请求体 concurrency 的上限（10-08），缺省 256（本地 vLLM 的 --max-num-seqs）；
   *  远程 API 端点按需放宽，如 DeepSeek 配 300 */
  maxRecallConcurrency?: number;
}

/** S3 每岗阈值（10-05，B 方案）：六个岗位各一对（pass 过线 / high 入选）。
 *  不写就用全岗一对（INTENT_LAB_S3_PASS / INTENT_LAB_S3_HIGH）。 */
export interface S3SlotThresholds {
  pass: number[];
  high: number[];
}

/** B 方案（10-05）：S3 蜂群走本地 vLLM 时用。
 *  顺序 = 固定说明 → QA → 提问+意图；每条 QA 末尾补占位符；读期望分；每岗一条线。 */
export interface SwarmBConfig {
  /** 每岗阈值；不写就用全岗一对 */
  slotThresholds?: { pass: number[]; high: number[] };
  /** 每条 (qaId#段号) 的占位符个数文件路径（JSON：{"qaId#0": 123, …}） */
  padsFile?: string;
  /** 缓存块 token 数（vLLM 启动日志里的 block size；我们服务器 bf16 后是 800） */
  blockSize?: number;
  /** 召回时的调用（打分 / 写理由 / 门卫）是否也往 vLLM 的内存 / NVMe 层写缓存。默认 false：
   *  每个请求带 kv_transfer_params.max_offload_tokens = 0，只有预热请求写——带着提问的块换个提问就用不上，
   *  不拦的话每次召回往 NVMe 多写 19–58 GB（vLLM 的 fs 层没有容量上限，也不会自己删） */
  queryOffload?: boolean;
  /** 第二步的共用开头（写理由的说明 + 提问意图）补占位符凑整块、先预热一遍，一次召回里几百条理由请求共用它。默认 true；false = 旧做法 */
  reasonPad?: boolean;
  /** 两段打分（10-06）：第一步先用 B 方案 + 收尾指令海选全部段（读 NVMe 缓存），最高岗期望分 ≥ screen 的段
   *  再用旧顺序（说明 → 提问 → QA，开头补齐预热、助手回答截 aClip 字）复试，以复试分数为准。
   *  配了（且 enabled 不是 false）就启用；slotThresholds 是按复试分数定的每岗线，启用时取代上面那套。 */
  twoStage?: { enabled?: boolean; screen?: number; aClip?: number; slotThresholds?: { pass: number[]; high: number[] } };
  /** 指代说明（10-07 issue #2，缺省关）：开了才在复试（两段打分）与写理由的 QA 段开头加一行「（本段指代：A = …；昨天 = …）」。
 *  说明由 scripts/coref-annotate.ts 离线生成到 file；海选消息永远不带（保 NVMe 缓存）。开不开由用户定，不进默认配置 */
  coref?: { enabled?: boolean; file: string };
}

/** B 方案实际生效的每岗线：两段打分启用时用它自己的（按旧顺序复试分数定），否则用 swarmB.slotThresholds */
export function swarmBTwoStage(b?: SwarmBConfig): { screen: number; aClip: number } | null {
  const t = b?.twoStage;
  return t && t.enabled !== false ? { screen: t.screen ?? 0.3, aClip: t.aClip ?? 1500 } : null;
}
export function swarmBSlotThresholds(b?: SwarmBConfig): { pass: number[]; high: number[] } | undefined {
  return swarmBTwoStage(b) ? (b!.twoStage!.slotThresholds ?? b!.slotThresholds) : b?.slotThresholds;
}

/** 现在是否落在该端点要避开的时段；是的话返回命中的区间 */
export function inAvoidWindow(ep: LlmEndpoint, now = new Date()): [number, number] | null {
  const h = now.getUTCHours();
  return (ep.avoidUtcHours ?? []).find(([a, b]) => h >= a && h < b) ?? null;
}

export interface LabConfig {
  main?: LlmEndpoint;
  swarm?: LlmEndpoint;
  /** 门卫端点（v3）：不配就用 swarm（本地 27B） */
  gate?: LlmEndpoint;
  /** S1 意图识别端点（v6）：不配就用 main（长上下文主模型）。配置了就只接管 S1，S4 仍走 main */
  s1?: LlmEndpoint;
  /** S4 守门员端点（v6 增补，2026-10-08）：不配就用 main。配置了就只接管 S4（不影响 S1） */
  s4?: LlmEndpoint;
  /** 备选端点（如本地 vLLM），不覆盖 swarm / main，按名字选用 */
  endpoints: Record<string, LlmEndpoint>;
  excludeSessions: string[];
}

/** 端点填全了才算可用（模板里留空的字段视为未配置） */
export function usable(ep: LlmEndpoint | undefined): ep is LlmEndpoint {
  return !!ep && !!ep.baseUrl && !!ep.apiKey && !!ep.model;
}

/**
 * 按名字取端点：不给名字 = 默认的 swarm；"swarm" / "main" / "gate" / "s1" / "s4" 指配置里的同名字段；其余到 endpoints 里找。
 * 找不到或没填全就报错，并列出可用的名字。
 */
export function pickEndpoint(cfg: LabConfig, name?: string): { name: string; ep: LlmEndpoint } {
  const key = name ?? "swarm";
  const ep =
    key === "swarm" ? cfg.swarm : key === "main" ? cfg.main : key === "gate" ? cfg.gate : key === "s1" ? cfg.s1 : key === "s4" ? cfg.s4 : cfg.endpoints[key];
  if (!usable(ep)) {
    const names = ["swarm", "main", "gate", "s1", "s4", ...Object.keys(cfg.endpoints)].filter((n) =>
      usable(n === "swarm" ? cfg.swarm : n === "main" ? cfg.main : n === "gate" ? cfg.gate : n === "s1" ? cfg.s1 : n === "s4" ? cfg.s4 : cfg.endpoints[n]));
    throw new Error(`端点 ${key} 未配置或缺 baseUrl / apiKey / model（${configPath()}）。可用：${names.join(" / ") || "无"}`);
  }
  return { name: key, ep };
}

/** 配置目录名（2026-10-11）：公开树（intent-system）的入口把 INTENT_LAB_CONFIG_DIR 设成 intent-system，
 *  与私有版（intent-lab，缺省）在同一台机器上并存互不干扰——两者激活各自的邀请码不会互相改写。 */
export const INTENT_LAB_CONFIG_DIR_ENV = "INTENT_LAB_CONFIG_DIR";
export function configPath(): string {
  const dir = process.env.INTENT_LAB_CONFIG_DIR ?? "intent-lab";
  return process.env.INTENT_LAB_CONFIG ?? join(homedir(), ".config", dir, "config.json");
}

/**
 * 「用我们的服务器」的授权（2026-10-10）：服务器地址 + 每台电脑一个专属密钥，由我们发放——用户在
 * 管理页设置里输邀请码激活（/local/hosted/activate 向我们的激活服务换密钥），写进配置目录旁的
 * hosted.json；也可用环境变量 INTENT_LAB_HOSTED_URL / INTENT_LAB_HOSTED_KEY 给（自测用）。
 * 用户不填任何东西；配置文件里只记 endpointMode="hosted"，读配置时实时从授权取（密钥轮换 /
 * 吊销只换授权文件；用户自己的 main / swarm 原封不动，切回「自己配置」即用）。
 */
export interface HostedGrant {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 授权给谁（给界面显示，如内测用户名） */
  user?: string;
  /** 授权从哪来：管理页用邀请码激活写的文件 / 环境变量（后者在页面上解除不了） */
  source: "file" | "env";
  /** 服务器下发的并发（激活时带回、启动 / 召回 / 预热前刷新；界面不显示） */
  limits: HostedLimits;
  /** 服务器下发的模型名（同上刷新）：swarm = 门卫 / S1 / S3 用的 27B，s4 = 守门员（主模型）用的长上下文模型 */
  models: HostedModels;
  /** 10-10 B 方案：编排谁做。client（缺省）= 客户端自己拼提示词打分（经网关 /v1）；server = 召回核心做（/intent/v1，
 *  客户端只发提问 + QA 原文）。老版本没有该字段 = client */
  recallMode?: "client" | "server";
}

/** 服务器下发的模型名：网关按 model 分流（s4 的转给 1M 上下文的 DeepSeek，其余给我们的 27B） */
export interface HostedModels {
  swarm: string;
  s4: string;
}
/** 从没拿到过下发值时：swarm 用授权里的 model（旧激活结果只有这一项），s4 用当前约定的 deepseek-flash */
export const HOSTED_S4_DEFAULT_MODEL = "deepseek-flash";
export function parseHostedModels(raw: unknown, fallback: HostedModels): HostedModels {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof HostedModels): string => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : fallback[k]);
  return { swarm: pick("swarm"), s4: pick("s4") };
}

/** 10-10 B 方案：编排模式（服务器 /config 下发）；只有明确的 "server" 才算 server，其余一律 client（老服务器没这个字段） */
export function parseHostedRecallMode(raw: unknown, fallback: "client" | "server" = "client"): "client" | "server" {
  return raw === "server" ? "server" : raw === "client" ? "client" : fallback;
}

/** 服务器下发的并发：召回打分同时发几个请求、写理由同时发几个、预热同时处理几条 QA */
export interface HostedLimits {
  recallConcurrency: number;
  reasonConcurrency: number;
  prewarmConcurrency: number;
}
/** 第一次就拿不到服务器下发值时用（vLLM --max-num-seqs 256；预热 16 已跑满 GPU） */
export const HOSTED_LIMITS_DEFAULT: HostedLimits = { recallConcurrency: 256, reasonConcurrency: 256, prewarmConcurrency: 16 };

/** 从任意对象里取合法的 limits（缺的项用 fallback 补） */
export function parseHostedLimits(raw: unknown, fallback: HostedLimits = HOSTED_LIMITS_DEFAULT): HostedLimits {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof HostedLimits): number => {
    const v = Number(o[k]);
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback[k];
  };
  return { recallConcurrency: pick("recallConcurrency"), reasonConcurrency: pick("reasonConcurrency"), prewarmConcurrency: pick("prewarmConcurrency") };
}

/** 本进程最近一次从服务器拿到的下发值（环境变量授权时只存这里；文件授权同时写回 hosted.json） */
let liveHostedLimits: HostedLimits | null = null;
let liveHostedModels: HostedModels | null = null;
let liveHostedRecallMode: "client" | "server" | null = null;
export function setLiveHostedLimits(l: HostedLimits | null): void {
  liveHostedLimits = l;
}
export function setLiveHostedModels(m: HostedModels | null): void {
  liveHostedModels = m;
}
export function setLiveHostedRecallMode(m: "client" | "server" | null): void {
  liveHostedRecallMode = m;
}

/** 我们的激活服务（邀请码换专属密钥）：INTENT_LAB_HOSTED_AUTH 覆盖；内测期由我们部署 scripts/hosted-auth-server.ts */
export const HOSTED_AUTH_DEFAULT = "https://intent-auth.wublubdubdub.fyi";
export function hostedAuthBase(): string {
  return (process.env.INTENT_LAB_HOSTED_AUTH ?? HOSTED_AUTH_DEFAULT).replace(/\/+$/, "");
}

export const HOSTED_DEFAULT_MODEL = "qwen38-27b-nvfp4";

export function hostedGrantPath(): string {
  return join(dirname(configPath()), "hosted.json");
}

/** 配置文件写的端点模式：own（自己配置）/ hosted（用我们的服务器）；读不了配置当 own */
export function endpointModeOf(): "own" | "hosted" {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as { endpointMode?: string };
    return raw.endpointMode === "hosted" ? "hosted" : "own";
  } catch {
    return "own";
  }
}

export function loadHostedGrant(): HostedGrant | null {
  const envUrl = process.env.INTENT_LAB_HOSTED_URL;
  const envKey = process.env.INTENT_LAB_HOSTED_KEY;
  if (envUrl && envKey) {
    const model = process.env.INTENT_LAB_HOSTED_MODEL || HOSTED_DEFAULT_MODEL;
    return {
      baseUrl: envUrl, apiKey: envKey, model, source: "env", limits: liveHostedLimits ?? HOSTED_LIMITS_DEFAULT,
      models: liveHostedModels ?? { swarm: model, s4: HOSTED_S4_DEFAULT_MODEL },
      ...(liveHostedRecallMode || process.env.INTENT_LAB_HOSTED_RECALL_MODE === "server" || process.env.INTENT_LAB_HOSTED_RECALL_MODE === "client"
        ? { recallMode: (liveHostedRecallMode ?? process.env.INTENT_LAB_HOSTED_RECALL_MODE) as "client" | "server" }
        : {}),
    };
  }
  const p = hostedGrantPath();
  if (!existsSync(p)) return null;
  try {
    const g = JSON.parse(readFileSync(p, "utf8")) as Partial<HostedGrant>;
    if (typeof g.baseUrl !== "string" || !g.baseUrl || typeof g.apiKey !== "string" || !g.apiKey) return null;
    return {
      baseUrl: g.baseUrl, apiKey: g.apiKey, model: g.model || HOSTED_DEFAULT_MODEL, ...(g.user ? { user: g.user } : {}), source: "file",
      limits: liveHostedLimits ?? parseHostedLimits(g.limits), // 上一次拿到的（存在文件里）；从没拿到过 = 缺省
      models: liveHostedModels ?? parseHostedModels(g.models, { swarm: g.model || HOSTED_DEFAULT_MODEL, s4: HOSTED_S4_DEFAULT_MODEL }),
      ...(g.recallMode === "server" || g.recallMode === "client" ? { recallMode: g.recallMode } : {}),
    };
  } catch {
    return null;
  }
}

/** 现在是不是「用我们的服务器 · 编排在服务端」（B 方案）：不是 hosted 或没拿到 server 都返回 false。
 *  /recall、预热任务在每次请求前重音一遍（服务器翻开关后，客户端下一次请求就切过去，不用重启） */
export function hostedRecallServer(): boolean {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as { endpointMode?: string };
    if (raw.endpointMode !== "hosted") return false;
  } catch {
    return false;
  }
  return loadHostedGrant()?.recallMode === "server";
}

/** 召回核心的接口地址：授权 baseUrl（…/v1）去掉尾部 /v1，拼 /intent/v1/… */
export function hostedIntentUrl(g: HostedGrant, path: string): string {
  const root = g.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}${path}`;
}

export function loadConfig(): LabConfig {
  const p = configPath();
  if (!existsSync(p)) return { endpoints: {}, excludeSessions: [] };
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LabConfig> & { endpointMode?: string };
  if (raw.endpointMode === "hosted") {
    // 用我们的服务器：端点不再在这里组装（2026-10-11）——hosted-server 走召回核心（不需要端点），
    // hosted-client 由私有树的 recall-local 用 hosted-endpoints.ts 组装；这里只透传自定义 endpoints
    return {
      endpoints: raw.endpoints && typeof raw.endpoints === "object" ? raw.endpoints : {},
      excludeSessions: Array.isArray(raw.excludeSessions) ? raw.excludeSessions.filter((x) => typeof x === "string") : [],
    };
  }
  return {
    main: raw.main,
    swarm: raw.swarm,
    gate: raw.gate,
    s1: raw.s1,
    s4: raw.s4,
    endpoints: raw.endpoints && typeof raw.endpoints === "object" ? raw.endpoints : {},
    excludeSessions: Array.isArray(raw.excludeSessions) ? raw.excludeSessions.filter((x) => typeof x === "string") : [],
  };
}
