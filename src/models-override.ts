/**
 * 契约 v5：/recall 请求体 models 字段的解析与落地。
 *
 * 纪律：**不改 ~/.config 的任何文件**——命名端点按名字取（pickEndpoint），
 * 内联端点构造临时 LlmEndpoint（temperature / thinking / maxTokens 并进去），
 * S3 预设按请求变换 swarm 端点（b-only 关 twoStage、deepseek 换端点并剥掉 swarmB），
 * 全部只活在这一次请求里，下一次请求（不带 models）回到服务端配置。
 *
 * 纯模块（bun test 直接测），被 server.ts 用。
 */
import { pickEndpoint, swarmBTwoStage, usable, type LabConfig, type LlmEndpoint } from "./config.ts";
import type { JsonCaller } from "./llm.ts";
import type { RecallModelsField, S3Preset, StageModelChoice } from "./server-contract.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** 解析请求体的 models 字段：形状校验（不碰配置——端点名存不存在在落地时才判）。缺省 / undefined = 不带 */
export function parseModelsField(raw: unknown): Parsed<RecallModelsField | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "models 必须是 JSON 对象" };
  const b = raw as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (key !== "gate" && key !== "s1" && key !== "s4" && key !== "s3") {
      return { ok: false, error: `models.${key} 不是可识别的键（只有 gate / s1 / s4 / s3）` };
    }
  }
  const out: RecallModelsField = {};
  if (b.s3 !== undefined) {
    if (b.s3 !== "two-stage" && b.s3 !== "b-only" && b.s3 !== "deepseek") {
      return { ok: false, error: `models.s3 只能是 two-stage / b-only / deepseek 之一（收到 ${JSON.stringify(b.s3)}）` };
    }
    out.s3 = b.s3;
  }
  for (const stage of ["gate", "s1", "s4"] as const) {
    const v = b[stage];
    if (v === undefined) continue;
    if (typeof v === "string") {
      if (!v.trim()) return { ok: false, error: `models.${stage} 端点名不能为空串` };
      out[stage] = v;
      continue;
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { ok: false, error: `models.${stage} 只能是端点名（字符串）或 { baseUrl, apiKey, model, … } 对象` };
    }
    const o = v as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (!["baseUrl", "apiKey", "model", "temperature", "thinking", "maxTokens"].includes(key)) {
        return { ok: false, error: `models.${stage}.${key} 不是可识别的键（baseUrl / apiKey / model / temperature / thinking / maxTokens）` };
      }
    }
    for (const key of ["baseUrl", "apiKey", "model"] as const) {
      if (typeof o[key] !== "string" || !(o[key] as string).trim()) {
        return { ok: false, error: `models.${stage}.${key} 必须是非空字符串` };
      }
    }
    if (o.temperature !== undefined) {
      if (typeof o.temperature !== "number" || !Number.isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2) {
        return { ok: false, error: `models.${stage}.temperature 必须是 0–2 的数字` };
      }
    }
    if (o.thinking !== undefined && o.thinking !== false) {
      return { ok: false, error: `models.${stage}.thinking 只支持 false（关思考）；开思考不要带这个键` };
    }
    if (o.maxTokens !== undefined) {
      if (typeof o.maxTokens !== "number" || !Number.isInteger(o.maxTokens) || o.maxTokens <= 0) {
        return { ok: false, error: `models.${stage}.maxTokens 必须是正整数` };
      }
    }
    out[stage] = o as Extract<StageModelChoice, { baseUrl: string }>;
  }
  return { ok: true, value: Object.keys(out).length ? out : undefined };
}

/** 一个环节最终用哪个端点：choice 缺省 = 服务端配置（fallback() 给）；命名端点按配置原样（配置即真相，
 *  不接受在命名端点上再叠 temperature / thinking——那两样配在配置里）；内联端点构造临时 LlmEndpoint。 */
export interface StageModelPlan {
  name: string;
  ep: LlmEndpoint;
  /** 内联覆盖才有的参数：输出上限（环节调用点的 maxTokens 再 min 一道） */
  maxTokens?: number;
  /** true = 内联构造（temperature / thinking 来自请求，不是配置） */
  inline: boolean;
  /** true = 请求里指了这个环节的模型（命名或内联都算）；false = fallback（服务端配置） */
  overridden: boolean;
}

