/**
 * 最小的 OpenAI 兼容客户端：只做"发一次 /chat/completions，拿回 JSON"。
 *
 * 记录用量时顺带记下缓存命中（DeepSeek 返回 prompt_cache_hit_tokens，其他服务商字段名不同，
 * 这里兼容 OpenAI 的 prompt_tokens_details.cached_tokens）——全量竞拍的成本主要看它。
 */
import { appendFileSync } from "node:fs";
import type { LlmEndpoint } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** 思考 token（OpenAI 兼容网关的 reasoning_tokens / completion_tokens_details.reasoning_tokens；没有就 0） */
  thinkingTokens: number;
}

export interface JsonResult<T> {
  data: T;
  usage: Usage;
  ms: number;
  /** 模型原文与结束原因，诊断格式问题用（测试里的假实现可以不给） */
  raw?: string;
  finishReason?: string;
}

/** 设了 INTENT_LAB_RAW_LOG 时，把每次调用的原始输出追加到该 JSONL，用来查格式问题 */
export function rawLog(entry: Record<string, unknown>): void {
  const path = process.env.INTENT_LAB_RAW_LOG;
  if (path) appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

/** 可替换的调用函数：测试里注入假实现，生产用 callJson。
 *  v3.4：opts.onDelta 只在流式（makeCaller 的 stream: true）下被调，每收到一块正文就回调（思考段不算）。 */
export type JsonCaller = <T>(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; onDelta?: (delta: string) => void }) => Promise<JsonResult<T>>;

/** 模型常把 JSON 包在 ```json … ``` 里，或在前后加一句话；取最外层的 {…} */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`回复里没有 JSON：${text.slice(0, 120)}`);
  return JSON.parse(body.slice(start, end + 1));
}

export function readUsage(u: Record<string, unknown> | undefined): Usage {
  const details = (u?.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const compDetails = (u?.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    promptTokens: Number(u?.prompt_tokens ?? 0),
    completionTokens: Number(u?.completion_tokens ?? 0),
    cachedTokens: Number(u?.prompt_cache_hit_tokens ?? details.cached_tokens ?? 0),
    thinkingTokens: Number(u?.reasoning_tokens ?? compDetails.reasoning_tokens ?? 0),
  };
}

/** 可中断的 sleep：signal 触发时立即返回，保证取消后重试等待不再拖时间 */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  });

/** 合并外部取消信号与单次超时（AbortSignal.any 需要至少一个参数；undefined 会被 fetch 当无信号） */
export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal | undefined {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([timeout, signal]);
}

/** 读一个 SSE 流式响应：拼接 delta.content 成完整文本；思考段（reasoning_content / reasoning / reasoning_delta）忽略不拼；
 *  usage 从带它的 chunk 取（网关不给就 0）；onDelta 每收到一块正文就回调（进度用）。 */
async function readSse(
  res: Response,
  onDelta?: (delta: string) => void,
): Promise<{ content: string; usage: Usage | null; finishReason: string | undefined }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let usage: Usage | null = null;
  let finishReason: string | undefined;
  const handleLine = (line: string): void => {
    const s = line.trim();
    if (!s.startsWith("data:")) return; // 忽略 event: / 注释 / 空行
    const dataStr = s.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") return;
    let chunk: { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>; usage?: Record<string, unknown> };
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return; // 半截/坏行丢弃
    }
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (typeof chunk.choices?.[0]?.finish_reason === "string" && chunk.choices[0].finish_reason) finishReason = chunk.choices[0].finish_reason;
    if (chunk.usage) usage = readUsage(chunk.usage); // stream_options 要来的：一般只在最后一个 chunk 带
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // 最后一段可能是半行，留到下一块
    for (const line of lines) handleLine(line);
  }
  if (buf) handleLine(buf);
  return { content, usage, finishReason };
}

/** B 方案：召回时的请求不往 vLLM 的内存 / NVMe 层写缓存（只读预热好的前缀）。预热请求不走这里，照常写。
 *  只对配了 swarmB 的端点生效（DeepSeek 等不认这个字段的端点不带） */
export function queryKvParams(ep: LlmEndpoint): { kv_transfer_params?: { max_offload_tokens: number } } {
  return ep.swarmB && !ep.swarmB.queryOffload ? { kv_transfer_params: { max_offload_tokens: 0 } } : {};
}

