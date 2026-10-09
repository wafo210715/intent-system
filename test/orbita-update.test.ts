/**
 * 内容更新（v6 增补，2026-10-09）的合并语义：同 (sessionId, turnId)（= 同 qaId）多行时
 * 必须排成「旧 → 新」的取代链，dropInvalidated 按出现次数从链头藏。关键回归点：
 * live /ingest 记的是 settle 钟表时间、迁移 /import 记的是消息原时间，同一 turn 的两行
 * tsAbs 可能乱序（导入的更早）——靠 tsAbs 排会把链排反，藏掉的就是新内容。
 */
import { describe, expect, test } from "bun:test";
import { contentKey, mergeImportedQAs, mergeOrbitaQAs, type OrbitaQaRow } from "../src/orbita-store.ts";
import { dropInvalidated } from "../src/invalidation.ts";
import type { QA } from "../src/types.ts";

const mk = (over: Partial<OrbitaQaRow> & Pick<OrbitaQaRow, "qaId" | "qText" | "tsAbs"> & { turnId?: string; sessionId?: string }): OrbitaQaRow => ({
  sessionId: over.sessionId ?? "s1",
  turnIndex: 0,
  prevQaId: null,
  nextQaId: null,
  aText: "答",
  qTimeResolved: [],
  sourceType: "human-direct",
  intentWeight: 1,
  attachmentTypes: [],
  toolCallCount: 0,
  source: { file: "orbita", lineStart: 0, lineEnd: 0 },
  shardId: "s1",
  turnId: over.turnId ?? over.qaId,
  title: "t",
  ...over,
} as OrbitaQaRow);
const inv1 = (): Map<string, number> => new Map<string, number>([["orbita:s1:t1", 1]]);

