/**
 * 边表：用户在确认卡上的表态（/feedback 写入），是 S3/S4 的最小消费依据。
 *
 * 一行 = 用户对一条 (qaId, 岗) 的表态；只追加，后写的行覆盖先写的（同一键取最新）。
 * 消费规则（不改提示词）：
 *   - verdict=no 的 (qaId, slot)：S3 解析后直接丢掉该报名，不进 S4；
 *   - 已有表态（yes / no / 有 edited）的 (qaId, slot)：S4 不再把它放进确认卡；
 *   - renderReports 给已表态的报名行尾标注，S4 审核时能看到。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfirmState } from "./review.ts";
import { dataDir } from "./store.ts";
import type { Bid } from "./types.ts";

export interface EdgeRow {
  ts: number;
  runId: string;
  sessionId: string;
  turnId: string;
  qaId: string;
  slot: number;
  /** /feedback 的表态（yes / no / skip）；v3.2 §六回写边为 null（只记录，不参与消费） */
  verdict: "yes" | "no" | "skip" | null;
  statement: string;
  edited?: string;
  note?: string;
  /** v3.2 §六：done 时回写的六岗边标 "s3"（带该岗分数）；/feedback 的表态边不带 */
  source?: "s3";
  /** source="s3" 时该岗的 S3 分数 */
  score?: number;
}

export function edgesPath(dir = dataDir()): string {
  return join(dir, "edges.jsonl");
}

export function loadEdges(dir = dataDir()): EdgeRow[] {
  const p = edgesPath(dir);
  if (!existsSync(p)) return [];
  const out: EdgeRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as EdgeRow);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** 同一 (qaId, slot) 有多次表态时，后写的覆盖先写的（带 statement，渲染否认行用）；
 *  v3.2 §六回写边（verdict=null）只作记录，不进消费——表态优先，不被后写的 null 覆盖 */
export function edgeVerdicts(rows: EdgeRow[]): Map<string, ConfirmState> {
  const map = new Map<string, ConfirmState>();
  for (const r of rows) {
    if (r.verdict == null) continue;
    map.set(`${r.qaId}#${r.slot}`, { verdict: r.verdict, edited: r.edited, statement: r.statement });
  }
  return map;
}

export function appendEdge(row: EdgeRow, dir = dataDir()): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(edgesPath(dir), JSON.stringify(row) + "\n");
}

/** S3 解析后丢掉用户否认过的 (qaId, slot) 报名 */
export function dropDeniedBids(bids: Bid[], verdicts: Map<string, ConfirmState>): { kept: Bid[]; dropped: number } {
  const kept: Bid[] = [];
  let dropped = 0;
  for (const b of bids) {
    if (verdicts.get(`${b.qaId}#${b.slot}`)?.verdict === "no") dropped++;
    else kept.push(b);
  }
  return { kept, dropped };
}