export function makeCaller(
  ep: LlmEndpoint,
  { retries = 3, timeoutMs = ep.timeoutMs ?? 180_000, signal, stream = false }: { retries?: number; timeoutMs?: number; signal?: AbortSignal; stream?: boolean } = {},
): JsonCaller {
  const url = `${ep.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async <T>(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; onDelta?: (delta: string) => void } = {}): Promise<JsonResult<T>> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const t0 = Date.now();
      try {
        // Bun 的 fetch 自带 300 秒上限（与 signal 无关，实测 300.0 秒断开）；关掉它，超时只由 timeoutMs 管
        // 思考算进 max_tokens 的主模型（如 kimi-k3）：正文预算之上加显式思考预算，长上下文 S4 不至于思考一长就被截断
        const payload = {
          model: ep.model,
          messages,
          temperature: ep.fixedTemperature ?? opts.temperature ?? 0,
          max_tokens: (opts.maxTokens ?? 2048) + (ep.thinkingTokens ?? 0),
          response_format: { type: "json_object" },
          ...(ep.extra ?? {}),
          ...queryKvParams(ep),
          // v3.4：主模型走流式——Cloudflare 前置的网关对非流式响应 100 秒即 524，流式下思考阶段也有字节在走
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        };
        const res = await fetch(url, {
          timeout: false, // Bun 的 fetch 自带 300 秒上限（与 signal 无关），关掉它，超时只由 timeoutMs 管
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ep.apiKey}` },
          body: JSON.stringify(payload),
          signal: requestSignal(timeoutMs, signal),
        } as RequestInit);
        if (res.status === 429 || res.status >= 500) {
          // 限流与服务端错误会被重试、最终可能成功，不记下来就看不到；诊断时写进原始日志
          rawLog({ kind: "http-retry", model: ep.model, status: res.status, attempt, body: (await res.text()).slice(0, 300) });
          // v3.4：网关超时归一类人话（Cloudflare 524 = 非流式 100 秒首字节超时；502/504 同类）
          if (res.status === 524 || res.status === 502 || res.status === 504) throw new Error(`主模型网关 100 秒没回完（HTTP ${res.status}）`);
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), { fatal: true });
        let content: string;
        let usage: Usage; // 流式网关不给 usage 时为全 0（readUsage(undefined)）
        let choiceFinish: string | undefined;
        if (stream) {
          const r = await readSse(res, opts.onDelta);
          content = r.content;
          usage = r.usage ?? readUsage(undefined);
          choiceFinish = r.finishReason;
        } else {
          const body = (await res.json()) as {
            choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
            usage?: Record<string, unknown>;
          };
          const choice = body.choices?.[0];
          content = choice?.message?.content ?? "";
          usage = readUsage(body.usage);
          choiceFinish = choice?.finish_reason;
        }
        const choice = { finish_reason: choiceFinish };
        // 输出被 max_tokens 截断：原样重发多半还是截断，直接交给上层（S3 会把这批拆成两半重试）
        if (choice?.finish_reason === "length") {
          const u = usage;
          rawLog({ kind: "truncated", model: ep.model, completionTokens: u.completionTokens, thinkingTokens: u.thinkingTokens, tail: content.slice(-600) });
          throw Object.assign(new Error(`输出被截断（finish_reason=length，输出 ${u.completionTokens} tokens，其中思考 ${u.thinkingTokens}）`), { fatal: true });
        }
        let data: T;
        try {
          data = extractJson(content) as T;
        } catch (err) {
          rawLog({ kind: "parse-error", model: ep.model, finishReason: choice?.finish_reason, raw: content });
          throw err;
        }
        rawLog({ kind: "call", model: ep.model, stream, ms: Date.now() - t0, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, thinkingTokens: usage.thinkingTokens, finishReason: choice?.finish_reason ?? "" });
        return { data, usage, ms: Date.now() - t0, raw: content, finishReason: choice?.finish_reason };
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) break; // 已取消：不再重试、不再等待
        if ((err as { fatal?: boolean }).fatal) break; // 401/400 这类重试也没用
        await sleep(1000 * 2 ** attempt, signal);
      }
    }
    throw lastErr;
  };
}

/**
 * 并发池：最多 limit 个任务同时跑，结果按原顺序返回；单个失败不拖垮整批。
 * signal 触发后不再派发新任务（已在飞的交给任务自身的取消逻辑）。
 * onItemDone：每个任务 settle（成功或失败）时立刻回调——不是攒到全部结束；
 * 进度类回调必须走这里，绝不能在 pool 整体 resolve 之后的同步循环里发
 * （那会在结束时一拍内爆发几千条，且循环里的置同步计算会堵死事件循环、心跳全停）。
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  signal?: AbortSignal,
  onItemDone?: (i: number, result: R | Error) => void,
): Promise<Array<R | Error>> {
  const out: Array<R | Error> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) return; // 取消后不再派发新任务
      const i = next++;
      try {
        out[i] = await fn(items[i] as T, i);
      } catch (err) {
        out[i] = err instanceof Error ? err : new Error(String(err));
      }
      onItemDone?.(i, out[i] as R | Error);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  // 取消提前退出时，未派发的位置补一个 AbortError（否则调用方会读到 undefined）
  for (let i = 0; i < out.length; i++) {
    if (out[i] === undefined) out[i] = new DOMException("已取消", "AbortError");
  }
  return out;
}
