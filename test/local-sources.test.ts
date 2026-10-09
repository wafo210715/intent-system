/**
 * 本机来源（2026-10-10）：Claude Code / Codex 会话文件 → /import 行，以及 /local/* 接口。
 * 夹具按本机真实文件的形状构造（Codex 的注入块、thread_source、分页窗口文件都是实测出来的）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeUserText, localHiddenSessions, parseClaudeSession, parseCodexRollout, resetLocalCaches, summarizeSessions, updateLocalState,
} from "../src/local-sources.ts";
import { buildServer, resetPersisted } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { appendEdge } from "../src/edges.ts";
import { loadRecallLog, observeRecallEvent } from "../src/recall-log.ts";
import { readFileSync, rmSync, statSync } from "node:fs";

const jl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const T = (min: number): string => new Date(Date.UTC(2026, 9, 1, 0, min)).toISOString();

// ---------------- Claude Code ----------------

const claudeRows = [
  { type: "ai-title", aiTitle: "修存储层" },
  { type: "user", isSidechain: true, uuid: "w0", message: { content: "Warmup" } },
  { type: "user", uuid: "u1", parentUuid: null, cwd: "/repo/a", timestamp: T(1), message: { content: "第一问<system-reminder>别管我</system-reminder>" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: T(2), message: { id: "m1", content: [{ type: "text", text: "我先看看" }, { type: "tool_use", id: "x", name: "Read" }] } },
  { type: "user", uuid: "r1", parentUuid: "a1", timestamp: T(2), toolUseResult: {}, message: { content: [{ type: "tool_result", tool_use_id: "x", content: "文件" }] } },
  { type: "assistant", uuid: "a2", parentUuid: "r1", timestamp: T(3), message: { id: "m2", content: [{ type: "text", text: "第一问的回答" }] } },
  { type: "user", uuid: "meta", parentUuid: "a2", isMeta: true, timestamp: T(3), message: { content: "skill 正文" } },
  { type: "user", uuid: "u2", parentUuid: "meta", timestamp: T(4), message: { content: "<command-name>/compact</command-name>" } },
  { type: "user", uuid: "u3", parentUuid: "u2", timestamp: T(5), message: { content: "被回退的一问" } },
  { type: "assistant", uuid: "a3", parentUuid: "u3", timestamp: T(6), message: { id: "m3", content: [{ type: "text", text: "旧枝回答" }] } },
  // 回退：接回 a2 后面重写 → u3 那一轮作废
  { type: "user", uuid: "u4", parentUuid: "a2", timestamp: T(7), message: { content: "重写后的第二问" } },
  { type: "attachment", uuid: "q1", parentUuid: "u4", timestamp: T(8), attachment: { type: "queued_command", commandMode: "prompt", prompt: "排队时打的字" } },
  { type: "assistant", uuid: "a4", parentUuid: "q1", timestamp: T(9), message: { id: "m4", content: [{ type: "text", text: "排队那句的回答" }] } },
  { type: "assistant", uuid: "e1", parentUuid: "a4", isApiErrorMessage: true, timestamp: T(9), message: { content: [{ type: "text", text: "API Error" }] } },
];

describe("parseClaudeSession", () => {
  const p = parseClaudeSession(jl(claudeRows), "/x/projects/-repo-a/abc.jsonl");
  test("只收用户亲口说的话；回答取这一轮最后一段文字", () => {
    expect(p.sessionId).toBe("claude-abc");
    expect(p.title).toBe("修存储层");
    expect(p.project).toBe("/repo/a");
    expect(p.rows.map((r) => [r.turnId, r.q, r.a])).toEqual([
      ["u1", "第一问", "第一问的回答"],
      ["u4", "重写后的第二问", ""],
      ["q1", "排队时打的字", "排队那句的回答"],
    ]);
  });
  test("命令包装还原成用户打的命令；Claude 生成的文字不算用户的话", () => {
    expect(claudeUserText("<command-name>/model</command-name><command-args>opus</command-args>")).toBe("/model opus");
    expect(claudeUserText("[Request interrupted by user]")).toBeNull();
    expect(claudeUserText('看 @"/a b/c.md"')).toBe("看 @/a b/c.md");
  });
});

// ---------------- Codex ----------------

const codexLines = (opts: { id: string; threadSource?: string; parent?: string }) => [
  { timestamp: T(0), type: "session_meta", payload: { id: opts.id, cwd: "/repo/b", thread_source: opts.threadSource ?? "user", ...(opts.parent ? { parent_thread_id: opts.parent } : {}) } },
  { timestamp: T(0), type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "系统提示" }] } },
  { timestamp: T(1), type: "response_item", payload: { type: "message", role: "user", content: [
    { type: "input_text", text: "# AGENTS.md instructions for /repo/b\n<INSTRUCTIONS>…</INSTRUCTIONS>" },
    { type: "input_text", text: "<environment_context>\n<cwd>/repo/b</cwd>\n</environment_context>" },
    { type: "input_text", text: "限速改成令牌桶吗？" },
  ] } },
  { timestamp: T(2), type: "response_item", payload: { type: "reasoning", summary: [] } },
  { timestamp: T(2), type: "response_item", payload: { type: "function_call", name: "shell" } },
  { timestamp: T(3), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "先看现状" }] } },
  // 轮中间插进来的注入：不开轮、不关轮，回答不丢
  { timestamp: T(3), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<subagent_notification>done</subagent_notification>" }] } },
  { timestamp: T(4), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "建议改成令牌桶" }] } },
  { timestamp: T(5), type: "event_msg", payload: { type: "token_count" } },
];

describe("parseCodexRollout", () => {
  test("剥系统注入；developer 不进；注入夹在轮中间时回答照取最后一段", () => {
    const p = parseCodexRollout(jl(codexLines({ id: "s-1" })), "/c/sessions/2026/10/01/rollout-2026-10-01T00-00-00-s-1.jsonl", new Map([["s-1", "限速讨论"]]));
    expect(p.sessionId).toBe("codex-s-1");
    expect(p.title).toBe("限速讨论");
    expect(p.kind).toBe("user");
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ q: "限速改成令牌桶吗？", a: "建议改成令牌桶", turnId: "w0:L3" });
  });
  test("子 agent / 定时任务 / agent 开的线程分出来（不入库）", () => {
    expect(parseCodexRollout(jl(codexLines({ id: "s", threadSource: "subagent" })), "f").kind).toBe("subagent");
    expect(parseCodexRollout(jl(codexLines({ id: "s", parent: "p" })), "f").kind).toBe("subagent");
    expect(parseCodexRollout(jl(codexLines({ id: "s", threadSource: "automation" })), "f").kind).toBe("automation");
    expect(parseCodexRollout(jl(codexLines({ id: "s", threadSource: "agent_created_thread" })), "f").kind).toBe("agent");
  });
  test("分页会话的窗口文件：turnId 带窗口 id，不撞；汇总合成一个会话", () => {
    const w = "01a06a26-3bd3-7bd3-8a4a-fb0c2b452e51";
    const a = parseCodexRollout(jl(codexLines({ id: "s-2" })), "/c/rollout-x-s-2.jsonl");
    const b = parseCodexRollout(jl(codexLines({ id: "s-2" })), `/c/rollout-y-s-2_${w}.jsonl`);
    expect(a.rows[0]!.turnId).not.toBe(b.rows[0]!.turnId);
    expect(b.rows[0]!.turnId).toBe(`${w}:L3`);
    const sum = summarizeSessions([a, b]);
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ sessionId: "codex-s-2", rows: 2 });
    expect(sum[0]!.files).toHaveLength(2);
  });
});

// ---------------- /local/* 接口 ----------------

const ROOT = mkdtempSync(join(tmpdir(), "intent-local-"));
const DATA = join(ROOT, "data");
const CLAUDE = join(ROOT, "claude");
const CODEX = join(ROOT, "codex");
let svc: { port: number; stop: () => void } | null = null;
const saved: Record<string, string | undefined> = {};
const ENV = ["INTENT_LAB_DATA", "INTENT_LAB_CONFIG", "INTENT_LAB_SOURCE", "INTENT_LAB_CLAUDE_HOME", "INTENT_LAB_CODEX_HOME"];

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  mkdirSync(DATA, { recursive: true });
  mkdirSync(join(CLAUDE, "projects", "-repo-a"), { recursive: true });
  writeFileSync(join(CLAUDE, "projects", "-repo-a", "abc.jsonl"), jl(claudeRows));
  const day = join(CODEX, "sessions", "2026", "10", "01");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-10-01T00-00-00-s-1.jsonl"), jl(codexLines({ id: "s-1" })));
  writeFileSync(join(day, "rollout-2026-10-01T00-10-00-s-9.jsonl"), jl(codexLines({ id: "s-9", threadSource: "subagent" })));
  process.env.INTENT_LAB_DATA = DATA;
  process.env.INTENT_LAB_CONFIG = join(ROOT, "none.json");
  process.env.INTENT_LAB_SOURCE = "orbita";
  process.env.INTENT_LAB_CLAUDE_HOME = CLAUDE;
  process.env.INTENT_LAB_CODEX_HOME = CODEX;
  resetLocalCaches();
  resetPersisted();
  svc = buildServer(0);
});

afterAll(() => {
  svc?.stop();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLocalCaches();
  resetPersisted();
});

const base = (): string => `http://127.0.0.1:${svc!.port}`;
const get = async (p: string): Promise<any> => (await fetch(base() + p)).json();
const post = async (p: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(base() + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });


const waitJob = async (source: string): Promise<any> => {
  for (let i = 0; i < 100; i++) {
    const s = (await get("/local/sources")).sources.find((x: any) => x.id === source);
    if (s && s.job && !["scan", "import", "sync"].includes(s.job.phase)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job 没结束");
};
const visible = async (): Promise<number> => (await get("/health")).qaVisible;

describe("/local/*", () => {
  test("发现但未同意：不入库；子 agent 会话单独计数", async () => {
    const r = await get("/local/sources");
    const codex = r.sources.find((x: any) => x.id === "codex");
    expect(codex).toMatchObject({ consent: "unasked", sessions: 1, rowsFound: 1, rowsStored: 0, skippedSessions: { subagent: 1 } });
    expect(await visible()).toBe(0);
  });

  test("导入走 /import 同一路径：入库、幂等、同意状态记下", async () => {
    expect((await post("/local/import", { source: "claude", mode: "full" })).status).toBe(202);
    const c = await waitJob("claude");
    expect(c).toMatchObject({ consent: "yes", rowsFound: 3, rowsStored: 3, rowsActive: 3 });
    await post("/local/import", { source: "codex", mode: "full" });
    await waitJob("codex");
    expect(await visible()).toBe(4);
    await post("/local/import", { source: "codex", mode: "full" });
    const again = await waitJob("codex");
    expect(again.job).toMatchObject({ imported: 0, duplicates: 1 });
    await post("/local/import", { source: "claude", mode: "sync" });
    expect((await waitJob("claude")).job.rowsTotal).toBe(0); // 文件没变，增量不送
  });

  test("排除项目 / 会话、暂停来源：只影响召回可见，数据保留", async () => {
    await post("/local/exclude", { source: "codex", project: "/repo/b", excluded: true });
    expect(await visible()).toBe(3);
    await post("/local/exclude", { source: "codex", project: "/repo/b", excluded: false });
    await post("/local/exclude", { source: "claude", sessionId: "claude-abc", excluded: true });
    expect(await visible()).toBe(1);
    await post("/local/exclude", { source: "claude", sessionId: "claude-abc", excluded: false });
    await post("/local/settings", { source: "claude", enabled: false });
    expect(await visible()).toBe(1);
    await post("/local/settings", { source: "claude", enabled: true });
    expect(await visible()).toBe(4);
  });

  test("清空后重新导入能回来（物理删除，不是作废）", async () => {
    const r = await (await post("/local/clear", { source: "claude" })).json();
    expect(r.cleared).toBe(3);
    expect(await visible()).toBe(1);
    await post("/local/import", { source: "claude", mode: "sync" });
    await waitJob("claude");
    expect(await visible()).toBe(4);
  });

  test("跨站写请求与非本机 Host 被拒；/ui 可取", async () => {
    expect((await post("/local/clear", { source: "codex" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(base() + "/local/sources", { headers: { host: "evil.example" } })).status).toBe(403);
    const ui = await fetch(base() + "/ui");
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("intent-lab");
  });

  test("可见集过滤函数：未知来源的会话不受影响", () => {
    updateLocalState((s) => void (s.sources.codex.enabled = false));
    const hidden = localHiddenSessions();
    expect(hidden("codex-s-1")).toBe(true);
    expect(hidden("orbita-session")).toBe(false);
    updateLocalState((s) => void (s.sources.codex.enabled = true));
  });
});

describe("管理页：召回记录 / 表态 / 配置", () => {
  test("召回记录旁听事件：done 落一行摘要，门卫跳过与出错各有状态", () => {
    const req = { sessionId: "claude-x", turnId: "t1", q: "要不要换", force: false };
    observeRecallEvent("r-a", req, { type: "accepted", runId: "r-a", qaTotal: 10, swarm: { endpoint: "s", model: "m" }, budgetMs: 1, peak: false, startedAt: 1000 });
    observeRecallEvent("r-a", req, { type: "stage", stage: "s3", status: "done", round: 1, ms: 500 });
    observeRecallEvent("r-a", req, { type: "intent", scene: "场景", want: "诉求" });
    observeRecallEvent("r-a", req, { type: "review", summary: "总结", selected: [], ask: [], askRemaining: 0, retried: false } as any);
    observeRecallEvent("r-a", req, { type: "done", runId: "r-a", injection: "", needsFeedback: false, timing: { totalMs: 900, gateMs: 0, s1Ms: 0, s3Ms: 500, s4Ms: 0 } } as any);
    observeRecallEvent("r-b", req, { type: "done", runId: "r-b", injection: "", needsFeedback: false, skipped: "gate", gateWhy: "寒暄", timing: { totalMs: 5 } } as any);
    observeRecallEvent("r-c", req, { type: "error", stage: "s3", message: "S3 有 3 / 9 次调用失败", retryable: true, elapsedMs: 1 });
    const rows = loadRecallLog();
    expect(rows.map((r) => [r.runId, r.status])).toEqual([["r-c", "error"], ["r-b", "skipped"], ["r-a", "done"]]);
    expect(rows[2]).toMatchObject({ qaTotal: 10, scene: "场景", summary: "总结", stages: { s3: 500 }, totalMs: 900 });
  });

  test("/local/recalls 新的在前", async () => {
    const r = await get("/local/recalls?limit=2");
    expect(r.recalls.map((x: any) => x.runId)).toEqual(["r-c", "r-b"]);
  });

  test("表态：列出、撤销（追加 skip 边）", async () => {
    appendEdge({ ts: 5, runId: "r-a", sessionId: "s", turnId: "t", qaId: "orbita:codex-s-1:w0:L3", slot: 2, verdict: "no", statement: "你想先给朋友内测" });
    resetPersisted();
    let v = await get("/local/verdicts");
    expect(v.verdicts).toHaveLength(1);
    expect(v.verdicts[0]).toMatchObject({ verdict: "no", slotName: "同一目的", statement: "你想先给朋友内测" });
    expect(v.verdicts[0].from).toContain("Codex");
    await post("/local/verdicts/revoke", { qaId: "orbita:codex-s-1:w0:L3", slot: 2 });
    v = await get("/local/verdicts");
    expect(v.verdicts).toHaveLength(0);
  });

  test("配置：读不回显 key；写只改给的字段、key 留空不改、文件 600", async () => {
    const cfgPath = join(ROOT, "none.json");
    writeFileSync(cfgPath, JSON.stringify({ main: { baseUrl: "https://a/v1", apiKey: "k-main", model: "m1" }, swarm: { baseUrl: "https://b/v1", apiKey: "k-swarm", model: "m2" }, endpoints: { x: { baseUrl: "u" } } }));
    const r = await get("/local/config");
    expect(r.config.main).toEqual({ baseUrl: "https://a/v1", model: "m1", hasKey: true });
    expect(JSON.stringify(r)).not.toContain("k-main");
    await post("/local/config", { main: { model: "m1b", apiKey: "" }, swarm: { recallConcurrency: 64 } });
    const saved = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(saved.main).toEqual({ baseUrl: "https://a/v1", apiKey: "k-main", model: "m1b" });
    expect(saved.swarm.recallConcurrency).toBe(64);
    expect(saved.endpoints).toEqual({ x: { baseUrl: "u" } });
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  });
});

describe("管理页：应用开关 / 端点模式", () => {
  test("应用开关：缺省都关，改了存下", async () => {
    expect((await get("/local/apps")).apps).toEqual({ claude: false, codex: false });
    await post("/local/apps", { claude: true });
    expect((await get("/local/apps")).apps).toEqual({ claude: true, codex: false });
  });

});
