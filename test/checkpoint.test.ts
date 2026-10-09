/**
 * 断点续传（09-29）：同一问失败后重试，复用 S1 意图与 S3 两步已完成的结果，只补缺的；成功后删断点。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCheckpointsFor, openCheckpoint, pruneCheckpoints } from "../src/checkpoint.ts";
import type { QA } from "../src/types.ts";

process.env.INTENT_LAB_DATA ??= mkdtempSync(join(tmpdir(), "intent-lab-cp-data-"));
const T0 = Date.parse("2026-09-20T10:00:00+08:00");
const qa = (id: string, i: number): QA => ({
  qaId: id, sessionId: "s", turnIndex: i, prevQaId: null, nextQaId: null, tsAbs: T0 + i * 1000, qText: `测试问题${i}号`, aText: "回答", qTimeResolved: [],
  sourceType: "human-direct", intentWeight: 1, attachmentTypes: [], toolCallCount: 0, source: { file: "f", lineStart: 1, lineEnd: 1 }, shardId: "s",
});
const QAS = Array.from({ length: 30 }, (_, i) => qa(`qa${i}`, i));
const ep = (model: string): { baseUrl: string; apiKey: string; model: string } => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("v6：meta.json 与 clearCheckpointsFor（作废清断点）", () => {
  test("首次落盘时写 meta.json；clearCheckpointsFor 只删匹配 (sessionId, turnId) 的目录", () => {
    const root = mkdtempSync(join(tmpdir(), "intent-lab-cp-clear-"));
    const a = openCheckpoint("aaa", root, { sessionId: "s1", turnId: "t1" });
    a.saveScore("k", [1, 2]);
    const b = openCheckpoint("bbb", root, { sessionId: "s1", turnId: "t2" });
    b.saveScore("k", [1, 2]);
    const c = openCheckpoint("ccc", root); // 不带 meta（旧调用面）
    c.saveScore("k", [1, 2]);
    expect(JSON.parse(readFileSync(join(root, "aaa", "meta.json"), "utf8"))).toEqual({ sessionId: "s1", turnId: "t1" });
    expect(existsSync(join(root, "ccc", "meta.json"))).toBe(false);
    expect(clearCheckpointsFor("s1", new Set(["t1"]), root)).toBe(1);
    expect(existsSync(join(root, "aaa"))).toBe(false);
    expect(existsSync(join(root, "bbb"))).toBe(true); // 同会话别的轮不动
    expect(existsSync(join(root, "ccc"))).toBe(true); // 没有 meta 的旧断点不猜，等 TTL
    expect(clearCheckpointsFor("s1", new Set(["t2"]), root)).toBe(1);
  });
});

