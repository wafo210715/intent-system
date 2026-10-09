/**
 * 线上协议（src/hosted-wire.ts）：客户端 ↔ 召回核心的打包 / 解包。
 * 重点：QA → 线上 → 重建后渲染出的消息必须与本地一字不差（预热前缀命中靠逐字节一致）。
 */
import { describe, expect, test } from "bun:test";
import { outcomeFromResult, packRecallPayload, packRecallResult, toWireQa, unpackPrewarmPayload, unpackRecallPayload, unpackRecallResult, wireToQa } from "../src/hosted-wire.ts";
import type { QA } from "../src/types.ts";

const T0 = Date.parse("2026-10-10T10:00:00+08:00");

function makeQa(id: string, i: number, qText: string, aText = "回答内容"): QA {
  const sessionId = "s1";
  return {
    qaId: id, sessionId, turnIndex: i, prevQaId: null, nextQaId: null, tsAbs: T0 + i * 1000, qText, aText, qTimeResolved: [],
    sourceType: "human-direct", intentWeight: 1, attachmentTypes: [], toolCallCount: 0, source: { file: "f", lineStart: 1, lineEnd: 1 }, shardId: sessionId,
  };
}

describe("线上协议：召回载荷", () => {
  const qas = [makeQa("qa1", 0, "问题一"), makeQa("qa2", 1, "问题二")];
  const payload = packRecallPayload({
    sessionId: "sess-1", turnId: "t1", title: "会话一", q: "现在问什么", force: false,
    qas, titleOf: () => "会话甲",
    edgeVerdicts: new Map([["qa1#2", { verdict: "no", statement: "不是同一件事" }]]),
    pendingAsks: [{ qaId: "qa2", slot: 3, statement: "陈述", whyUncertain: "拿不准", quote: "问题二" }],
  });
  test("打包 → 解包往返", () => {
    const parsed = unpackRecallPayload(JSON.parse(JSON.stringify(payload)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.qas.map((q) => q.qaId)).toEqual(["qa1", "qa2"]);
    expect(parsed.value.titleOf("s1")).toBe("会话甲");
    expect(parsed.value.edgeVerdicts.get("qa1#2")?.verdict).toBe("no");
    expect(parsed.value.pendingAsks[0]?.slot).toBe(3);
    expect(parsed.value.force).toBe(false);
  });
  test("形状错的挡下来", () => {
    expect(!unpackRecallPayload({ ...payload, v: 2 }).ok).toBe(true);
    expect(!unpackRecallPayload({ ...payload, q: "" }).ok).toBe(true);
    expect(!unpackRecallPayload({ ...payload, qas: [{ ...toWireQa(qas[0]!, "t"), sourceType: "magic" }] }).ok).toBe(true);
    expect(!unpackRecallPayload({ ...payload, edgeVerdicts: { a: { verdict: "maybe" } } }).ok).toBe(true);
  });
  test("预热载荷的 scope 解析", () => {
    const p = { v: 1 as const, qas: payload.qas, scope: "full" as const };
    const ok = unpackPrewarmPayload(p);
    expect(ok.ok && ok.value.sessionIds === null).toBe(true);
    const scoped = unpackPrewarmPayload({ ...p, scope: { sessionIds: ["s1"] } });
    expect(scoped.ok && scoped.value.sessionIds?.has("s1")).toBe(true);
    expect(!unpackPrewarmPayload({ ...p, scope: "all" }).ok).toBe(true);
  });
});

describe("线上协议：结果", () => {
  const result = packRecallResult(
    {
      intent: { scene: "场景", want: "想要", constraints: { after: null, before: null, keywords: [] } },
      review: { summary: "一句总结", selected: [{ qaId: "qa1", slots: [1], why: "同一件事" }], ask: [], enough: true, missing: null },
      bids: [],
      injection: "",
      retried: false,
      dropped: [],
      timing: { totalMs: 1, s1Ms: 1, s3Ms: 1, s4Ms: 1, s4PromptTokens: 1 },
      s3Stats: { qaTotal: 2, batches: 2, failedBatches: 0, qaPassed: 1, passRate: 0.5, bidsBySlot: {}, gateRejected: 0, rejectReasons: {}, repairReasons: {}, truncRetried: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, wallMs: 1, callMsP50: 1, callMsP95: 1, callAttempts: 2, failedCalls: 0, scoreMs: 1, reasonMs: 0, segments: 2 },
      s3Scores: [{ qaId: "qa1", scores: [0.9, 0.5, null, null, null, null] }],
      usage: {},
      runDir: "",
      keeper: {
        selected: [{ qaId: "qa1", slot: 1, score: 0.9, human: "问题一", assistant: "回答内容", connection: "同一件事", prediction: "会引用", dupCount: 1, humanFallback: false }],
        asksFinal: [], overflow: [], askRemaining: 0, missing: null, dupGroups: 1, dedup: { before: 1, after: 1 }, humanFallbacks: 0,
      },
      edgeDropped: 0,
    },
    [{ qaId: "qa1", scores: [0.9, 0.5, null, null, null, null] }],
  );
  test("打包 → 解包 → 本地 outcome", () => {
    const parsed = unpackRecallResult(JSON.parse(JSON.stringify(result)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const qaById = new Map([[result.keeper!.selected[0]!.qaId, makeQa("qa1", 0, "问题一")]] as const);
    const outcome = outcomeFromResult(parsed.value, new Map(qaById), () => "会话甲", new Set());
    expect(outcome.injection).toContain("问题一");
    expect(outcome.s3Scores[0]?.qaId).toBe("qa1");
    expect(outcome.keeper?.selected[0]?.human).toBe("问题一");
    expect(outcome.runDir).toBe("");
  });
  test("缺结构的挡下来", () => {
    expect(!unpackRecallResult({ intent: {} }).ok).toBe(true);
    expect(!unpackRecallResult(null).ok).toBe(true);
  });
});
