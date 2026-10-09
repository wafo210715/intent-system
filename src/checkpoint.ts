/**
 * recall 断点续传（09-29 用户定：「scoring 花了那么多 token，被卡掉不能从头来」）。
 *
 * 同一问（sessionId + turnId + q）失败后重试——Orbita 的「重试」发的就是同一组值——复用上次已完成的：
 * - S1 意图（意图不变，S3 的分数才可复用；主模型开思考、同 prompt 两次读法可能不同）
 * - S3 第一步每 (qaId, 段) 的六岗分数
 * - S3 第二步每 (qaId, 段, 过线岗) 的理由原文
 * 只补没做完的。失败（budget / 出错 / 取消）留着给下次重试；成功后由服务层删：不用表态的轮立即删，
 * 要表态的轮留到 /feedback 成功（确认这一步失败时，重试只重跑 S4）。
 *
 * 键里带 S1/S3 模型名与提示词摘要：换模型或改提示词后旧分数自动作废。
 * 存储：data/checkpoints/<key>/{intent.json, scores.jsonl, reasons.jsonl}，只追加；超过 24 小时的整目录清掉。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntentObject } from "./types.ts";
import { dataDir } from "./store.ts";

export const CHECKPOINT_TTL_MS = 24 * 3600_000;

export interface RecallCheckpoint {
  readonly dir: string;
  /** 上次的 S1 意图；没有 = 这一问第一次跑 */
  readonly intent: IntentObject | null;
  /** 键 scoreKey(qaId, segIndex) */
  readonly scores: Map<string, Array<number | null>>;
  /** 键 reasonKey(qaId, segIndex, slots) → 模型返回的 JSON（res.data） */
  readonly reasons: Map<string, unknown>;
  saveIntent(intent: IntentObject): void;
  saveScore(key: string, scores: Array<number | null>): void;
  saveReason(key: string, data: unknown): void;
  /** 整轮成功后删掉 */
  clear(): void;
}

/** 段分的变体（合并 10-06 / 10-08）：old = 旧流程第一步；reorder = 新顺序第一步（qa-first，读分不变）；b = B 方案（不带收尾指令）；ask = B 方案海选（两段打分，带 SCORE_ASK）；rescore = 复试（旧顺序）。
 *  同一段在不同变体下的消息不同、分数也不同，键带前缀互不串线 */
export type ScoreVariant = "old" | "reorder" | "b" | "ask" | "rescore";

export const scoreKey = (variant: ScoreVariant, qaId: string, segIndex: number): string => `${variant}#${qaId}#${segIndex}`;
/** 理由的变体：old = 旧流程（一位小数、不补占位符）；b = B 方案（两位小数 + reasonPad） */
export const reasonKey = (variant: "old" | "b", qaId: string, segIndex: number, slots: Array<{ slot: number; score: number }>): string =>
  `${variant}#${qaId}#${segIndex}#${slots.map((s) => `${s.slot}:${s.score}`).join(",")}`;

export function checkpointRoot(dir = dataDir()): string {
  return join(dir, "checkpoints");
}

/** 键里带 S1/S3 模型名、提示词摘要与 B 方案口径（合并 10-06 补）：换模型、改提示词、改 SCORE_ASK /
 *  twoStage 的 screen / aClip、块大小或 pads，旧分数都自动作废。每岗阈值只影响过线不影响分数，不进键。
 *  bScope 由服务层算好传进来（见 server.ts）：SCORE_ASK + twoStage 参数 + blockSize + 本次可见 QA 每段的 pads 摘要。 */
export function checkpointId(parts: { sessionId: string; turnId: string; q: string; mainModel: string; swarmModel: string; promptDigest: string; bScope?: string }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.sessionId, parts.turnId, parts.q, parts.mainModel, parts.swarmModel, parts.promptDigest, parts.bScope ?? ""]))
    .digest("hex")
    .slice(0, 24);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 进程被杀时最后一行可能是半截：丢掉，那一条下次重做
    }
  }
  return out;
}

