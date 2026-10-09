/**
 * 待问队列（契约 v3.2 §三）：每 sessionId 一个待问列表，data/asks-queue.json 一个文件。
 * 守门员每轮只问 ≤5 条（队列里的优先），没问完的存回来，下次同会话 recall 先问剩下的再补新的。
 * 重写式存储（队列要增删，不是只追加）；写入走临时文件 + rename，中途崩溃不留半截。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store.ts";

export interface AskQueueItem {
  qaId: string;
  slot: number;
  statement: string;
  whyUncertain: string;
  /** 该 QA 在该岗报名时的原文摘句（渲染确认卡的 quote 用；队列项不一定在本轮 bids 里） */
  quote: string;
}

export function askQueuePath(dir = dataDir()): string {
  return join(dir, "asks-queue.json");
}

export function loadAskQueue(dir = dataDir()): Record<string, AskQueueItem[]> {
  const p = askQueuePath(dir);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const out: Record<string, AskQueueItem[]> = {};
    for (const [sid, items] of Object.entries(raw)) {
      if (!Array.isArray(items)) continue;
      out[sid] = items.filter(
        (x): x is AskQueueItem =>
          !!x && typeof x === "object" && typeof (x as AskQueueItem).qaId === "string" && typeof (x as AskQueueItem).slot === "number",
      );
    }
    return out;
  } catch {
    return {}; // 坏文件按空队列处理
  }
}

export function saveAskQueue(map: Record<string, AskQueueItem[]>, dir = dataDir()): void {
  const p = askQueuePath(dir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, p);
}

/** 清空整个队列文件（/reset 用） */
export function clearAskQueue(dir = dataDir()): void {
  const p = askQueuePath(dir);
  if (existsSync(p)) writeFileSync(p, "{}");
}
