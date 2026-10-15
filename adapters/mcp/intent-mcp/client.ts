/**
 * intent-mcp：意图系统的 MCP 适配（2026-10-14）。
 *
 * 后端 = 本机 intent 服务（bun run serve，127.0.0.1:8723，契约 v6）；管理 = 服务自带的
 * 管理页 /ui；本包只做消费端接入——把 recall / feedback / ingest / 来源同步封装成 MCP 工具，
 * 给任何会调 MCP 的 agent（Proma / Claude Code / Codex）用。
 *
 * 典型一轮（agent 侧纪律，写进工具描述里）：
 *   1. intent_health   确认服务在、已激活、qaVisible > 0
 *   2. intent_sync     （可选）先增量同步本机来源，召回才看得到最新对话
 *   3. intent_recall   用户原话 → done.injection（needsFeedback=true 时是「全部不表态」版）
 *   4. 有 ask 就问用户（对/不对/改字），然后 intent_feedback 拿最终 injection
 *   5. 回答用户（injection 作为可参考的上下文，用不上就忽略）
 *   6. intent_ingest   回答正常结束后回写这一轮（出错/取消的轮不写）
 *
 * 与 Claude Code 插件的差异：插件靠 hook 硬拦截每句话；MCP 是软集成，由 agent 自觉按上面
 * 的顺序调用——这是使用方要写进自己系统提示/Skill 的纪律，本包管不了。
 */

export const DEFAULT_BASE = "http://127.0.0.1:8723";

export interface IntentClientOpts {
  baseUrl?: string;
  /** /recall 的静默判定：服务心跳 10 秒一次，超过这么久没收到任何一行判死 */
  silenceMs?: number;
  /** /recall 的总上限（缺省 45 分钟；服务侧 budgetMs 才是硬约束，这只是客户端兜底） */
  maxRunMs?: number;
}

const UNREACHABLE =
  "连不上本机 intent 服务：先启动（cd intent-system && bun run serve，管理页 http://127.0.0.1:8723/ui）";

function baseOf(opts?: IntentClientOpts): string {
  return (opts?.baseUrl ?? process.env.INTENT_MCP_URL ?? DEFAULT_BASE).replace(/\/$/, "");
}

async function getJson(path: string, opts?: IntentClientOpts, timeoutMs = 10_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseOf(opts)}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(UNREACHABLE);
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `intent 服务返回 HTTP ${res.status}`);
  return body;
}

async function postJson(path: string, body: unknown, opts?: IntentClientOpts, timeoutMs = 30_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseOf(opts)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  const parsed = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) throw new Error(typeof parsed?.error === "string" ? parsed.error : `intent 服务返回 HTTP ${res.status}`);
  return parsed;
}

// ---------------- 工具 1：health ----------------

export interface HealthResult {
  ok: boolean;
  reachable: boolean;
  needsActivation?: boolean;
  contract?: number;
  qaVisible?: number;
  qaImported?: number;
  qaIngested?: number;
  models?: Record<string, string>;
  apps?: Record<string, boolean>;
  hint?: string;
}

export async function intentHealth(opts?: IntentClientOpts): Promise<HealthResult> {
  let h: Record<string, unknown>;
  try {
    h = (await getJson("/health", opts)) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reachable: false, hint: err instanceof Error ? err.message : String(err) };
  }
  const apps = (await getJson("/local/apps", opts).catch(() => null)) as { apps?: Record<string, boolean> } | null;
  const needsActivation = h.needsActivation === true;
  return {
    ok: h.ok === true,
    reachable: true,
    ...(needsActivation ? { needsActivation: true } : {}),
    contract: h.contract as number | undefined,
    qaVisible: h.qaVisible as number | undefined,
    qaImported: h.qaImported as number | undefined,
    qaIngested: h.qaIngested as number | undefined,
    models: {
      gate: (h.gate as { model?: string } | undefined)?.model ?? "",
      s1: (h.s1 as { model?: string } | undefined)?.model ?? "",
      s4: (h.s4 as { model?: string } | undefined)?.model ?? "",
      swarm: (h.swarm as { model?: string } | undefined)?.model ?? "",
    },
    apps: apps?.apps,
    ...(needsActivation
      ? { hint: "服务还没激活：打开管理页 http://127.0.0.1:8723/ui 输入邀请码激活后再召回" }
      : h.ok !== true
        ? { hint: typeof h.error === "string" ? h.error : "服务未就绪" }
        : {}),
  };
}