export function openCheckpoint(id: string, root = checkpointRoot(), meta?: { sessionId: string; turnId: string }): RecallCheckpoint {
  const dir = join(root, id);
  const intentPath = join(dir, "intent.json");
  const scoresPath = join(dir, "scores.jsonl");
  const reasonsPath = join(dir, "reasons.jsonl");
  const metaPath = join(dir, "meta.json");
  let intent: IntentObject | null = null;
  if (existsSync(intentPath)) {
    try {
      intent = JSON.parse(readFileSync(intentPath, "utf8")) as IntentObject;
    } catch {
      intent = null;
    }
  }
  const scores = new Map<string, Array<number | null>>();
  for (const r of readJsonl(scoresPath)) if (typeof r.k === "string" && Array.isArray(r.s)) scores.set(r.k, r.s as Array<number | null>);
  const reasons = new Map<string, unknown>();
  for (const r of readJsonl(reasonsPath)) if (typeof r.k === "string" && "d" in r) reasons.set(r.k, r.d);
  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true });
    // v6：作废（/invalidate）要能按 (sessionId, turnId) 找到对应断点——目录名是哈希，
    // 反解不了，落盘时把来源写进 meta.json（v6 之前的旧断点没有它，只能等 24h TTL 清）
    if (meta !== undefined && !existsSync(metaPath)) writeFileSync(metaPath, JSON.stringify(meta));
  };
  return {
    dir,
    intent,
    scores,
    reasons,
    saveIntent(i) {
      ensureDir();
      writeFileSync(intentPath, JSON.stringify(i));
    },
    saveScore(k, s) {
      ensureDir();
      appendFileSync(scoresPath, JSON.stringify({ k, s }) + "\n");
    },
    saveReason(k, d) {
      ensureDir();
      appendFileSync(reasonsPath, JSON.stringify({ k, d }) + "\n");
    },
    clear() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 清掉超过 ttl 没动过的断点（按目录内最新文件的 mtime） */
export function pruneCheckpoints(root = checkpointRoot(), ttlMs = CHECKPOINT_TTL_MS, now = Date.now()): number {
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      const files = readdirSync(dir).map((f) => statSync(join(dir, f)).mtimeMs);
      const latest = Math.max(statSync(dir).mtimeMs, ...files);
      if (now - latest > ttlMs) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // 并发删除等：跳过
    }
  }
  return removed;
}

export function clearAllCheckpoints(root = checkpointRoot()): void {
  rmSync(root, { recursive: true, force: true });
}

/** v6 /invalidate 用：按 (sessionId, turnIds) 删对应断点（meta.json 匹配；没有 meta 的旧断点跳过）。
 *  返回删掉的目录数。 */
export function clearCheckpointsFor(sessionId: string, turnIds: ReadonlySet<string>, root = checkpointRoot()): number {
  if (!existsSync(root) || turnIds.size === 0) return 0;
  let removed = 0;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      const metaPath = join(dir, "meta.json");
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { sessionId?: unknown; turnId?: unknown };
      if (meta.sessionId === sessionId && typeof meta.turnId === "string" && turnIds.has(meta.turnId)) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // 坏 meta / 并发删除：跳过
    }
  }
  return removed;
}

/** 内存断点仓（hosted 召回核心用，10-10）：断点里的理由摘句是 QA 原文节选，承诺「不落服务端盘」→
 *  只存进程内存。代价：核心重启即丢，重试从头跑（可接受，见设计 §2/§3）。每个用户一份、各带 TTL 与条数上限。 */
export interface RamCheckpointStore {
  get(id: string): RecallCheckpoint;
  size(): number;
  /** 清掃超时与超量的断点（每次 get 顺手做） */
  sweep(now?: number): void;
}

export function openRamCheckpointStore(ttlMs = CHECKPOINT_TTL_MS, maxEntries = 32): RamCheckpointStore {
  const entries = new Map<string, { cp: RecallCheckpoint; at: number }>();
  const store: RamCheckpointStore = {
    get(id: string): RecallCheckpoint {
      store.sweep();
      const hit = entries.get(id);
      if (hit) {
        hit.at = Date.now();
        return hit.cp;
      }
      const box = {
        intent: null as IntentObject | null,
        scores: new Map<string, Array<number | null>>(),
        reasons: new Map<string, unknown>(),
      };
      const cp: RecallCheckpoint = {
        dir: `ram:${id}`,
        get intent() { return box.intent; },
        get scores() { return box.scores; },
        get reasons() { return box.reasons; },
        saveIntent(i) {
          box.intent = i;
        },
        saveScore(k, s) {
          box.scores.set(k, s);
        },
        saveReason(k, d) {
          box.reasons.set(k, d);
        },
        clear() {
          entries.delete(id);
          box.intent = null;
          box.scores.clear();
          box.reasons.clear();
        },
      };
      entries.set(id, { cp, at: Date.now() });
      return cp;
    },
    size(): number {
      return entries.size;
    },
    sweep(now = Date.now()): void {
      for (const [id, e] of entries) if (now - e.at > ttlMs) entries.delete(id);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string); // 最旧的先丢
    },
  };
  return store;
}
