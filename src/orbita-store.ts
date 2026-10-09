/**
 * Orbita 侧的持久化（都在 data/ 下，只追加）：
 *   qa-orbita.jsonl          /ingest 写入的 Orbita 问答（与 Proma 入库的 qa.jsonl 合并加载）
 *   orbita/intents.jsonl     每个会话上一轮的意图对象（S1 的 prev），重启后可恢复
 *   orbita/injected.jsonl    每个会话已注入过的 qaId（注入去重用）
 *
 * 重新 bun run ingest（Proma 入库）只重建 qa.jsonl / sessions.jsonl，不碰这三个文件。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IntentObject } from "./types.ts";
import { dataDir } from "./store.ts";
import type { QA } from "./types.ts";

/** qa-orbita.jsonl 的一行：QA 字段 + Orbita 侧的 turnId 与会话标题（Orbita 会话不在 Proma 的 sessions.jsonl 里） */
export interface OrbitaQaRow extends QA {
  turnId: string;
  title: string;
}

export function orbitaDir(dir = dataDir()): string {
  return join(dir, "orbita");
}

export function orbitaQaId(sessionId: string, turnId: string): string {
  return `orbita:${sessionId}:${turnId}`;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

function appendJsonl(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

// ---------- qa-orbita.jsonl（/ingest）与 qa-import.jsonl（/import，契约 v2 路 1） ----------

export function loadOrbitaQAs(dir = dataDir()): OrbitaQaRow[] {
  return readJsonl<OrbitaQaRow>(join(dir, "qa-orbita.jsonl"));
}

/** 迁移送来的历史（/import）；与 qa-orbita.jsonl 同构、同去重键 */
export function loadImportedQAs(dir = dataDir()): OrbitaQaRow[] {
  return readJsonl<OrbitaQaRow>(join(dir, "qa-import.jsonl"));
}

export function appendImportedQa(row: OrbitaQaRow, dir = dataDir()): void {
  appendJsonl(join(dir, "qa-import.jsonl"), row);
}

/** 已入库的 (sessionId, turnId)，/ingest 与 /import 共用 */
export function orbitaSeenKeys(rows: Iterable<OrbitaQaRow>): Set<string> {
  return new Set([...rows].map((r) => `${r.sessionId}\u0000${r.turnId}`));
}

/**
 * 内容去重键 v2（2026-10-08）：只看内容不看时间。
 * v1（09-29）= tsAbs + trim(qText)，拦不住跨源重复：开发版从 Orbita 正式版导入的会话，早先
 * 在 Proma 入过库，同一批对话两边的 tsAbs 对不上（Orbita 迁移时重给了时间戳），v1 认不出，
 * 可见 QA 一度从 7,056 涨到 9,770。v2 键只用**原文**（不用任何改写 / 指代说明）规整后的内容：
 *   - 去掉全部空白后，qText 取前 400 字、aText 取前 200 字；
 *   - qText 规整后不足 10 字的（「继续」「好的」这类真的可能撞原话的），aText 必须全文相同才算重复；
 *   - 截断是必要的：跨源迁移的行在 400 字之后常有出入（Orbita 截存 / 尾部差异），不截认不出。
 */
export const CONTENT_Q_CLIP = 400;
export const CONTENT_A_CLIP = 200;
export const CONTENT_SHORT_Q = 10;

const normText = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, "");

export function contentKey(r: { qText: string; aText?: string | null }): string | null {
  const q = normText(r.qText).slice(0, CONTENT_Q_CLIP);
  if (!q) return null;
  const a = normText(r.aText);
  // 短问比答案全文，长问只比答案前 200 字；前缀 0/1 把两个口径隔开，短问键不会撞长问键
  return q.length < CONTENT_SHORT_Q ? `1\u0000${q}\u0001${a}` : `0\u0000${q}\u0001${a.slice(0, CONTENT_A_CLIP)}`;
}

/** 内容键 → 最早入库的那条 qaId（入参只依赖原文内容，qa.jsonl 的 QA 行也能喂） */
export function contentIndex(rows: Iterable<{ qText: string; aText?: string | null; qaId?: string }>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const r of rows) {
    const k = contentKey(r);
    if (k !== null && !idx.has(k)) idx.set(k, r.qaId ?? "");
  }
  return idx;
}

/** qa.jsonl 的内容键索引（proma 源 /import、/ingest 的内容去重要比对它，10-08）：
 *  按文件 mtime 缓存——qa.jsonl 只在 CLI 重放入库时才重写，服务进程不用每次请求都重读全表。 */
