/**
 * 等表态的 run 落盘（09-29 用户：「那一轮取回的很好，都表态了，结果 expire」）。
 *
 * /recall 的 done 带 needsFeedback=true 时，用户看确认卡可能要很久；这期间服务重启（改代码、崩溃）
 * 会清掉内存里的 run，/feedback 404，表态全丢、整轮重跑。现在把 /feedback 需要的状态写进
 * data/pending-runs/<runId>.json，内存里找不到时从这里恢复；qaById / titleOf 由调用方按当前数据重建。
 * 表态成功后删掉；超过 24 小时（与内存 TTL 一致）清掉；/reset 一并清。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskQueueItem } from "./asks-queue.ts";
import type { Review } from "./review.ts";
import { dataDir } from "./store.ts";

export const PENDING_RUN_TTL_MS = 24 * 3_600_000;

export interface PersistedRun {
  runId: string;
  sessionId: string;
  turnId: string;
  q: string;
  review: Review;
  askItems: Array<[string, AskQueueItem]>;
  injectedBefore: string[];
  createdAt: number;
  contextQuestion: number;
  /** 这一问的断点目录：表态成功后才删（确认失败时重试只重跑 S4） */
  checkpointDir?: string;
}

export function pendingRunsDir(dir = dataDir()): string {
  return join(dir, "pending-runs");
}

const fileOf = (runId: string, dir: string): string => join(pendingRunsDir(dir), `${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

export function savePendingRun(run: PersistedRun, dir = dataDir()): void {
  mkdirSync(pendingRunsDir(dir), { recursive: true });
  writeFileSync(fileOf(run.runId, dir), JSON.stringify(run));
}

/** 读回；不存在、坏文件或超过 TTL 都返回 null */
export function loadPendingRun(runId: string, dir = dataDir(), now = Date.now()): PersistedRun | null {
  const p = fileOf(runId, dir);
  if (!existsSync(p)) return null;
  try {
    const run = JSON.parse(readFileSync(p, "utf8")) as PersistedRun;
    if (now - run.createdAt > PENDING_RUN_TTL_MS) return null;
    return run;
  } catch {
    return null;
  }
}

export function deletePendingRun(runId: string, dir = dataDir()): void {
  rmSync(fileOf(runId, dir), { force: true });
}

/** v6 /invalidate 用：删掉该会话被回退轮次的等表态 run（按落盘的 sessionId + turnId 匹配）。返回删掉的个数。 */
export function deletePendingRunsFor(sessionId: string, turnIds: ReadonlySet<string>, dir = dataDir()): number {
  const root = pendingRunsDir(dir);
  if (!existsSync(root) || turnIds.size === 0) return 0;
  let removed = 0;
  for (const f of readdirSync(root)) {
    const p = join(root, f);
    try {
      const run = JSON.parse(readFileSync(p, "utf8")) as PersistedRun;
      if (run.sessionId === sessionId && typeof run.turnId === "string" && turnIds.has(run.turnId)) {
        rmSync(p, { force: true });
        removed++;
      }
    } catch {
      // 坏文件 / 并发删除：跳过
    }
  }
  return removed;
}

export function prunePendingRuns(dir = dataDir(), now = Date.now()): number {
  const root = pendingRunsDir(dir);
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const f of readdirSync(root)) {
    const p = join(root, f);
    try {
      if (now - statSync(p).mtimeMs > PENDING_RUN_TTL_MS) {
        rmSync(p, { force: true });
        removed++;
      }
    } catch {
      // 并发删除：跳过
    }
  }
  return removed;
}

export function clearAllPendingRuns(dir = dataDir()): void {
  rmSync(pendingRunsDir(dir), { recursive: true, force: true });
}
