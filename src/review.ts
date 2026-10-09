/**
 * S4 全局审核：长上下文主模型一次看完所有子 agent 交上来的面试报告，
 *   1. 选出最终进入回答的 QA（去重、统一尺子、覆盖不同岗位）；
 *   2. 写一句总结"我理解你这次要……"；
 *   3. 挑出最多 3 条"难取舍"的关系，交给 S6 确认卡；
 *   4. 判断够不够（扳机）。
 *
 * 什么时候该问你，写成三条硬规则（09-25 定），保证提问稳定：
 *   a. 这条关系你从没确认过；
 *   b. 它是解读而不是事实——只问岗 2 目的 / 岗 3 同构 / 岗 4 取舍；岗 1/5/6 有原话可引，直接引用；
 *   c. 用它和不用它，回答会明显不同。
 */
import type { IntentObject } from "./types.ts";
import type { ChatMessage, JsonCaller, Usage } from "./llm.ts";
import { slotNameOf, type Bid } from "./types.ts";
import type { QA } from "./types.ts";

export interface Selected {
  qaId: string;
  slots: number[];
  why: string;
}

export interface AskItem {
  qaId: string;
  slot: number;
  /** 一句你可以点"对 / 不对"的陈述，不是开放式问题 */
  statement: string;
  whyUncertain: string;
}

export interface Review {
  summary: string;
  selected: Selected[];
  ask: AskItem[];
  enough: boolean;
  missing: string | null;
}

/** 用户对一条 (qaId, 岗) 表态后的状态：yes=确认 / no=否认 / skip=不表态；
 *  edited 可与任何 verdict 并存（改过字即视为已表态）；statement 是该次确认卡的陈述，渲染否认行用 */
export interface ConfirmState {
  verdict: "yes" | "no" | "skip";
  edited?: string;
  statement?: string;
}

export const MAX_SELECTED = 12;
export const MAX_ASK = 3;
export const ASKABLE_SLOTS = new Set([2, 3, 4]);