const qaJsonlIdxCache = new Map<string, { mtimeMs: number; idx: Map<string, string> }>();
export function qaJsonlContentIndex(dir = dataDir()): Map<string, string> {
  const path = join(dir, "qa.jsonl");
  const mtimeMs = existsSync(path) ? statSync(path).mtimeMs : -1;
  const hit = qaJsonlIdxCache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.idx;
  const idx = contentIndex(readJsonl<QA>(path)); // 文件不存在 readJsonl 给空数组
  qaJsonlIdxCache.set(dir, { mtimeMs, idx });
  return idx;
}

/** /import 存量 + /ingest 存量合并（v6 更新语义，2026-10-09）：同一 (sessionId, turnId)
 *  （= 同一 qaId）可能有多行——重试重入库、以及「内容更新」（/import /ingest 收到同
 *  turnId 但内容变了时：作废旧行 + 同 qaId 追加新行）。合并要把它们排成「旧 → 新」的
 *  取代链，dropInvalidated 才能按出现次数从链头藏起：
 *  - 同键时 ingest 行在前、import 行在后（import 一定是更晚发生的事件）；各自文件内按追加序；
 *  - 链上**相邻**两行内容键相同（历史双写）只留一份（留后到的那份，与旧口径的 import 优先一致）；
 *    不相邻的同内容（A→B→A 回到旧内容）是真实更新，照留；
 *  - 输出按 (tsAbs, qaId) 排，但同一 qaId 的行保持链序（tsAbs 可能乱序：live 入库记的是
 *    settle 钟表时间、迁移入库记的是消息原时间，不能靠 tsAbs 排链）。 */
export function mergeOrbitaQAs(imported: OrbitaQaRow[], ingested: OrbitaQaRow[]): OrbitaQaRow[] {
  const chains = new Map<string, OrbitaQaRow[]>();
  const add = (row: OrbitaQaRow): void => {
    const c = chains.get(row.qaId);
    if (c === undefined) {
      chains.set(row.qaId, [row]);
      return;
    }
    const lastKey = contentKey(c[c.length - 1]!);
    const rowKey = contentKey(row);
    if (lastKey !== null && lastKey === rowKey) {
      c[c.length - 1] = row; // 相邻同内容：双写，留后到的一份
      return;
    }
    c.push(row);
  };
  for (const row of ingested) add(row);
  for (const row of imported) add(row);
  // 同 qaId 行的链内位置（排序时作第三级 tiebreak，保持链序）
  const pos = new Map<OrbitaQaRow, number>();
  const flat: OrbitaQaRow[] = [];
  for (const rows of chains.values()) {
    for (let i = 0; i < rows.length; i++) {
      pos.set(rows[i]!, i);
      flat.push(rows[i]!);
    }
  }
  return flat.sort((a, b) =>
    a.qaId === b.qaId ? (pos.get(a)! - pos.get(b)!) : a.tsAbs - b.tsAbs || a.qaId.localeCompare(b.qaId),
  );
}

/**
 * proma 源并入 /import 行（2026-10-07，开发版从 Orbita 正式版导入会话后）。
 * 2026-10-08 修跨源重复：内容键改 v2（只看原文内容不看时间，见 contentKey）——Orbita 迁移
 * 给的 tsAbs 与 Proma 不同，按时间的键认不出同一批对话，qaVisible 一夜翻倍。
 * - qaId 先到先得——qa.jsonl / qa-orbita 已有的 id 不被 import 行顶掉（边、表态、指代说明都挂在老 id 上）；
 *   跨源重复因此优先保留 qa.jsonl（Proma）那份；同 qaId 且内容相同 = 跨文件双写，同样只留 base 一份
 * - 内容键撞上已有行的 import 行不进——同一句话不召回两次；
 *   import 行彼此之间同样按内容键去重（服务端 /import 只查 import+orbita，查不到 qa.jsonl）
 * - **同 qaId 但内容不同**（2026-10-09 内容更新语义）：两行都留、base 在前 import 在后，
 *   成取代链交给 dropInvalidated（按作废次数从链头藏）——新内容照常可见、旧内容不再召回
 * - **内容键洗 base**（2026-10-09 晚，验收修）：qa-orbita 的行与 qa.jsonl 同内容 → 藏掉（保留
 *   proma 那份）；base 里 orbita 行彼此同内容 → 保留最早。与 /import 入口的内容去重同规则
 * - 输出按时间重排（同 qaId 保持链序，与 loadQAs 的合并排序同一套规则）
 */
