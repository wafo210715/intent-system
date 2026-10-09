/**
 * 历史加载（10-05 抽出）：服务端（server.ts）与预热脚本（scripts/s3b-prewarm.ts）共用同一份，
 * 保证脚本算 pads 的那批 QA、标题与 /recall 实际面试的一字不差（来源选择、excludeSessions、
 * 去重合并、排序都走这里，不许在脚本里另写一份）。
 */
import { loadConfig } from "./config.ts";
import { dropInvalidated, loadInvalidated, type InvalidatedRow, invalidatedQaCounts } from "./invalidation.ts";
import { loadImportedQAs, loadOrbitaQAs, mergeImportedQAs, mergeOrbitaQAs, type OrbitaQaRow } from "./orbita-store.ts";
import { fmtShort } from "./server-contract.ts";
import { localHiddenSessions } from "./local-sources.ts";
import { filterQAs, loadQAs, loadSessions } from "./store.ts";
import type { QA } from "./types.ts";

/** 历史来源：orbita（新默认）= 只用 /import 与 /ingest 存进来的 QA；proma = 旧版读 data/qa.jsonl */
export function historySource(): "orbita" | "proma" {
  return process.env.INTENT_LAB_SOURCE === "proma" ? "proma" : "orbita";
}

/** orbita 源需要的两堆行（服务端传 state() 里的；脚本传磁盘上直接读的） */
export interface OrbitaRows {
  importRows: OrbitaQaRow[];
  orbitaRows: OrbitaQaRow[];
}

/** 从磁盘读 orbita 源的两堆行（预热脚本用；服务端走自己的懒加载单例） */
export function loadOrbitaRows(): OrbitaRows {
  return { importRows: loadImportedQAs(), orbitaRows: loadOrbitaQAs() };
}

export interface VisibleQAsOpts {
  /** 时间截断：只取 tsAbs 严格早于此刻的 QA（服务端 asOf 用；预热不带 = 全量） */
  asOf?: number;
  /** 本会话的存档 QA 不进候选（服务端用；预热不带） */
  sessionId?: string;
  /** 只取前 N 条（服务端 INTENT_LAB_SAMPLE 冒烟用；预热不带 = 全量） */
  sample?: number;
  /** v6 作废记录（不传 = 从磁盘现读；服务端传自己懒加载单例里的） */
  invalidated?: InvalidatedRow[];
}

/** 可见范围：与 server.ts /recall 的口径完全一致（来源选择、去重合并、屏蔽、截止、作废都在这里） */
export async function visibleQAs(opts: VisibleQAsOpts = {}, rows?: OrbitaRows): Promise<{ qas: QA[]; note: string }> {
  const { asOf, sessionId } = opts;
  const sample = opts.sample ?? 0;
  const counts = invalidatedQaCounts(opts.invalidated ?? loadInvalidated());
  if (historySource() === "orbita") {
    if (!rows) throw new Error("orbita 源需要传 importRows / orbitaRows");
    const merged = mergeOrbitaQAs(rows.importRows, rows.orbitaRows);
    const visibleAfterInvalidation = dropInvalidated(merged, counts);
    const invalidatedCount = merged.length - visibleAfterInvalidation.length;
    let filtered: QA[] = visibleAfterInvalidation;
    if (asOf != null) filtered = visibleAfterInvalidation.filter((qa) => qa.tsAbs < asOf);
    const localHidden = localHiddenSessions(); // 本机来源（Claude Code / Codex）的暂停、项目 / 会话排除
    filtered = filtered.filter(
      // 本会话自己的存档 QA 不进 S3 候选：它们已经在 recent（对话历史）里
      (qa) => !(sessionId != null && qa.sessionId === sessionId) && !localHidden(qa.sessionId),
    );
    const qas = sample != null && sample > 0 ? filtered.slice(0, sample) : filtered;
    const note = `orbita 源：${qas.length} 条 QA（import ${rows.importRows.length} + ingest ${rows.orbitaRows.length} 去重）${asOf != null ? `，截止 ${fmtShort(asOf)}` : ""}${invalidatedCount > 0 ? `，作废 ${invalidatedCount}` : ""}${sample > 0 ? `，INTENT_LAB_SAMPLE=${sample}` : ""}${sessionId ? "，不含本会话存档" : ""}`;
    return { qas, note };
  }
  // proma 源：读 qa.jsonl + Orbita 存档，再把 /import 送进来的历史并入（2026-10-07：开发版从
  // Orbita 正式版导入的会话正是用户近期最需要召回的，proma 源不该看不见它们）。合并去重与
  // /import 同一套：qaId 先到先得（跨源重复优先保留 qa.jsonl 那份——边、表态、指代说明都挂在它上面），
  // 内容键 v2（只看原文内容不看时间，2026-10-08）撞上 qa.jsonl / qa-orbita 已有行的 import 行不进
  // ——同一句话不召回两次。屏蔽 + 截止 + 作废 + 本会话排除照旧
  const cfg = loadConfig();
  const all = await loadQAs({ orbita: true });
  const importRows = rows?.importRows ?? loadImportedQAs();
  const merged = mergeImportedQAs(all, importRows);
  const localHidden = localHiddenSessions();
  const filtered = dropInvalidated(
    filterQAs(merged, { before: asOf, excludeSessions: cfg.excludeSessions }).filter(
      (qa) => !(sessionId != null && qa.qaId.startsWith("orbita:") && qa.sessionId === sessionId) && !localHidden(qa.sessionId),
    ),
    counts,
  );
  const qas = sample != null && sample > 0 ? filtered.slice(0, sample) : filtered;
  const note = `${qas.length} 条 QA（并入 import ${importRows.length} 行）${asOf != null ? `，截止 ${fmtShort(asOf)}` : ""}，屏蔽 ${cfg.excludeSessions.length} 个会话${sample > 0 ? `，INTENT_LAB_SAMPLE=${sample}` : ""}${sessionId ? "，不含本会话存档" : ""}`;
  return { qas, note };
}

/** 标题函数：与 server.ts /recall 的 titleOfNow 同一口径。
 *  orbita 源用行里带的 title（同会话多行取最后一行）；proma 源用 sessions.jsonl，orbita 行兜底。 */
export async function titleOfSource(rows?: OrbitaRows): Promise<(sid: string) => string> {
  if (historySource() === "orbita") {
    if (!rows) throw new Error("orbita 源需要传 importRows / orbitaRows");
    const titles = new Map<string, string>();
    for (const row of mergeOrbitaQAs(rows.importRows, rows.orbitaRows)) titles.set(row.sessionId, row.title);
    return (sid: string) => titles.get(sid) ?? "";
  }
  const sessions = new Map((await loadSessions()).map((x) => [x.sessionId, x.title]));
  const orbitaTitles = new Map<string, string>();
  for (const row of rows?.orbitaRows ?? loadOrbitaQAs()) orbitaTitles.set(row.sessionId, row.title); // 后写覆盖
  // /import 送进来的会话标题（proma 的 sessions.jsonl 里没有它们；行里自带）
  const importTitles = new Map<string, string>();
  for (const row of rows?.importRows ?? loadImportedQAs()) importTitles.set(row.sessionId, row.title);
  return (sid: string) => sessions.get(sid) ?? importTitles.get(sid) ?? orbitaTitles.get(sid) ?? "";
}