export const slotName = slotNameOf; // review-run（旧式审核）也用
export const fmtReviewLine = (ts: number) => new Date(ts + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

/**
 * 模型回抄 qaId 时会丢掉来源前缀（真源 `orbita:<sessionId>:<turnId>`，模型抄成 `<sessionId>:<turnId>`）。
 * 精确匹配不上时按「去掉前缀后唯一命中」映射回来；命中不唯一（如裸 turnIndex 会撞一堆）就返回 null，
 * 调用方照旧丢弃并写明原因。改校验层而不是改报告渲染：报告里的 qaId 与 bids.jsonl 可直接对照，
 * 且 S4 / 守门员两条路径各自都要改两处，容错解析只动一个函数。
 */
export function resolveQaId(raw: string, known: Iterable<string>): string | null {
  const ids = [...known];
  if (ids.includes(raw)) return raw;
  const key = `:${raw}`;
  const hits = ids.filter((id) => id.endsWith(key));
  return hits.length === 1 ? hits[0]! : null;
}

/** 按 QA 聚合报告，按时间排，渲染成审核者读的清单（只放报告，不放原文）；
 *  marks：历史表态（键 `${qaId}#${slot}`），有表态的报名行尾标注，让 S4 知道哪些关系用户已经表过态 */
export function confirmedKeysOf(marks?: Map<string, ConfirmState>): Set<string> | undefined {
  if (!marks) return undefined;
  const out = new Set<string>();
  for (const [key, m] of marks) if (m.verdict !== "skip" || m.edited) out.add(key);
  return out;
}

/**
 * S5 注入块：交给回答模型的上下文。一句总结 + 选中 QA 的原文（按时间排），
 * 每条标出岗位与用途；待确认的关系标注"用户尚未确认"。
 * v3.2 §三补记：入参 selected 可能多于 12 条（守门员不设上限），这里只取前 12 条
 * （拼进原话的体积控制；上下文文件路径不受影响）。
 * confirms（键 `${qaId}#${slot}`，一般是本次确认卡的表态）：
 *   - 被选中的岗全部被否认（no）才不注入整条；只否认一部分时保留原文，
 *     并在该条下加一行「用户否认了「<岗名>」这层关系：<statement>」；
 *   - yes 去掉待确认标注；edited（改过字）视为已表态，只写「用户更正：<edited>」，不再标尚未确认；
 *   - skip / 未表态：维持「使用前先向用户确认」标注。
 * note：用户补的一句背景，写在注入块开头。
 * injectedBefore：同一会话前面已注入过的 qaId，只留一行指引、不重复原文。
 * 实际注入条目为 0 时返回空串（不要空的 <intent_context> 块）。
 */
export function buildInjection(
  review: Review,
  qaById: Map<string, QA>,
  titleOf: (sid: string) => string,
  confirms: Map<string, ConfirmState> = new Map(),
  note?: string,
  injectedBefore?: Set<string>,
): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（截断）` : s);
  const settled = (key: string): boolean => {
    const c = confirms.get(key);
    return !!c && (c.verdict === "yes" || !!c.edited);
  };
  const deniedSlot = (qaId: string, slot: number): boolean => confirms.get(`${qaId}#${slot}`)?.verdict === "no";
  // 条目还带「用户尚未确认」标注 ⇔ 它的某个待确认关系至今没被点过「对」、也没改过字
  const hasUnconfirmed = (qaId: string) => review.ask.some((a) => a.qaId === qaId && !settled(`${a.qaId}#${a.slot}`));
  // v3.2 §三补记：selected / 上下文文件不设硬上限，只有旧式 injection 保留 12 条（拼进原话的体积控制）
  const items = review.selected
    .filter((s) => !(s.slots.length > 0 && s.slots.every((slot) => deniedSlot(s.qaId, slot)))) // 全否认才不注入
    .map((s) => ({ s, qa: qaById.get(s.qaId) }))
    .filter((x): x is { s: Selected; qa: QA } => !!x.qa)
    .sort((a, b) => a.qa.tsAbs - b.qa.tsAbs)
    .slice(0, MAX_SELECTED);
  if (!items.length) return "";
  const body = items
    .map(({ s, qa }) => {
      if (injectedBefore?.has(s.qaId)) {
        return `### ${fmtReviewLine(qa.tsAbs)}《${titleOf(qa.sessionId)}》· ${s.slots.map(slotName).join(" / ")} ·（已在本会话前面注入过，见上文）`;
      }
      const tag = hasUnconfirmed(s.qaId) ? " ·（用户尚未确认这层关系，使用前先向用户确认）" : "";
      // 更正与否认行按 qaId 的全部表态渲染（表态的岗不必出现在 selected.slots 里：
      // 用户在岗 2 的陈述上改了字 / 否认了岗 2 的解读，回答模型都该知道）
      const qaConfirms = [...confirms.entries()].filter(([k]) => k.startsWith(`${s.qaId}#`));
      const extra = [
        ...qaConfirms.filter(([, c]) => !!c.edited).map(([, c]) => `用户更正：${c.edited}`),
        ...qaConfirms.filter(([, c]) => c.verdict === "no").map(([k, c]) => `用户否认了「${slotName(Number(k.slice(k.lastIndexOf("#") + 1)))}」这层关系：${c.statement ?? ""}`),
      ];
      const extraLines = extra.length ? `\n${extra.join("\n")}` : "";
      return `### ${fmtReviewLine(qa.tsAbs)}《${titleOf(qa.sessionId)}》· ${s.slots.map(slotName).join(" / ")}${tag}\n用途：${s.why}${extraLines}\n用户：${clip(qa.qText, 1500)}\n助手：${clip(qa.aText, 2500)}`;
    })
    .join("\n\n");
  const head = note ? `用户补充的背景：${note}\n\n` : "";
  return `<intent_context>\n${head}意图系统的理解：${review.summary}\n\n以下是从用户过往对话里取回的相关原文，按时间排列（越靠后越新；前后说法不同时以新的为准）。\n\n${body}\n</intent_context>`;
}
