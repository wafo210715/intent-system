/** 上下文文件（契约 v3.2 §四）的单元测试：两问追加、no 移除、edited 替换、notice 文案。 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sectionLineRange, appendQuestion, applyFeedbackToContext, contextQuestionCount, loadContextMd, loadContextState, pruneContexts, renderContextMd, clearAllContext } from "../src/context-file.ts";
import type { ContextEntryRow, ContextQuestionRow } from "../src/context-file.ts";

const T0 = Date.parse("2026-09-26T16:20:00+08:00");
const DIR = mkdtempSync(join(tmpdir(), "intent-lab-ctx-"));
const SID = "sess-ctx";

beforeAll(() => {
  process.env.INTENT_LAB_DATA = DIR;
});

const entry = (qaId: string, slot: number, over: Partial<ContextEntryRow> = {}): ContextEntryRow => ({
  sessionId: SID, question: 1, turnId: "t1", qaId, slot, score: 0.9,
  human: "我们当时定下用蓝绿部署发布", assistant: "切换由网关配置完成",
  connection: "都在定发布方案", prediction: "回答会引用蓝绿部署的做法", dupCount: 1,
  verdict: null, ...over,
});
const titleOf = (qaId: string) => (qaId === "qa1" ? "发布方案讨论" : "其他会话");
const tsOf = (qaId: string) => (qaId === "qa1" ? Date.parse("2026-08-12T14:03:00+08:00") : Date.parse("2026-09-01T09:00:00+08:00"));

describe("appendQuestion（done 追加第 N 问）", () => {
  test("两问追加：questions+entries 递增、md 分节、jsonl 行形状、notice 含新增条数与岗分布", () => {
    const c1 = appendQuestion(SID, {
      turnId: "t1", ts: T0, scene: "聊发布方案", want: "要一份回滚方案",
      entries: [entry("qa1", 1), { ...entry("qa2", 4, { question: 1 }), human: "测试问题", assistant: "", connection: "连接", prediction: "预测", score: 0.85, dupCount: 3 }],
      titleOf, tsOf,
    }, DIR);
    expect(c1.question).toBe(1);
    expect(c1.added).toBe(2);
    expect(c1.notice).toMatch(/^上下文文件更新了：第 1 问新增 2 条（岗 1 一条、岗 4 一条），理由写在文件里（在 .+\/context\.md 第 3–\d+ 行）。$/); // 10-10 起带绝对路径（插件 toast 要能直接找到磁盘文件）
    expect(c1.md).toContain("# 意图系统为这个会话整理的上下文");
    expect(c1.md).toContain("## 第 1 问（2026-09-26 16:20）");
    expect(c1.md).toContain("这一问在做什么：聊发布方案，想要 要一份回滚方案");
    expect(c1.md).toContain("### 岗 1 · 同一件事");
    expect(c1.md).toContain("▸ 08-12 14:03《发布方案讨论》· 0.9");
    expect(c1.md).toContain("  原文（你的原话，逐字）：我们当时定下用蓝绿部署发布");
    expect(c1.md).toContain("  原文（助手回答里补的一段）：切换由网关配置完成");
    expect(c1.md).toContain("  连接：都在定发布方案");
    // dupCount=3 → 「出现 3 次」；assistant 空 → 不写那行
    expect(c1.md).toContain("· 出现 3 次");
    expect(c1.md).not.toContain("原文（助手回答里补的一段）：\n");
    // jsonl 行形状（契约 §四）
    const rows = c1.jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sessionId: SID, question: 1, turnId: "t1", qaId: "qa1", slot: 1, score: 0.9, dupCount: 1, verdict: null });
    // 第 2 问：标题带「新增 N 条」，两问都在
    const c2 = appendQuestion(SID, {
      turnId: "t2", ts: T0 + 3600_000, scene: "接着聊灰度", want: "要百分比策略",
      entries: [entry("qa2", 1, { question: 2, connection: "第 2 问的连接" })],
      titleOf, tsOf,
    }, DIR);
    expect(c2.question).toBe(2);
    expect(c2.notice).toMatch(/^上下文文件更新了：第 2 问新增 1 条（岗 1 一条），理由写在文件里（在 .+\/context\.md 第 \d+–\d+ 行）。$/);
    expect(c2.md).toContain("## 第 1 问（2026-09-26 16:20）");
    expect(c2.md).toContain("## 第 2 问（2026-09-26 17:20）· 新增 1 条");
    expect(contextQuestionCount(SID, DIR)).toBe(2);
    expect(loadContextMd(SID, DIR)).toContain("第 2 问");
    const st = loadContextState(SID, DIR);
    expect(st.questions).toHaveLength(2);
    expect(st.entries).toHaveLength(3);
  });

  test("历史表态带入：yes 标「你确认过」、edited 标「你改为」", () => {
    const sid = "sess-mark";
    const c = appendQuestion(sid, {
      turnId: "t1", ts: T0, scene: "s", want: "w",
      entries: [entry("qa1", 1), entry("qa2", 2)],
      verdicts: new Map([
        ["qa1#1", { verdict: "yes" }],
        ["qa2#2", { verdict: "skip", edited: "其实是同一目的：赶在九月底前上线" }],
      ]),
      titleOf, tsOf,
    }, DIR);
    expect(c.md).toContain("· 0.9 · 你确认过");
    expect(c.md).toContain("你改为：其实是同一目的：赶在九月底前上线");
    const rows = c.jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.find((r) => r.qaId === "qa1")!.verdict).toBe("yes");
    expect(rows.find((r) => r.qaId === "qa2")!).toMatchObject({ verdict: "edited", edited: "其实是同一目的：赶在九月底前上线" });
  });
});

describe("applyFeedbackToContext（表态改写）", () => {
  test("no → md 移除、jsonl verdict 改 no 不删行；edited → 换用户说法；skip 不动", () => {
    appendQuestion("sess-fb", { turnId: "t1", ts: T0, scene: "s", want: "w", entries: [entry("qa1", 1), entry("qa2", 2)], titleOf, tsOf }, DIR);
    const r = applyFeedbackToContext("sess-fb", [
      { qaId: "qa1", slot: 1, verdict: "no" },
      { qaId: "qa2", slot: 2, verdict: "yes", edited: "这是我改过的连接说法" },
    ], { question: 1, titleOf, tsOf }, DIR);
    expect(r.md).not.toContain("qa1");
    expect(r.md).not.toContain("发布方案讨论"); // qa1 的条目整块移除
    expect(r.md).toContain("你改为：这是我改过的连接说法");
    expect(r.md).toContain("连接：这是我改过的连接说法"); // 连接句换成用户说法
    expect(r.notice).toContain("移除一条");
    expect(r.notice).toContain("按你的说法改写一条");
    const rows = r.jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(2); // no 不删行
    expect(rows.find((x) => x.qaId === "qa1")!.verdict).toBe("no");
    expect(rows.find((x) => x.qaId === "qa2")!).toMatchObject({ verdict: "edited", edited: "这是我改过的连接说法" });
    // skip：不改
    const r2 = applyFeedbackToContext("sess-fb", [{ qaId: "qa1", slot: 1, verdict: "skip" }], { question: 1, titleOf, tsOf }, DIR);
    expect(r2.jsonl).toBe(r.jsonl);
    expect(r2.notice).toContain("没有变化");
  });

  test("note（确认卡「补充背景」）写进那一问小节开头，落盘后后面的问题仍在；空 note 不覆盖", () => {
    appendQuestion("sess-note", { turnId: "t1", ts: T0, scene: "s1", want: "w1", entries: [entry("qa1", 1)], titleOf, tsOf }, DIR);
    const r = applyFeedbackToContext("sess-note", [{ qaId: "qa1", slot: 1, verdict: "skip" }], { question: 1, titleOf, tsOf, note: "  这篇文章我还没细读 " }, DIR);
    const sec1 = r.md.slice(r.md.indexOf("## 第 1 问"), r.md.indexOf("### 岗"));
    expect(sec1).toContain("你补充的背景：这篇文章我还没细读\n"); // 在岗段之前、去掉首尾空白
    expect(r.notice).toContain("记下你补充的背景");
    // 第 2 问追加后，第 1 问的 note 仍在（持久在 questions.jsonl）
    const r2 = appendQuestion("sess-note", { turnId: "t2", ts: T0 + 60_000, scene: "s2", want: "w2", entries: [entry("qa2", 2)], titleOf, tsOf }, DIR);
    expect(r2.md).toContain("你补充的背景：这篇文章我还没细读");
    // 再次表态但没填 note：不覆盖已有的
    const r3 = applyFeedbackToContext("sess-note", [{ qaId: "qa1", slot: 1, verdict: "yes" }], { question: 1, titleOf, tsOf, note: "" }, DIR);
    expect(r3.md).toContain("你补充的背景：这篇文章我还没细读");
  });
});

describe("renderContextMd 细节", () => {
  test("多问多岗按问分节按岗分段、时间排序；空条目的问题也有节", () => {
    const questions: ContextQuestionRow[] = [
      { question: 1, ts: T0, turnId: "t1", scene: "s1", want: "w1" },
      { question: 2, ts: T0 + 1000, turnId: "t2", scene: "s2", want: "w2" },
    ];
    const entries = [
      entry("qa2", 4, { question: 1 }),
      entry("qa1", 1, { question: 1 }),
      entry("qa1", 6, { question: 2, connection: "第二问连接" }),
    ];
    const md = renderContextMd(questions, entries, titleOf, tsOf);
    const i1 = md.indexOf("## 第 1 问");
    const i2 = md.indexOf("## 第 2 问");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(md.indexOf("### 岗 1 · 同一件事")).toBeGreaterThan(i1); // qa1（08-12）在 qa2（09-01）前
    expect(md.indexOf("### 岗 4 · 取舍标准", i1)).toBeGreaterThan(i1);
    expect(md.indexOf("### 岗 6 · 时序与修订")).toBeGreaterThan(i2);
  });
});

describe("clearAllContext", () => {
  test("清掉整个 data/context 目录", () => {
    expect(existsSync(join(DIR, "context"))).toBe(true);
    clearAllContext(DIR);
    expect(existsSync(join(DIR, "context"))).toBe(false);
  });
});

describe("selected 不设硬上限（v3.2 §三补记）", () => {
  test("入选 30 条时 context 30 条：added=30、md 30 个 ▸、jsonl 30 行", () => {
    const sid = "sess-30";
    const entries = Array.from({ length: 30 }, (_, i) => ({
      qaId: `m${i}`, slot: (i % 6) + 1, score: 0.8,
      human: `问题原文逐字${i}`, assistant: "", connection: `连接${i}`, prediction: `预测${i}`, dupCount: 1,
    }));
    const c = appendQuestion(sid, { turnId: "t1", ts: T0, scene: "s", want: "w", entries, titleOf, tsOf }, DIR);
    expect(c.question).toBe(1);
    expect(c.added).toBe(30);
    expect(c.md.match(/^▸/gm)).toHaveLength(30);
    expect(c.jsonl.split("\n").filter(Boolean)).toHaveLength(30);
    expect(c.notice).toContain("新增 30 条");
    clearAllContext(DIR);
  });
});

describe("同一轮重来与定位（09-29）", () => {
  test("同一 turnId 再走完：替换原来那一节、不新增一问；notice 说明是重来", () => {
    const sid = "sess-redo";
    appendQuestion(sid, { turnId: "t1", ts: T0, scene: "第一问", want: "w", entries: [entry("qa1", 1)], titleOf, tsOf }, DIR);
    appendQuestion(sid, { turnId: "t2", ts: T0 + 60_000, scene: "第二问（丢掉的那次）", want: "w", entries: [entry("qa1", 2), entry("qa2", 3)], titleOf, tsOf }, DIR);
    const redo = appendQuestion(sid, { turnId: "t2", ts: T0 + 120_000, scene: "第二问（重试）", want: "w", entries: [entry("qa2", 1)], titleOf, tsOf }, DIR);
    expect(redo.question).toBe(2);
    expect(redo.notice).toContain("同一轮重来");
    expect(redo.md).not.toContain("丢掉的那次");
    expect(redo.md.match(/^## 第 /gm)).toHaveLength(2);
    const st = loadContextState(sid, DIR);
    expect(st.questions.map((q) => q.scene)).toEqual(["第一问", "第二问（重试）"]);
    expect(st.entries.filter((e) => e.question === 2)).toHaveLength(1); // 旧的两条被替换
    // 之后的新一轮照常是第 3 问
    expect(appendQuestion(sid, { turnId: "t3", ts: T0 + 180_000, scene: "第三问", want: "w", entries: [], titleOf, tsOf }, DIR).question).toBe(3);
  });

  test("sectionLineRange：首行是该问标题、末行是下一问标题前最后一个非空行", () => {
    const sid = "sess-lines";
    appendQuestion(sid, { turnId: "t1", ts: T0, scene: "s1", want: "w", entries: [entry("qa1", 1), entry("qa2", 4)], titleOf, tsOf }, DIR);
    const c = appendQuestion(sid, { turnId: "t2", ts: T0 + 60_000, scene: "s2", want: "w", entries: [entry("qa2", 1)], titleOf, tsOf }, DIR);
    const lines = c.md.split("\n");
    for (const n of [1, 2]) {
      const [a, b] = sectionLineRange(c.md, n)!;
      expect(lines[a - 1]).toStartWith(`## 第 ${n} 问`);
      expect(lines[b - 1]!.trim()).not.toBe("");
      const after = lines.slice(b).find((l) => l.trim() !== "");
      expect(after === undefined || after.startsWith("## 第 ")).toBe(true);
    }
    expect(c.notice).toContain(`第 ${sectionLineRange(c.md, 2)!.join("–")} 行`);
    expect(sectionLineRange(c.md, 9)).toBeNull();
  });

  test("小节里写上原话（超过 200 字截断），回答模型能把「第 N 问」对上是哪条消息", () => {
    const long = "then what do you think about chapter 1 ".repeat(10);
    const c = appendQuestion("sess-q", { turnId: "t1", ts: T0, scene: "s", want: "w", q: long, entries: [], titleOf, tsOf }, DIR);
    expect(c.md).toContain(`你的原话：${long.slice(0, 200)}…`);
    const c2 = appendQuestion("sess-q", { turnId: "t2", ts: T0 + 1, scene: "s", want: "w", q: "短问题", entries: [], titleOf, tsOf }, DIR);
    expect(c2.md).toContain("你的原话：短问题\n这一问在做什么");
  });
});

describe("pruneContexts（契约 v6：作废后重生成）", () => {
  const SID2 = "sess-ctx6";
  const mk = (sid: string, turns: string[]): void => {
    clearAllContext(DIR);
    turns.forEach((t, i) => {
      appendQuestion(sid, {
        turnId: t, ts: T0 + i * 3600_000, scene: `场景${i}`, want: `想要${i}`,
        entries: [entry(`qa-${t}`, 1, { question: i + 1, turnId: t })],
        titleOf: () => "标题", tsOf: () => T0,
      }, DIR);
    });
  };
  test("去掉中间一问：后面的小节重编号成连续的，不留「已回退」墓碑", () => {
    mk(SID2, ["a", "b", "c"]);
    const pruned = pruneContexts(DIR, { turnIdsBySession: new Map([[SID2, new Set(["b"])]]), hiddenQaIds: new Set(), titleOf: () => "标题", tsOf: () => T0 });
    const mine = pruned.get(SID2);
    expect(mine).toMatchObject({ removedQuestions: 1, removedEntries: 1, remaining: 2 });
    const after = loadContextState(SID2, DIR);
    expect(after.questions.map((q) => [q.question, q.turnId])).toEqual([[1, "a"], [2, "c"]]);
    expect(after.entries.every((e) => e.turnId !== "b")).toBe(true);
    expect(after.entries.map((e) => e.question)).toEqual([1, 2]);
    const md = loadContextMd(SID2, DIR) ?? "";
    expect(md).toContain("## 第 1 问");
    expect(md).toContain("## 第 2 问");
    expect(md).not.toContain("## 第 3 问"); // 重编号，不给回答模型留空洞
  });
  test("小节全部去掉：目录整个删掉，下一问从第 1 问重新计", () => {
    mk(SID2, ["a", "b"]);
    const pruned = pruneContexts(DIR, { turnIdsBySession: new Map([[SID2, new Set(["a", "b"])]]), hiddenQaIds: new Set(), titleOf: () => "标题", tsOf: () => T0 });
    expect(pruned.get(SID2)).toMatchObject({ removedQuestions: 2, remaining: 0 });
    expect(existsSync(join(DIR, "context", SID2))).toBe(false);
    expect(contextQuestionCount(SID2, DIR)).toBe(0);
  });
  test("别的会话上下文里引用了被作废 QA：条目去掉、小节保留（没问的被回退，条目指向被回退的 QA）", () => {
    mk(SID2, ["a", "b"]);
    appendQuestion("sess-other", {
      turnId: "o1", ts: T0 + 9 * 3600_000, scene: "别的会话", want: "别的",
      entries: [entry("orbita:s1:gone", 1, { question: 1, turnId: "o1" }), entry("qa-keep", 1, { question: 1, turnId: "o1" })],
      titleOf: () => "标题", tsOf: () => T0,
    }, DIR);
    const pruned = pruneContexts(DIR, { turnIdsBySession: new Map([[SID2, new Set(["a"])]]), hiddenQaIds: new Set(["orbita:s1:gone"]), titleOf: () => "标题", tsOf: () => T0 });
    expect(pruned.get(SID2)?.removedQuestions).toBe(1);
    const other = pruned.get("sess-other");
    expect(other).toMatchObject({ removedQuestions: 0, removedEntries: 1, remaining: 1 });
    expect(loadContextState("sess-other", DIR).entries.map((e) => e.qaId)).toEqual(["qa-keep"]);
    expect((loadContextMd("sess-other", DIR) ?? "")).toContain("## 第 1 问"); // 小节还在（这一问没被回退）
  });
  test("没有任何匹配：不动文件、不进返回表", () => {
    mk(SID2, ["a"]);
    const before = loadContextMd(SID2, DIR);
    const pruned = pruneContexts(DIR, { turnIdsBySession: new Map([[SID2, new Set(["zzz"])]]), hiddenQaIds: new Set(), titleOf: () => "标题", tsOf: () => T0 });
    expect(pruned.size).toBe(0);
    expect(loadContextMd(SID2, DIR)).toBe(before);
  });
});