export function stageModelOf(
  cfg: LabConfig,
  stage: "gate" | "s1" | "s4",
  choice: StageModelChoice | undefined,
  fallback: () => { name: string; ep: LlmEndpoint },
): Parsed<StageModelPlan> {
  if (choice === undefined) return { ok: true, value: { ...fallback(), inline: false, overridden: false } };
  if (typeof choice === "string") {
    try {
      // pickEndpoint 只认 swarm / main / endpoints.*；门卫自己的配置键单独认一下
      const named = choice === "gate" && usable(cfg.gate) ? { name: "gate", ep: cfg.gate! } : pickEndpoint(cfg, choice);
      return { ok: true, value: { name: named.name, ep: named.ep, inline: false, overridden: true } };
    } catch (err) {
      return { ok: false, error: `models.${stage}：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const ep: LlmEndpoint = {
    baseUrl: choice.baseUrl.replace(/\/+$/, ""),
    apiKey: choice.apiKey,
    model: choice.model,
    ...(choice.temperature !== undefined ? { fixedTemperature: choice.temperature } : {}),
    ...(choice.thinking === false ? { extra: { chat_template_kwargs: { enable_thinking: false } } } : {}),
  };
  return {
    ok: true,
    value: { name: `${stage}:${choice.model}（请求内联）`, ep, ...(choice.maxTokens !== undefined ? { maxTokens: choice.maxTokens } : {}), inline: true, overridden: true },
  };
}

/** 输出上限封顶：调用点想用多少（缺省 2048）与 cap 取小。内联 maxTokens 的落地方式。 */
export function capMaxTokens(inner: JsonCaller, cap: number): JsonCaller {
  return (messages, opts = {}) => inner(messages, { ...opts, maxTokens: Math.min(opts.maxTokens ?? 2048, cap) });
}

/** /recall 请求体的 S3 旋钮落地（10-08）：并发 / 时长上限。请求值夹在端点范围内，不给 = 端点配置。
 *  并发 [1, maxRecallConcurrency（缺省 256 = 本地 vLLM 的 --max-num-seqs）]；budgetMs [1000, recallBudgetMs]（只能调低不能超过配置） */
export function recallKnobsOf(
  ep: LlmEndpoint,
  req: { concurrency?: number; reasonConcurrency?: number; budgetMs?: number } | undefined,
): { concurrency: number; reasonConcurrency: number; budgetMs: number; concCap: number } {
  const concCap = ep.maxRecallConcurrency ?? 256;
  const concurrency = req?.concurrency != null ? Math.max(1, Math.min(Math.round(req.concurrency), concCap)) : ep.recallConcurrency ?? 50;
  const reasonConcurrency = req?.reasonConcurrency != null ? Math.max(1, Math.min(Math.round(req.reasonConcurrency), concCap)) : ep.reasonConcurrency ?? concurrency;
  const budgetMs = req?.budgetMs != null ? Math.max(1_000, Math.min(req.budgetMs, ep.recallBudgetMs ?? 300_000)) : ep.recallBudgetMs ?? 300_000;
  return { concurrency, reasonConcurrency, budgetMs, concCap };
}

/** S3 端点按预设变换（不动配置文件，只活在本次请求）：preset 缺省 = 服务端当前行为 */
export interface S3Plan {
  name: string;
  ep: LlmEndpoint;
  /** "config" = 请求没选预设（沿用配置）；否则为所选预设 */
  preset: S3Preset | "config";
}

export function s3PlanOf(cfg: LabConfig, swarm: { name: string; ep: LlmEndpoint } | null, preset: S3Preset | undefined): Parsed<S3Plan> {
  if (swarm === null) return { ok: true, value: { name: "swarm", ep: { baseUrl: "", apiKey: "", model: "" }, preset: "config" } }; // 服务层随后按 config 报错（v4 行为）
  if (preset === undefined || preset === "two-stage") {
    if (preset === "two-stage" && swarmBTwoStage(swarm.ep.swarmB) == null) {
      return { ok: false, error: "S3 预设 two-stage 需要 swarm 端点配 swarmB.twoStage（当前配置没有）" };
    }
    return { ok: true, value: { name: swarm.name, ep: swarm.ep, preset: preset ?? "config" } };
  }
  if (preset === "b-only") {
    if (!swarm.ep.swarmB) return { ok: false, error: "S3 预设 b-only 需要 swarm 端点配 swarmB（B 方案的占位符与每岗线）" };
    return {
      ok: true,
      value: { name: swarm.name, ep: { ...swarm.ep, swarmB: { ...swarm.ep.swarmB, twoStage: undefined } }, preset },
    };
  }
  try {
    const ds = pickEndpoint(cfg, "deepseek");
    // 10-08 用户定：DeepSeek 预设换新顺序（说明 → QA → 提问+意图+SCORE_ASK），读分方式与阈值完全不变，
    // 只吃 API 自带的前缀硬盘缓存；swarmB 仍剥掉（B 方案的占位符 / 期望分 / 两段是本地 vLLM 专属）
    return { ok: true, value: { name: ds.name, ep: { ...(ds.ep.swarmB ? { ...ds.ep, swarmB: undefined } : ds.ep), s3ScoreOrder: "qa-first" }, preset } };
  } catch (err) {
    return { ok: false, error: `S3 预设 deepseek 需要 endpoints.deepseek：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** /health 报的可用 S3 预设：two-stage 要配置里真开了两段打分；b-only 要有 swarmB；deepseek 要有这个命名端点 */
export function s3PresetsOf(swarm: { ep: LlmEndpoint } | null, cfg: LabConfig): S3Preset[] {
  const out: S3Preset[] = [];
  const b = swarm?.ep.swarmB;
  if (b) {
    if (swarmBTwoStage(b)) out.push("two-stage");
    out.push("b-only");
  }
  if (usable(cfg.endpoints.deepseek)) out.push("deepseek");
  return out;
}

/** /health 报的命名端点（填全的才报；只有名字与 model，不给 apiKey） */
export function namedEndpointsOf(cfg: LabConfig): Record<string, { model: string }> {
  const out: Record<string, { model: string }> = {};
  if (usable(cfg.swarm)) out.swarm = { model: cfg.swarm.model };
  if (usable(cfg.main)) out.main = { model: cfg.main.model };
  if (usable(cfg.gate)) out.gate = { model: cfg.gate.model };
  if (usable(cfg.s1)) out.s1 = { model: cfg.s1.model };
  if (usable(cfg.s4)) out.s4 = { model: cfg.s4.model };
  for (const [name, ep] of Object.entries(cfg.endpoints)) if (usable(ep) && !(name in out)) out[name] = { model: ep.model };
  return out;
}
