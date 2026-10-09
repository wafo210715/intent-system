/**
 * 「用我们的服务器 · 编排在服务端」（B 方案，10-10）的客户端侧：把一次召回发给召回核心（/intent/v1/recall），
 * 逐条转发事件流；核心的 done（带 result）回来后，由本地服务（server.ts）用本地数据做全部后处理
 * （注入块 / 上下文文件 / 边 / 待问队列）——插件与管理页看到的 8723 流与本地版一字不差。
 *
 * 预热也在这里代理：start / status / stop / pads 键集（算覆盖率用）。
 * 大请求体可选 gzip：INTENT_LAB_HOSTED_GZIP=1 开（两端都是 Bun，核心认 content-encoding: gzip）。
 */
import { hostedIntentUrl, type HostedGrant } from "./config.ts";
import { outcomeFromResult, packPrewarmPayload, packRecallPayload, unpackRecallResult, type CoreRecallEvent, type RecallResultV1 } from "./hosted-wire.ts";
import type { AskQueueItem } from "./asks-queue.ts";
import type { ConfirmState } from "./review.ts";
import type { ClientRecallOutcome, RecallEvent } from "./server-contract.ts";
import type { QA } from "./types.ts";

export class HostedRecallError extends Error {
  constructor(
    public stage: "config" | "gate" | "s1" | "s3" | "s4",
    public retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type HostedRecallRun =
  | { kind: "gate-skip"; gateWhy: string; gateMs: number; totalMs: number }
  | { kind: "outcome"; outcome: ClientRecallOutcome; gateMs: number }
  | { kind: "error" }; // 核心已把 error 事件发给 send 转发出去，本地不用再补

export interface HostedRecallOpts {
  grant: HostedGrant;
  /** 档位：deepseek-own = 用户自备 key 全链路 DeepSeek（核心会换端点）；缺省 hosted-27b */
  engine?: "deepseek-own";
  sessionId: string;
  turnId: string;
  title: string;
  q: string;
  force: boolean;
  qas: QA[];
  titleOf: (sid: string) => string;
  edgeVerdicts: Map<string, ConfirmState>;
  injectedBefore: Set<string>;
  prevContextMd?: string;
  pendingAsks?: AskQueueItem[];
  corefNotes?: Map<string, string>;
  send: (e: RecallEvent) => void;
  signal: AbortSignal;
}

/** 一次召回的核心事件 → 本地事件：accepted 与 done 不转发——accepted 本地已经发过（本地 qaTotal / 端点名），
 *  done 由调用方处理（result / gate-skip） */
function forwardCoreEvent(e: CoreRecallEvent, send: (e: RecallEvent) => void): void {
  if (e.type === "done" || e.type === "accepted") return;
  send(e as RecallEvent);
}

export async function runHostedRecall(opts: HostedRecallOpts): Promise<HostedRecallRun> {
  const startedAt = Date.now();
  const payload = packRecallPayload({
    ...(opts.engine ? { engine: opts.engine } : {}),
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    title: opts.title,
    q: opts.q,
    force: opts.force,
    qas: opts.qas,
    titleOf: opts.titleOf,
    edgeVerdicts: opts.edgeVerdicts,
    ...(opts.prevContextMd !== undefined ? { prevContextMd: opts.prevContextMd } : {}),
    ...(opts.pendingAsks?.length ? { pendingAsks: opts.pendingAsks } : {}),
    ...(opts.corefNotes?.size ? { corefNotes: opts.corefNotes } : {}),
    client: { name: "intent-lab" },
  });
  let body: BodyInit = JSON.stringify(payload);
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.grant.apiKey}`,
    "content-type": "application/json",
  };
  // gzip：默认开（2026-10-10 隧道实测 Cloudflare 原样放行 content-encoding: gzip 的请求体；文本约省 4–5×）。
  //  INTENT_LAB_HOSTED_GZIP=0 可关（万一有中间层不认）
  if (process.env.INTENT_LAB_HOSTED_GZIP !== "0" && (body as string).length > 1_000_000) {
    body = new Uint8Array(Bun.gzipSync(body as string));
    headers["content-encoding"] = "gzip";
  }
  let res: Response;
  try {
    res = await fetch(hostedIntentUrl(opts.grant, "/intent/v1/recall"), { method: "POST", headers, body, signal: opts.signal });
  } catch (err) {
    if (opts.signal.aborted) throw err;
    throw new HostedRecallError("config", true, `连不上我们的服务器：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok || !res.body) {
    const b = (await res.json().catch(() => ({}))) as { error?: unknown };
    const msg = typeof b.error === "string" ? b.error : (b.error as { message?: string } | undefined)?.message ?? `我们的服务器返回 HTTP ${res.status}`;
    throw new HostedRecallError("config", res.status >= 500 || res.status === 429, msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let gateMs = 0;
  const qaById = new Map(opts.qas.map((q) => [q.qaId, q]));
  const finish = (result: RecallResultV1): HostedRecallRun => ({
    kind: "outcome",
    outcome: outcomeFromResult(result, qaById, opts.titleOf, opts.injectedBefore),
    gateMs,
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev: CoreRecallEvent;
      try {
        ev = JSON.parse(line) as CoreRecallEvent;
      } catch {
        continue; // 半截行 / 非 JSON：跳过
      }
      if (ev.type === "stage" && ev.stage === "gate" && ev.status === "done" && typeof ev.ms === "number") gateMs = ev.ms;
      if (ev.type === "error") {
        forwardCoreEvent(ev, opts.send);
        return { kind: "error" };
      }
      if (ev.type === "done") {
        if ("result" in ev) {
          const parsed = unpackRecallResult(ev.result);
          if (!parsed.ok) throw new HostedRecallError("config", false, `召回核心回的结果不对：${parsed.error}`);
          return finish(parsed.value);
        }
        if (ev.skipped === "gate") {
          return { kind: "gate-skip", gateWhy: ev.gateWhy ?? "", gateMs, totalMs: Date.now() - startedAt };
        }
        // 本地形状的 done（不应出现）：当错误处理
        throw new HostedRecallError("config", false, "召回核心回的 done 事件不带 result");
      }
      forwardCoreEvent(ev, opts.send);
    }
    if (done) break;
  }
  // 流关了但没等到 done / error：按可重试错误处理（隧道断流）
  throw new HostedRecallError("config", true, "召回核心的流中途断了（没收到 done / error），重试会接着上次的进度");
}

// ---------- 预热代理（管理页 /local/prewarm 背后调这些） ----------

export interface RemotePrewarmMirror {
  /** 核心按最近几次预热实测的速率（条/秒）；没历史时 null——客户端用 6 条/秒兜底 */
  ratePerSec?: number | null;
  phase: "idle" | "queued" | "running" | "paused" | "done" | "stopped" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  qas: number;
  segs: number;
  failed: number;
  etaMs: number | null;
  error: string | null;
}

async function coreFetch(grant: HostedGrant, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  return fetch(hostedIntentUrl(grant, path), {
    ...rest,
    headers: { authorization: `Bearer ${grant.apiKey}`, ...(rest.body ? { "content-type": "application/json" } : {}), ...(rest.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 触发一次预热（全量或按会话增量）；qas 要按 scope 过滤好再传（增量只传相关会话的，省上传） */
export async function remotePrewarmStart(grant: HostedGrant, qas: QA[], titleOf: (sid: string) => string, scope: "full" | { sessionIds: string[] }): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await coreFetch(grant, "/intent/v1/prewarm", { method: "POST", body: JSON.stringify(packPrewarmPayload(qas, titleOf, scope)), timeoutMs: 120_000 });
    if (res.ok) return { ok: true };
    const b = (await res.json().catch(() => ({}))) as { error?: unknown };
    return { ok: false, error: typeof b.error === "string" ? b.error : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function remotePrewarmStatus(grant: HostedGrant): Promise<RemotePrewarmMirror | null> {
  try {
    const res = await coreFetch(grant, "/intent/v1/prewarm");
    if (!res.ok) return null;
    const b = (await res.json()) as { prewarm?: RemotePrewarmMirror };
    return b.prewarm ?? null;
  } catch {
    return null;
  }
}

export async function remotePrewarmStop(grant: HostedGrant): Promise<void> {
  await coreFetch(grant, "/intent/v1/prewarm", { method: "POST", body: JSON.stringify({ action: "stop" }) }).catch(() => undefined);
}

/** 该用户在核心侧的 pads 键集（k + 上次预热是否成功）——本地用它算覆盖率（没有原文，只有键） */
export async function remotePadsEntries(grant: HostedGrant): Promise<Record<string, { k: number; warmed: boolean }> | null> {
  try {
    const res = await coreFetch(grant, "/intent/v1/pads");
    if (!res.ok) return null;
    const b = (await res.json()) as { entries?: Record<string, { k: number; warmed: boolean }> };
    return b.entries ?? null;
  } catch {
    return null;
  }
}


// ---------- 用户自备 DeepSeek key（「自己配置」档）：存到服务器（加密落盘），界面只看末 4 位 ----------

export async function remoteUserKeyPut(grant: HostedGrant, key: string): Promise<{ ok: boolean; last4?: string; error?: string }> {
  try {
    const res = await coreFetch(grant, "/intent/v1/user-key", { method: "PUT", body: JSON.stringify({ key }), timeoutMs: 15_000 });
    if (res.ok) return (await res.json()) as { ok: boolean; last4?: string };
    const b = (await res.json().catch(() => ({}))) as { error?: unknown };
    return { ok: false, error: typeof b.error === "string" ? b.error : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function remoteUserKeyStatus(grant: HostedGrant): Promise<{ set: boolean; last4?: string | null } | null> {
  try {
    const res = await coreFetch(grant, "/intent/v1/user-key");
    if (!res.ok) return null;
    return (await res.json()) as { set: boolean; last4?: string | null };
  } catch {
    return null;
  }
}

export async function remoteUserKeyDelete(grant: HostedGrant): Promise<boolean> {
  try {
    return (await coreFetch(grant, "/intent/v1/user-key", { method: "DELETE" })).ok;
  } catch {
    return false;
  }
}