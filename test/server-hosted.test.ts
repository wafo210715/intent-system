/**
 * 服务端 hosted 模式（recallMode=server，B 方案 10-10）e2e：本地 /recall 代理到假召回核心，
 * 验证 8723 流与本地版同形（review / done 带 injection 与 context）、注入块末尾带「读上下文文件」指引、
 * s3 边回写、/feedback 全本地照常可用。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, resetPersisted } from "../src/server.ts";
import { setLiveHostedRecallMode } from "../src/config.ts";
import type { RecallEvent } from "../src/server-contract.ts";

const T0 = Date.parse("2026-10-10T10:00:00+08:00");
const DATA = mkdtempSync(join(tmpdir(), "intent-lab-hosted-"));
const CFG = join(DATA, "config.json");

const row = (qaId: string, sessionId: string, turnId: string, qText: string, i: number) => ({
  qaId, sessionId, turnIndex: i, prevQaId: null, nextQaId: null, tsAbs: T0 + i * 1000, qText, aText: "回答内容", qTimeResolved: [],
  sourceType: "human-direct", intentWeight: 1, attachmentTypes: [], toolCallCount: 0, source: { file: "orbita", lineStart: 0, lineEnd: 0 },
  shardId: sessionId, turnId, title: "会话甲",
});

// ---------- 假召回核心 ----------
let coreAsk = 0;
const core = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/intent/v1/recall") {
      await req.text();
      const events: RecallEvent[] & Array<Record<string, unknown>> = [
        { type: "accepted", runId: "r-core-1", qaTotal: 2, swarm: { endpoint: "hosted", model: "swarm-model" }, budgetMs: 1_800_000, peak: false, startedAt: 1 },
        { type: "stage", stage: "gate", status: "start", round: 1 },
        { type: "stage", stage: "gate", status: "done", round: 1, ms: 3 },
        { type: "gate", needIntent: true, why: "要分析", forced: false },
        { type: "stage", stage: "s1", status: "start", round: 1 },
        { type: "stage", stage: "s1", status: "done", round: 1, ms: 5 },
        { type: "intent", scene: "我们在聊测试", want: "要一个判断" },
        { type: "progress", stage: "s3", round: 1, step: 1, done: 2, total: 2, passed: 1, etaMs: null },
        { type: "progress", stage: "s3", round: 1, step: 2, done: 1, total: 1, passed: 1, etaMs: null },
        { type: "stage", stage: "s3", status: "done", round: 1, ms: 9 },
        { type: "stage", stage: "s4", status: "start", round: 1 },
        { type: "stage", stage: "s4", status: "done", round: 1, ms: 7 },
      ];
      return new Response([...events.map((e) => JSON.stringify(e)), JSON.stringify({
        type: "done", runId: "r-core-1", gateMs: 3,
        timing: { totalMs: 24, gateMs: 3, s1Ms: 5, s3Ms: 9, s4Ms: 7, s4PromptTokens: 42 },
        result: {
          intent: { scene: "我们在聊测试", want: "要一个判断", constraints: { after: null, before: null, keywords: [] } },
          timing: { totalMs: 24, gateMs: 3, s1Ms: 5, s3Ms: 9, s4Ms: 7, s4PromptTokens: 42 },
          review: {
            summary: "我理解你要一个判断",
            selected: [{ qaId: "orbita:s1:m1", slots: [1], why: "同一件事" }],
            ask: [{ qaId: "orbita:s1:m1", slot: 2, statement: "你做这件事是为了同一个目的", whyUncertain: "拿不准" }],
            enough: true, missing: null,
          },
          keeper: {
            selected: [{ qaId: "orbita:s1:m1", slot: 1, score: 0.9, human: "测试问题甲乙丙丁", assistant: "", connection: "同一件事", prediction: "会引用", dupCount: 1, humanFallback: false }],
            asksFinal: [{ qaId: "orbita:s1:m1", slot: 2, statement: "你做这件事是为了同一个目的", whyUncertain: "拿不准", quote: "测试问题甲乙丙丁" }],
            overflow: [], askRemaining: 0, missing: null, dupGroups: 1, dedup: { before: 2, after: 2 }, humanFallbacks: 0,
          },
          s3Passed: [{ qaId: "orbita:s1:m1", scores: [0.9, 0.6, 0, 0, 0, 0] }],
          usage: { s4: { calls: 1, promptTokens: 42, cachedTokens: 0, completionTokens: 6, thinkingTokens: 0 } },
          resumed: { intent: false, scores: 0, reasons: 0 },
        },
      })].map((l) => l + "\n").join(""), { headers: { "content-type": "application/x-ndjson" } });
    }
    if (url.pathname === "/intent/v1/prewarm" && req.method === "POST") return Response.json({ ok: true });
    if (url.pathname === "/intent/v1/prewarm") return Response.json({ prewarm: { phase: "running", startedAt: 1, finishedAt: null, done: 1, total: 2, qas: 1, segs: 1, failed: 0, etaMs: null, error: null, ratePerSec: 5.5 } });
    if (url.pathname === "/config") return Response.json({}, { status: 404 }); // refreshHostedLimits 拿不到就用授权里的值
    return Response.json({ error: "no" }, { status: 404 });
  },
});

let svc: { port: number; stop: () => void } | null = null;
const base = (): string => `http://127.0.0.1:${svc!.port}`;
const SAVED: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ["INTENT_LAB_DATA", "INTENT_LAB_CONFIG", "INTENT_LAB_SOURCE", "INTENT_LAB_HOSTED_URL", "INTENT_LAB_HOSTED_KEY", "INTENT_LAB_HOSTED_MODEL", "INTENT_LAB_HOSTED_RECALL_MODE", "INTENT_LAB_HOSTED_AUTH"]) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  process.env.INTENT_LAB_DATA = DATA;
  process.env.INTENT_LAB_CONFIG = CFG;
  process.env.INTENT_LAB_HOSTED_URL = `http://127.0.0.1:${core.port}/v1`;
  process.env.INTENT_LAB_HOSTED_KEY = "ilk_e2e";
  process.env.INTENT_LAB_HOSTED_MODEL = "swarm-model";
  process.env.INTENT_LAB_HOSTED_RECALL_MODE = "server";
  process.env.INTENT_LAB_HOSTED_AUTH = `http://127.0.0.1:${core.port}`;
  setLiveHostedRecallMode(null); // 别的测试文件可能把 live 值钉在 client（模块级共享状态）；这里以本文件的 env 为准
  writeFileSync(CFG, JSON.stringify({ endpointMode: "hosted", excludeSessions: [] }));
  mkdirSync(join(DATA, "orbita"), { recursive: true });
  writeFileSync(join(DATA, "qa-import.jsonl"), [row("orbita:s1:m1", "s1", "m1", "测试问题甲乙丙丁", 0), row("orbita:s1:m2", "s1", "m2", "测试问题乙", 1)].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(DATA, "edges.jsonl"), "");
  resetPersisted(); // 别的测试文件可能已把持久层单例载到别的数据目录
  svc = buildServer(0);
});

afterAll(() => {
  svc?.stop();
  core.stop(true);
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("/recall · hosted（编排在服务端）", () => {
  test("事件流与本地版同形；done 带注入块（含读文件指引）与上下文文件；边回写", async () => {
    const res = await fetch(`${base()}/recall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "sess-1", turnId: "t1", title: "会话一", q: "现在问什么" }) });
    expect(res.status).toBe(200);
    const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as RecallEvent);
    const types = events.map((e) => e.type);
    console.log("ERRMSG:", JSON.stringify(events.find((e) => e.type === "error")) ?? "none");
    expect(types).toContain("review"); // 本地后处理补齐（核心不发 review）
    expect(types).toContain("done");
    const done = events.find((e) => e.type === "done") as Extract<RecallEvent, { type: "done" }>;
    expect(done.needsFeedback).toBe(true);
    expect(done.injection).toContain("测试问题甲乙丙丁");
    expect(done.injection).toContain("read 工具读取"); // 上下文指引（10-10 用户定）
    expect(done.injection).toContain(join(DATA, "context", "sess-1", "context.md"));
    expect(done.context?.question).toBe(1);
    expect(done.context?.notice).toContain(join(DATA, "context", "sess-1", "context.md")); // toast 里给全路径
    expect(done.edgesWritten).toBe(6); // 过线 QA 的六岗 s3 边（远端筛过：s3Passed 只有 m1）
    expect(done.timing.totalMs).toBe(24); // 远端口径透传
    // 边与上下文文件都落了本地
    const edges = readFileSync(join(DATA, "edges.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { qaId: string; source: string });
    expect(edges.filter((e) => e.source === "s3").length).toBe(6);
    expect(existsSync(join(DATA, "context", "sess-1", "context.md"))).toBe(true);
    coreAsk++;
  });

  test("/health 未激活时带 needsActivation=true（插件据此提示先激活，不再走召回）", async () => {
    // 本文件的授权来自 env；临时摘掉 env 密钥 = 未激活（loadHostedGrant 每次现读）
    const u = process.env.INTENT_LAB_HOSTED_URL;
    const k = process.env.INTENT_LAB_HOSTED_KEY;
    delete process.env.INTENT_LAB_HOSTED_URL;
    delete process.env.INTENT_LAB_HOSTED_KEY;
    try {
      const h = (await (await fetch(`${base()}/health`)).json()) as { ok: boolean; needsActivation?: boolean; error?: string };
      expect(h.ok).toBe(false);
      expect(h.needsActivation).toBe(true);
      expect(h.error).toContain("激活");
    } finally {
      if (u !== undefined) process.env.INTENT_LAB_HOSTED_URL = u;
      if (k !== undefined) process.env.INTENT_LAB_HOSTED_KEY = k;
    }
  });

  test("/local/prewarm 透传核心的实测速率 ratePerSec（激活后估「预计约 N 分钟」用）", async () => {
    const r = (await (await fetch(`${base()}/local/prewarm`, { headers: { host: "127.0.0.1" } })).json()) as { prewarm: { ratePerSec?: number | null } };
    expect(r.prewarm.ratePerSec).toBe(5.5);
  });

  test("先导入后激活（老流程）：激活成功自动补远端预热，不用用户手动点", async () => {
    // 一个假激活服务：带 recallMode=server 的授权
    const auth = Bun.serve({
      port: 0,
      fetch: async () => Response.json({ baseUrl: `http://127.0.0.1:${core.port}/v1`, apiKey: "ilk_act", model: "swarm-model", user: "内测 · 用户A", limits: { recallConcurrency: 8, reasonConcurrency: 8, prewarmConcurrency: 2 }, models: { swarm: "swarm-model", s4: "s4m" }, recallMode: "server" }),
    });
    const saved = process.env.INTENT_LAB_HOSTED_AUTH;
    process.env.INTENT_LAB_HOSTED_AUTH = `http://127.0.0.1:${auth.port}`;
    try {
      // beforeAll 已导入 4 条 QA 且未预热（phase idle）→ 激活后应自动排队远端预热
      const r = await fetch(`${base()}/local/hosted/activate`, { method: "POST", headers: { "content-type": "application/json", origin: `${base()}` }, body: JSON.stringify({ code: "IL-XXXX-YYYY" }) });
      expect(r.status).toBe(200);
      const pw = (await (await fetch(`${base()}/local/prewarm`, { headers: { host: "127.0.0.1" } })).json()) as { prewarm: { phase: string } };
      expect(["queued", "running"]).toContain(pw.prewarm.phase);
    } finally {
      auth.stop(true);
      if (saved === undefined) delete process.env.INTENT_LAB_HOSTED_AUTH;
      else process.env.INTENT_LAB_HOSTED_AUTH = saved;
    }
  });

  test("/feedback 全本地照常：按表态重建注入块（指引行仍在）", async () => {
    // runId 用本地流里的（done.runId = 本地 runId，不是核心的）
    const first = await fetch(`${base()}/recall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "sess-2", turnId: "t1", title: "会话一", q: "再问一句" }) });
    const evs = (await first.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as RecallEvent);
    const runId = (evs.find((e) => e.type === "done") as Extract<RecallEvent, { type: "done" }>).runId;
    const res = await fetch(`${base()}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, answers: [{ askId: "a1", verdict: "no" }], note: "补充一句" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; injection: string; context: { md: string } };
    expect(body.ok).toBe(true);
    expect(body.injection).toContain("read 工具读取");
    expect(body.injection).toContain("用户否认"); // no 的边进注入块的更正行
    expect(body.context.md).toContain("你补充的背景：补充一句") // note 写进上下文
    ;
  });
});