// ---------------- 工具 2：recall（NDJSON 流） ----------------

export interface RecallArgs {
  q: string;
  sessionId: string;
  turnId?: string;
  title?: string;
  force?: boolean;
  /** done.context 的 md 内联返回上限（字符），超出只回 notice 与统计；0 = 不内联 */
  contextInlineMax?: number;
}

export interface RecallResult {
  status: "done" | "skipped" | "error";
  runId?: string;
  /** skipped 时：门卫理由 */
  gateWhy?: string;
  intent?: { scene?: string; want?: string };
  review?: {
    summary?: string;
    selectedCount: number;
    selected: Array<{ qaId: string; title: string; when: string; slots: string[]; why: string; connection?: string }>;
    askRemaining: number;
  };
  needsFeedback?: boolean;
  /** needsFeedback=true 时：要问用户的确认卡条目（原样转给用户点 对/不对/改字，再调 intent_feedback） */
  asks?: Array<Record<string, unknown>>;
  /** 注入块：done 的版本（needsFeedback=true 时是「全部不表态」版；feedback 后才是最终版） */
  injection?: string;
  context?: { question?: number; added?: number; notice?: string; md?: string; mdTruncated?: boolean };
  timing?: Record<string, number>;
  error?: { stage: string; message: string; retryable: boolean };
}

