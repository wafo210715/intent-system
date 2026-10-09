/**
 * 作废记录（契约 v6，2026-10-08）：Orbita 会话回退成功后，把被回退的轮次 POST /invalidate
 * 告诉 intent-lab。软删——QA 行不物理删（存储全只追加），只记一条作废记录；
 * S3 候选、S4 摘句、/health qaVisible、预热都跳过被作废的；上下文文件里那一问的小节
 * 重生成时去掉；对应的断点 / 等表态 run / 待问队列项一并清掉。
 *
 * 匹配单位是 qaId（= orbita:sessionId:turnId）。同一条消息回退后**重新发一遍**会被
 * Orbita 重新 /ingest（同 turnId 时 qaId 相同、tsAbs 更新）——所以不作废「qaId 的全部行」，
 * 而是按出现次数消费：qaId 被作废 n 次，就藏掉按时间序的**前 n 条**同 qaId 行，
 * 重新入库的新行排在后面，照常可见。作废记录也不挡重入库：/ingest 与 /import 的
 * 去重索引都排除被藏掉的行，同一句话回来时能正常入库。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orbitaQaId, orbitaDir } from "./orbita-store.ts";
import { dataDir } from "./store.ts";

/** data/orbita/invalidated.jsonl 的一行（只追加） */
export interface InvalidatedRow {
  ts: number;
  sessionId: string;
  turnId: string;
  qaId: string;
  /** 谁发起的：orbita-revert（会话回退）；content-updated（2026-10-09：同 turnId 内容变了，/import /ingest 的内容更新）；hidden-as-duplicate（2026-10-09 晚：更新的新内容与别的行同内容，旧行作废不追加）；一次性脚本会带自己的标记（dedupe-cleanup-*） */
  reason?: string;
}

export function invalidatedPath(dir = dataDir()): string {
  return join(orbitaDir(dir), "invalidated.jsonl");
}

export function loadInvalidated(dir = dataDir()): InvalidatedRow[] {
  const p = invalidatedPath(dir);
  if (!existsSync(p)) return [];
  const out: InvalidatedRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as InvalidatedRow;
      if (typeof r.sessionId === "string" && typeof r.turnId === "string") {
        out.push({ ...r, qaId: r.qaId || orbitaQaId(r.sessionId, r.turnId) });
      }
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

export function appendInvalidated(rows: InvalidatedRow[], dir = dataDir()): void {
  if (!rows.length) return;
  const p = invalidatedPath(dir);
  mkdirSync(join(p, ".."), { recursive: true });
  appendFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export const invalidateKey = (sessionId: string, turnId: string): string => `${sessionId}\u0000${turnId}`;

/** 已作废的 (sessionId, turnId) 集合（幂等判重用） */
export function invalidatedPairs(rows: readonly InvalidatedRow[]): Set<string> {
  return new Set(rows.map((r) => invalidateKey(r.sessionId, r.turnId)));
}

/** qaId → 作废次数（作废 n 次就藏掉前 n 条同 qaId 的行） */
export function invalidatedQaCounts(rows: readonly InvalidatedRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.qaId, (counts.get(r.qaId) ?? 0) + 1);
  return counts;
}

/** 按出现次数消费：qaId 被作废 n 次 → 数组里该 qaId 的前 n 次出现被藏掉（数组序 = 时间序）。 */
export function dropInvalidated<T extends { qaId: string }>(qas: readonly T[], counts: Map<string, number>): T[] {
  if (counts.size === 0) return [...qas];
  const seen = new Map<string, number>();
  return qas.filter((qa) => {
    const c = counts.get(qa.qaId) ?? 0;
    if (c === 0) return true;
    const i = seen.get(qa.qaId) ?? 0;
    seen.set(qa.qaId, i + 1);
    return i >= c;
  });
}
