/**
 * 作废记录（契约 v6）：按出现次数消费的藏行逻辑、落盘读写、(sessionId, turnId) 幂等键。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInvalidated, dropInvalidated, invalidateKey, invalidatedPairs, invalidatedQaCounts, loadInvalidated } from "../src/invalidation.ts";

process.env.INTENT_LAB_DATA ??= mkdtempSync(join(tmpdir(), "intent-lab-inval-data-"));

describe("dropInvalidated：按出现次数消费", () => {
  const rows = [
    { qaId: "x", tsAbs: 1 },
    { qaId: "y", tsAbs: 2 },
    { qaId: "x", tsAbs: 3 },
    { qaId: "x", tsAbs: 4 },
  ];
  test("作废 1 次：只藏该 qaId 的第 1 次出现，后面的照常可见（回退后重发的新行不受影响）", () => {
    const kept = dropInvalidated(rows, new Map([["x", 1]]));
    expect(kept.map((r) => r.tsAbs)).toEqual([2, 3, 4]);
  });
  test("作废 2 次：前 2 次出现都藏", () => {
    const kept = dropInvalidated(rows, new Map([["x", 2]]));
    expect(kept.map((r) => r.tsAbs)).toEqual([2, 4]);
  });
  test("没有作废记录 = 原样（同引用拷贝）", () => {
    expect(dropInvalidated(rows, new Map())).toHaveLength(4);
  });
});

describe("落盘读写", () => {
  test("appendInvalidated / loadInvalidated 往返；坏行与缺 qaId 兜底", () => {
    const row = { ts: 1, sessionId: "s1", turnId: "t1", qaId: "orbita:s1:t1" };
    appendInvalidated([row]);
    // 手写一行坏 JSON、一行缺字段（qaId 缺失时按 sessionId+turnId 补）
    writeFileSync(join(process.env.INTENT_LAB_DATA!, "orbita", "invalidated.jsonl"), `{broken\n${JSON.stringify({ ts: 2, sessionId: "s2", turnId: "t2" })}\n`, { flag: "a" });
    const loaded = loadInvalidated();
    expect(loaded).toHaveLength(2);
    expect(loaded[1]).toMatchObject({ sessionId: "s2", turnId: "t2", qaId: "orbita:s2:t2" });
    expect(invalidatedPairs(loaded).has(invalidateKey("s1", "t1"))).toBe(true);
    expect(invalidatedQaCounts(loaded).get("orbita:s2:t2")).toBe(1);
  });
  test("空数组不落盘（文件不存在时 loadInvalidated 返回空）", () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-lab-inval-empty-"));
    expect(loadInvalidated(dir)).toEqual([]);
    appendInvalidated([], dir);
    expect(existsSync(join(dir, "orbita", "invalidated.jsonl"))).toBe(false);
  });
});

describe("作废清等表态 run（deletePendingRunsFor）", () => {
  test("只删该会话被回退轮的落盘 run，别的会话 / 别的轮不动", async () => {
    const { savePendingRun, deletePendingRunsFor, loadPendingRun } = await import("../src/pending-runs.ts");
    const dir = mkdtempSync(join(tmpdir(), "intent-lab-pending-"));
    const mk = (runId: string, sessionId: string, turnId: string) => ({
      runId, sessionId, turnId, q: "问", review: { summary: "", selected: [], ask: [] } as never,
      askItems: [], injectedBefore: [], createdAt: Date.now(), contextQuestion: 1,
    });
    savePendingRun(mk("r1", "s1", "t1"), dir);
    savePendingRun(mk("r2", "s1", "t2"), dir);
    savePendingRun(mk("r3", "s2", "t1"), dir);
    expect(deletePendingRunsFor("s1", new Set(["t1"]), dir)).toBe(1);
    expect(loadPendingRun("r1", dir)).toBeNull();
    expect(loadPendingRun("r2", dir)).not.toBeNull();
    expect(loadPendingRun("r3", dir)).not.toBeNull();
  });
});