export async function intentRecall(args: RecallArgs, opts?: IntentClientOpts): Promise<RecallResult> {
  const turnId = args.turnId ?? `mcp-${Date.now().toString(36)}`;
  const silenceMs = opts?.silenceMs ?? 75_000;
  const maxRunMs = opts?.maxRunMs ?? 45 * 60_000;
  let res: Response;
  try {
    res = await fetch(`${baseOf(opts)}/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: args.sessionId, turnId, title: args.title ?? "", q: args.q, ...(args.force ? { force: true } : {}) }),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `intent 服务返回 HTTP ${res.status}`);
  }

  const out: RecallResult = { status: "error" };
  const reviewAcc: NonNullable<RecallResult["review"]> = { selectedCount: 0, selected: [], askRemaining: 0 };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastEventAt = Date.now();
  const startedAt = lastEventAt;

  const handleLine = (line: string): boolean => {
    lastEventAt = Date.now();
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false; // 半截行跳过
    }
    const t = e.type;
    if (t === "intent") out.intent = { scene: e.scene as string | undefined, want: e.want as string | undefined };
    else if (t === "review") {
      reviewAcc.summary = e.summary as string | undefined;
      const selected = Array.isArray(e.selected) ? (e.selected as Array<Record<string, unknown>>) : [];
      reviewAcc.selectedCount = selected.length;
      reviewAcc.selected = selected.map((s) => ({
        qaId: String(s.qaId ?? ""),
        title: String(s.title ?? ""),
        when: String(s.when ?? ""),
        slots: Array.isArray(s.slots) ? (s.slots as string[]) : [],
        why: String(s.why ?? ""),
        ...(typeof s.connection === "string" ? { connection: s.connection } : {}),
      }));
      reviewAcc.askRemaining = typeof e.askRemaining === "number" ? e.askRemaining : 0;
      out.asks = Array.isArray(e.ask) ? (e.ask as Array<Record<string, unknown>>) : [];
      out.review = reviewAcc;
    } else if (t === "done") {
      out.status = e.skipped === "gate" ? "skipped" : "done";
      out.runId = e.runId as string | undefined;
      out.gateWhy = e.gateWhy as string | undefined;
      out.needsFeedback = e.needsFeedback === true;
      out.injection = typeof e.injection === "string" ? e.injection : "";
      const ctx = e.context as { question?: number; added?: number; notice?: string; md?: string } | undefined;
      if (ctx) {
        const cap = args.contextInlineMax ?? 40_000;
        const md = typeof ctx.md === "string" ? ctx.md : "";
        out.context = {
          question: ctx.question,
          added: ctx.added,
          notice: ctx.notice,
          ...(cap > 0 && md ? { md: md.length > cap ? md.slice(0, cap) : md, mdTruncated: md.length > cap } : {}),
        };
      }
      out.timing = e.timing as Record<string, number> | undefined;
      return true; // 终态
    } else if (t === "error") {
      out.status = "error";
      out.error = { stage: String(e.stage ?? ""), message: String(e.message ?? ""), retryable: e.retryable === true };
      return true;
    }
    return false;
  };

  for (;;) {
    if (Date.now() - lastEventAt > silenceMs) throw new Error(`召回中断：${Math.round(silenceMs / 1000)} 秒没收到任何事件（正常每 10 秒有心跳）。可重试，服务会接着上次的进度`);
    if (Date.now() - startedAt > maxRunMs) {
      reader.cancel().catch(() => undefined);
      throw new Error(`召回超过客户端总上限 ${Math.round(maxRunMs / 60000)} 分钟，已断开（断开后服务侧也会取消本轮）`);
    }
    const read = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), 5_000)), // 周期性检查静默/总上限
    ]);
    if (read === null) continue;
    const { done, value } = read;
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line && handleLine(line)) {
        reader.cancel().catch(() => undefined);
        return out;
      }
    }
    if (done) break;
  }
  throw new Error("召回的流中途断了（没收到 done / error）：重试会接着上次的进度");
}

// ---------------- 工具 3：feedback ----------------

export interface FeedbackArgs {
  runId: string;
  answers: Array<{ askId: string; verdict: "yes" | "no" | "skip"; edited?: string }>;
  note?: string;
}

export async function intentFeedback(args: FeedbackArgs, opts?: IntentClientOpts): Promise<Record<string, unknown>> {
  return (await postJson("/feedback", { runId: args.runId, answers: args.answers, ...(args.note ? { note: args.note } : {}) }, opts)) as Record<string, unknown>;
}

// ---------------- 工具 4：ingest ----------------

export interface IngestArgs {
  sessionId: string;
  turnId: string;
  title?: string;
  q: string;
  a: string;
  ts?: number;
}

export async function intentIngest(args: IngestArgs, opts?: IntentClientOpts): Promise<Record<string, unknown>> {
  return (await postJson("/ingest", {
    sessionId: args.sessionId,
    turnId: args.turnId,
    title: args.title ?? "",
    q: args.q,
    a: args.a,
    ts: args.ts ?? Date.now(),
  }, opts)) as Record<string, unknown>;
}

// ---------------- 工具 5：sync（增量同步本机来源） ----------------

export interface SyncArgs {
  source: "claude" | "codex" | "proma";
  mode?: "sync" | "full";
  /** 等任务结束再返回（缺省 true，最多等 10 分钟）；false = 触发后立即返回 */
  wait?: boolean;
}

export async function intentSync(args: SyncArgs, opts?: IntentClientOpts): Promise<Record<string, unknown>> {
  const mode = args.mode ?? "sync";
  const r = (await postJson("/local/import", { source: args.source, mode }, opts)) as { job?: { phase?: string } };
  if (args.wait === false) return r;
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const sources = (await getJson("/local/sources", opts)) as { sources?: Array<{ id: string; job?: Record<string, unknown> | null }> };
    const job = sources.sources?.find((s) => s.id === args.source)?.job;
    if (!job || (job.phase !== "scan" && job.phase !== "import")) return { ok: true, job };
    if (Date.now() > deadline) return { ok: false, error: "同步超过 10 分钟还没结束（可在管理页看进度）", job };
    await new Promise((r2) => setTimeout(r2, 1_500));
  }
}

// ---------------- 工具 6：sources ----------------

export async function intentSources(opts?: IntentClientOpts): Promise<Record<string, unknown>> {
  const r = (await getJson("/local/sources", opts, 60_000)) as { sources?: Array<Record<string, unknown>>; orbita?: unknown };
  return {
    ok: true,
    sources: (r.sources ?? []).map((s) => ({
      id: s.id,
      consent: s.consent,
      enabled: s.enabled,
      sessions: s.sessions,
      rowsFound: s.rowsFound,
      rowsStored: s.rowsStored,
      rowsActive: s.rowsActive,
      lastSyncAt: s.lastSyncAt,
      job: s.job ?? null,
    })),
    pushed: r.orbita ?? null,
  };
}
