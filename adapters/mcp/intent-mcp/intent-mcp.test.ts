/**
 * intent-mcp 客户端逻辑的 stub 测试：起一个假 intent 服务（契约形状），验证六个工具函数。
 * 不打真模型、不依赖本机服务。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  intentFeedback,
  intentHealth,
  intentIngest,
  intentRecall,
  intentSources,
  intentSync,
} from "./client.ts";

let svc: { port: number; stop: () => void } | null = null;
const opts = (): { baseUrl: string } => ({ baseUrl: `http://127.0.0.1:${svc!.port}` });

const recallScript = [
  { type: "accepted", runId: "r-1", qaTotal: 5, swarm: { endpoint: "swarm", model: "m" }, budgetMs: 1000, peak: false, startedAt: 1 },
  { type: "stage", stage: "gate", status: "done", round: 1, ms: 5 },
  { type: "gate", needIntent: true, why: "需要参考历史", forced: false },
  { type: "intent", scene: "在排十一行程", want: "确认华山去不去" },
  { type: "heartbeat", t: 2 },
  { type: "progress", stage: "s3", round: 1, step: 1, done: 5, total: 5, passed: 2, etaMs: null },
  {
    type: "review",
    summary: "要敲定华山去不去",
    selected: [{ qaId: "orbita:proma-s1:t1", when: "10-01 10:00", title: "旅行", slots: ["同一件事"], why: "上次砍过华山", connection: "同一行程" }],
    ask: [{ askId: "a1", qaId: "orbita:proma-s1:t1", slot: "同一目的", statement: "目的是陪老人", quote: "带爸妈", when: "10-01 10:00", title: "旅行", whyUncertain: "推断的" }],
    askRemaining: 0,
    retried: false,
  },
  {
    type: "done",
    runId: "r-1",
    injection: "<intent_context>…</intent_context>",
    needsFeedback: true,
    context: { question: 1, md: "# 上下文\n…", jsonl: "{}\n", added: 1, notice: "第 1 问新增 1 条" },
    timing: { totalMs: 100, gateMs: 5, s1Ms: 10, s3Ms: 60, s4Ms: 25 },
  },
];

beforeAll(() => {
  svc = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, contract: 6, qaVisible: 5, qaImported: 5, qaIngested: 0, gate: { model: "g" }, s1: { model: "s1" }, s4: { model: "s4" }, swarm: { model: "s" } });
      }
      if (url.pathname === "/local/apps") return Response.json({ ok: true, apps: { claude: true, codex: false, proma: false } });
      if (url.pathname === "/local/sources") {
        return Response.json({
          ok: true,
          sources: [
            { id: "proma", consent: "yes", enabled: true, sessions: 2, rowsFound: 5, rowsStored: 5, rowsActive: 5, lastSyncAt: 1, job: { phase: "done", imported: 5, duplicates: 0, updated: 0 } },
          ],
          orbita: { rowsStored: 0 },
        });
      }
      if (url.pathname === "/local/import" && req.method === "POST") return Response.json({ ok: true, job: { phase: "import" } }, { status: 202 });
      if (url.pathname === "/recall" && req.method === "POST") {
        const reqBody = (await req.json().catch(() => ({}))) as { q?: string };
        if (reqBody.q === "你好") {
          const lines = [
            { type: "accepted", runId: "r-2", qaTotal: 5, swarm: {}, budgetMs: 1, peak: false, startedAt: 1 },
            { type: "gate", needIntent: false, why: "寒暄", forced: false },
            { type: "done", runId: "r-2", injection: "", needsFeedback: false, skipped: "gate", gateWhy: "寒暄", timing: { totalMs: 3 } },
          ];
          return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
        }
        // 分块发送，验证跨块拼行
        const text = recallScript.map((l) => JSON.stringify(l)).join("\n") + "\n";
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            const bytes = new TextEncoder().encode(text);
            let i = 0;
            const push = (): void => {
              if (i >= bytes.length) return c.close();
              c.enqueue(bytes.slice(i, i + 7)); // 故意不按行切
              i += 7;
              setTimeout(push, 1);
            };
            push();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.pathname === "/feedback" && req.method === "POST") {
        return Response.json({ ok: true, injection: "<intent_context>最终版</intent_context>", edgesWritten: 1, context: { question: 1, md: "# 新", jsonl: "", added: 1, notice: "已按表态更新" } });
      }
      if (url.pathname === "/ingest" && req.method === "POST") {
        return Response.json({ ok: true, qaId: "orbita:s:t", duplicate: false });
      }
      return Response.json({ error: "没有这个接口" }, { status: 404 });
    },
  });
});

afterAll(() => svc?.stop());

describe("intent-mcp client（stub 服务）", () => {
  test("health：端点模型、应用开关、QA 数", async () => {
    const h = await intentHealth(opts());
    expect(h).toMatchObject({ ok: true, reachable: true, contract: 6, qaVisible: 5, apps: { claude: true } });
    expect(h.models).toMatchObject({ swarm: "s", s1: "s1" });
  });

  test("recall：跨块 NDJSON 拼行，review/asks/context/timing 归约", async () => {
    const r = await intentRecall({ q: "华山还去吗", sessionId: "s", turnId: "t" }, opts());
    expect(r.status).toBe("done");
    expect(r.runId).toBe("r-1");
    expect(r.needsFeedback).toBe(true);
    expect(r.intent).toMatchObject({ scene: "在排十一行程" });
    expect(r.review?.selectedCount).toBe(1);
    expect(r.review?.selected[0]).toMatchObject({ title: "旅行", connection: "同一行程" });
    expect(r.asks).toHaveLength(1);
    expect(r.injection).toContain("intent_context");
    expect(r.context).toMatchObject({ question: 1, added: 1, mdTruncated: false });
    expect(r.timing?.totalMs).toBe(100);
  });

  test("recall：门卫跳过 → skipped，不带 context", async () => {
    const r = await intentRecall({ q: "你好", sessionId: "s", turnId: "t2" }, opts());
    expect(r.status).toBe("skipped");
    expect(r.gateWhy).toBe("寒暄");
    expect(r.injection).toBe("");
    expect(r.context).toBeUndefined();
  });

  test("feedback / ingest / sync / sources", async () => {
    const f = await intentFeedback({ runId: "r-1", answers: [{ askId: "a1", verdict: "no" }], note: "主要陪小孩" }, opts());
    expect(f).toMatchObject({ ok: true, edgesWritten: 1 });
    const g = await intentIngest({ sessionId: "s", turnId: "t", q: "q", a: "a" }, opts());
    expect(g).toMatchObject({ ok: true, qaId: "orbita:s:t", duplicate: false });
    const s = await intentSync({ source: "proma", mode: "sync" }, opts());
    expect(s).toMatchObject({ ok: true, job: { phase: "done", imported: 5 } });
    const list = await intentSources(opts());
    expect(list).toMatchObject({ ok: true });
    const proma = (list.sources as Array<Record<string, unknown>>)[0]!;
    expect(proma).toMatchObject({ id: "proma", rowsStored: 5 });
  });

  test("服务没启动：health 给可操作的 hint，recall 抛中文错", async () => {
    const dead = { baseUrl: "http://127.0.0.1:9" };
    const h = await intentHealth(dead);
    expect(h).toMatchObject({ ok: false, reachable: false });
    expect(h.hint).toContain("bun run serve");
    await expect(intentRecall({ q: "x", sessionId: "s" }, dead)).rejects.toThrow("连不上本机 intent 服务");
  });
});