export function mergeImportedQAs(base: QA[], imported: readonly OrbitaQaRow[]): QA[] {
  // 2026-10-09 晚（验收修）先洗 base——两层内容去重，与 /import 入口同一规则，兑住更新路径
  // 追加过的与历史遗留的同内容行：
  //  - qa-orbita 的行与 qa.jsonl（proma 基座）内容键相同 → 藏掉（保留 proma 那份：边、表态、
  //    指代说明都挂在它的 qaId 上）；
  //  - base 里 orbita 行彼此内容键相同 → 保留最早（base 已按 tsAbs 排序），其余藏掉。
  const promaKeys = contentIndex(base.filter((r) => !r.qaId.startsWith("orbita:")));
  const seenOrbitaKeys = new Set<string>();
  const cleaned: QA[] = [];
  for (const r of base) {
    if (r.qaId.startsWith("orbita:")) {
      const k = contentKey(r);
      if (k !== null && (promaKeys.has(k) || seenOrbitaKeys.has(k))) continue;
      if (k !== null) seenOrbitaKeys.add(k);
    }
    cleaned.push(r);
  }
  const byId = new Set(cleaned.map((r) => r.qaId));
  const seenContent = contentIndex(cleaned);
  const out = [...cleaned];
  for (const row of imported) {
    const k = contentKey(row);
    if (byId.has(row.qaId)) {
      // 同 qaId 已在 base（只可能是 qa-orbita 的行——qa.jsonl 的 id 不带 orbita: 前缀）：
      // 内容相同 = 双写，留 base；内容不同 = 内容更新，链尾插入（最后一个同 id 行之后）。
      // 2026-10-09 晚（验收修）：更新行的新内容若与**别的行**（qa.jsonl / 其他 turn）同内容，
      // 不进合并——那句已有别的行代表（同一句话不召回两次），日后的重送走服务端的
      // hidden-as-duplicate；进入链尾的行要把内容键登记进 seenContent，后面的同内容行才能被认出
      const same = out.some((r) => r.qaId === row.qaId && contentKey(r) !== null && contentKey(r) === k);
      if (same) continue;
      if (k !== null && seenContent.has(k)) continue;
      let at = out.length;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i]!.qaId === row.qaId) {
          at = i + 1;
          break;
        }
      }
      out.splice(at, 0, row);
      if (k !== null) seenContent.set(k, row.qaId);
      continue;
    }
    if (k !== null && seenContent.has(k)) continue;
    byId.add(row.qaId);
    if (k !== null && !seenContent.has(k)) seenContent.set(k, row.qaId);
    out.push(row);
  }
  // 同 qaId 保持链序（第三级 tiebreak）：live 入库记 settle 钟表时间、迁移入库记消息原时间，
  // 同一 turn 的两行 tsAbs 可能乱序，靠 tsAbs 排会把取代链排反
  const pos = new Map<QA, number>();
  for (let i = 0; i < out.length; i++) pos.set(out[i]!, i);
  return out.sort((a, b) =>
    a.qaId === b.qaId ? (pos.get(a)! - pos.get(b)!) : a.tsAbs - b.tsAbs || a.qaId.localeCompare(b.qaId),
  );
}

export function appendOrbitaQa(row: OrbitaQaRow, dir = dataDir()): void {
  appendJsonl(join(dir, "qa-orbita.jsonl"), row);
}

// ---------- orbita/intents.jsonl ----------

export interface IntentRow {
  ts: number;
  runId: string;
  sessionId: string;
  intent: IntentObject;
}

export function appendIntent(row: IntentRow, dir = dataDir()): void {
  appendJsonl(join(orbitaDir(dir), "intents.jsonl"), row);
}

/** 取每个 sessionId 最后一次 done 的意图对象 */
export function loadPrevIntents(dir = dataDir()): Map<string, IntentObject> {
  const map = new Map<string, IntentObject>();
  for (const r of readJsonl<IntentRow>(join(orbitaDir(dir), "intents.jsonl"))) map.set(r.sessionId, r.intent);
  return map;
}

// ---------- orbita/injected.jsonl ----------

export interface InjectedRow {
  ts: number;
  runId: string;
  sessionId: string;
  /** 这次实际注入的 qaId（被否认的不算） */
  qaIds: string[];
}

export function appendInjected(row: InjectedRow, dir = dataDir()): void {
  appendJsonl(join(orbitaDir(dir), "injected.jsonl"), row);
}

/** 每个会话已注入过的 qaId 集合（注入去重用） */
export function loadInjectedBySession(dir = dataDir()): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const r of readJsonl<InjectedRow>(join(orbitaDir(dir), "injected.jsonl"))) {
    const set = map.get(r.sessionId) ?? new Set<string>();
    for (const id of r.qaIds) set.add(id);
    map.set(r.sessionId, set);
  }
  return map;
}