describe("mergeOrbitaQAs 取代链（内容更新）", () => {
  test("同 qaId：ingest 行在前、import 行在后（哪怕 import 的 tsAbs 更早），作废一次藏旧行、新行可见", () => {
    // live 入库（settle 钟 = 晚）→ 重送历史（消息原时间 = 早）但内容带上了引用块
    const oldRow = mk({ qaId: "orbita:s1:t1", turnId: "t1", qText: "剥了引用的原话", tsAbs: 1_000_000 });
    const newRow = mk({ qaId: "orbita:s1:t1", turnId: "t1", qText: "<quoted_context>\n引用\n</quoted_context>\n\n剥了引用的原话", tsAbs: 500_000 });
    const merged = mergeOrbitaQAs([newRow], [oldRow]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(oldRow);
    expect(merged[1]).toBe(newRow);
    const visible = dropInvalidated(merged, inv1());
    expect(visible).toEqual([newRow]);
  });

  test("链上相邻同内容（历史双写）只留一份（留后到的 import 行）；不相交的同内容照留（A→B→A 是真实更新）", () => {
    const a1 = mk({ qaId: "orbita:s1:t1", qText: "内容 A", tsAbs: 1 });
    const dupA = mk({ qaId: "orbita:s1:t1", qText: "内容 A", tsAbs: 1 }); // 同内容双写（import 重送）
    const merged = mergeOrbitaQAs([dupA], [a1]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(dupA);

    const b = mk({ qaId: "orbita:s1:t2", qText: "内容 A", tsAbs: 2 }); // 不同 turn：内容键撞上但键不同，照常入库
    const again = mergeOrbitaQAs([b], [a1]);
    expect(again).toHaveLength(2);
  });

  test("不同 qaId 的排序照旧（tsAbs, qaId）", () => {
    const r1 = mk({ qaId: "orbita:s1:a", qText: "甲", tsAbs: 2 });
    const r2 = mk({ qaId: "orbita:s1:b", qText: "乙", tsAbs: 1 });
    const merged = mergeOrbitaQAs([r1], [r2]);
    expect(merged.map((r) => r.qaId)).toEqual(["orbita:s1:b", "orbita:s1:a"]);
  });
});

describe("mergeImportedQAs（proma 源）同 qaId 的更新行", () => {
  const baseQa = (qaId: string, qText: string, tsAbs: number): QA => ({
    qaId, sessionId: "s1", turnIndex: 0, prevQaId: null, nextQaId: null, tsAbs, qText, aText: "答",
    qTimeResolved: [], sourceType: "human-direct", intentWeight: 1, attachmentTypes: [], toolCallCount: 0,
    source: { file: "qa.jsonl", lineStart: 0, lineEnd: 0 }, shardId: "s1",
  });  test("同 qaId 内容不同：两行都留、base 在前（tsAbs 乱序也不反），作废一次藏旧留新；内容相同只留 base", () => {
    const oldRow = baseQa("orbita:s1:t1", "旧内容", 1_000_000); // qa-orbita 的 live 行（settle 钟晚）
    const upd = mk({ qaId: "orbita:s1:t1", turnId: "t1", qText: "新内容（引用拼回来了）", tsAbs: 500_000 }); // import 更新行（消息时间早）
    const merged = mergeImportedQAs([oldRow], [upd]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(oldRow);
    expect(merged[1]).toBe(upd);
    const visible = dropInvalidated(merged, inv1());
    expect(visible).toEqual([upd]);

    const dupAgain = mk({ qaId: "orbita:s1:t1", turnId: "t1", qText: "旧内容", tsAbs: 999 });
    expect(mergeImportedQAs([oldRow], [dupAgain])).toEqual([oldRow]);
  });

  test("不同 qaId 但同内容键：import 行不进（跨源去重照旧）", () => {
    const baseRow = baseQa("qa1", "跨源同内容的一句话，长度超过十个字", 1);
    const cross = mk({ qaId: "orbita:s2:t9", turnId: "t9", sessionId: "s2", qText: "跨源同内容的一句话，长度超过十个字", tsAbs: 2 });
    expect(mergeImportedQAs([baseRow], [cross])).toEqual([baseRow]);
    expect(contentKey(baseRow)).not.toBeNull();
  });

  test("验收修（2026-10-09 晚）：更新行的新内容与 qa.jsonl 同内容 → 不进链（proma 那份代表）；洗 base 藏掉 qa-orbita 里的同内容行", () => {
    const promaRow = baseQa("qa1", "带引用的同一段原话，超过十个字够长了吧", 1);
    // qa-orbita 的旧 live 行（内容与 proma 同）——洗 base 时应被藏掉（保留 proma 那份）
    const orbitaLive = mk({ qaId: "orbita:s1:t1", turnId: "t1", qText: "带引用的同一段原话，超过十个字够长了吧", tsAbs: 2 });
    // 同 qaId 的更新行（新内容与 proma 同）——不进链
    const upd = mk({ qaId: "orbita:s1:t1", turnId: "t1", qText: "带引用的同一段原话，超过十个字够长了吧", tsAbs: 1 });
    const merged = mergeImportedQAs([promaRow, orbitaLive], [upd]);
    expect(merged).toEqual([promaRow]);
  });

  test("验收修：更新链分支要登记内容键——两个会话各自的更新行同内容时只留一个（内部重复 7 行的形状）", () => {
    // 同一对话存在两个数据目录：两个 sessionId、同 turnId；各自被更新到同一段新内容
    const aOld = mk({ qaId: "orbita:sa:t1", turnId: "t1", sessionId: "sa", qText: "旧剥引用的口径内容", tsAbs: 1 });
    const bOld = mk({ qaId: "orbita:sb:t1", turnId: "t1", sessionId: "sb", qText: "旧剥引用的口径内容", tsAbs: 1 });
    const aNew = mk({ qaId: "orbita:sa:t1", turnId: "t1", sessionId: "sa", qText: "新口径内容，带上了引用块，足够长", tsAbs: 1 });
    const bNew = mk({ qaId: "orbita:sb:t1", turnId: "t1", sessionId: "sb", qText: "新口径内容，带上了引用块，足够长", tsAbs: 1 });
    // 文件序：旧行在前、更新行在后；qa-import 内 sa 的行先入库
    const merged = mergeImportedQAs([], [aOld, bOld, aNew, bNew]);
    const ids = merged.map((r) => r.qaId);
    expect(ids).toEqual(["orbita:sa:t1", "orbita:sa:t1"]);
    expect(merged.filter((r) => r.qText.includes("新口径")).length).toBe(1);
  });
});
