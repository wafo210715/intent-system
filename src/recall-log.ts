/**
 * 召回记录（2026-10-10，管理页「召回记录」用）：旁听 /recall 发出的事件，每次召回结束
 * （done / error）往 data/local-sources/recalls.jsonl 追加一行摘要。只追加；不影响事件流本身。
 * data/runs 目录不记 runId / sessionId、门卫跳过时也不全，所以另记一份给人看的。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecallEvent } from "./server-contract.ts";
import { dataDir } from "./store.ts";

export interface RecallLogRow {
  runId: string;
  ts: number;
  sessionId: string;
  turnId: string;
  q: string;
  forced: boolean;
  status: "done" | "skipped" | "error" | "cancelled";
  qaTotal: number | null;
  gateWhy: string | null;
  scene: string | null;
  want: string | null;
  summary: string | null;
  missing: string | null;
  selected: Array<{ qaId: string; when: string; title: string; slots: string[]; score?: number; human?: string; connection?: string }>;
  ask: Array<{ askId: string; qaId: string; slot: string; statement: string; when: string; title: string; quote?: string }>;
  stages: Record<string, number>;
  totalMs: number;
  error: { stage: string; message: string } | null;
}

export const recallLogPath = (dir = dataDir()): string => join(dir, "local-sources", "recalls.jsonl");

const pending = new Map<string, RecallLogRow>();

/** 每发一个事件调一次（server.ts 的 send 里） */
export function observeRecallEvent(runId: string, req: { sessionId: string; turnId: string; q: string; force?: boolean }, e: RecallEvent): void {
  let row = pending.get(runId);
  if (!row) {
    row = {
      runId, ts: Date.now(), sessionId: req.sessionId, turnId: req.turnId, q: req.q, forced: req.force === true,
      status: "done", qaTotal: null, gateWhy: null, scene: null, want: null, summary: null, missing: null,
      selected: [], ask: [], stages: {}, totalMs: 0, error: null,
    };
    pending.set(runId, row);
  }
  const ev = e as Record<string, any>;
  switch (e.type) {
    case "accepted":
      row.qaTotal = ev.qaTotal;
      row.ts = ev.startedAt ?? row.ts;
      break;
    case "stage":
      if (ev.status === "done" && typeof ev.ms === "number") row.stages[ev.stage] = (row.stages[ev.stage] ?? 0) + ev.ms;
      break;
    case "gate":
      row.gateWhy = ev.why;
      break;
    case "intent":
      row.scene = ev.scene;
      row.want = ev.want;
      break;
    case "review":
      row.summary = ev.summary;
      row.missing = ev.missing ?? null;
      row.selected = (ev.selected ?? []).map((s: any) => ({
        qaId: s.qaId, when: s.when, title: s.title, slots: s.slots, score: s.score, human: s.human, connection: s.connection,
      }));
      row.ask = (ev.ask ?? []).map((a: any) => ({ askId: a.askId, qaId: a.qaId, slot: a.slot, statement: a.statement, when: a.when, title: a.title, quote: a.quote }));
      break;
    case "done":
      row.status = ev.skipped === "gate" ? "skipped" : "done";
      row.totalMs = ev.timing?.totalMs ?? Date.now() - row.ts;
      finish(runId, row);
      break;
    case "error":
      row.status = /取消|cancel|abort/i.test(String(ev.message)) || ev.stage === "cancelled" ? "cancelled" : "error";
      row.error = { stage: String(ev.stage ?? ""), message: String(ev.message ?? "") };
      row.totalMs = Date.now() - row.ts;
      finish(runId, row);
      break;
    default:
      break;
  }
}

function finish(runId: string, row: RecallLogRow): void {
  pending.delete(runId);
  try {
    const p = recallLogPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(row) + "\n");
  } catch {
    // 记录失败不影响召回
  }
}

/** 最近的 N 条，新的在前 */
export function loadRecallLog(limit = 100, dir = dataDir()): RecallLogRow[] {
  const p = recallLogPath(dir);
  if (!existsSync(p)) return [];
  const out: RecallLogRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as RecallLogRow);
    } catch {
      // 坏行跳过
    }
  }
  return out.reverse().slice(0, limit);
}
