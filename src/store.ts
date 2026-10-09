/**
 * 三份只追加的 JSONL（QA 表 / 边表 / 簇表）+ 会话元数据表。
 *
 * 不用数据库：几千条 QA 全量读进内存毫无压力，文件也方便整目录拷给别人。
 * 写入一律"临时文件 + rename"，中途崩溃不会留下半截文件。
 *
 * P0 只写 qa.jsonl 与 sessions.jsonl；edges.jsonl / clusters.jsonl 建空文件占位，S3/S7 再写。
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadOrbitaQAs } from "./orbita-store.ts";
import type { QA, SessionMeta } from "./types.ts";

export function dataDir(): string {
  return resolve(process.env.INTENT_LAB_DATA ?? join(import.meta.dir, "..", "data"));
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function toJsonl<T>(items: T[]): string {
  return items.map((x) => JSON.stringify(x)).join("\n") + (items.length ? "\n" : "");
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const text = await Bun.file(path).text();
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** S0 入库是确定性的（同一份原始数据永远得到同一份 QA 表），所以整表重建而非追加 */
export function writeCorpus(qas: QA[], sessions: SessionMeta[], dir = dataDir()): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "qa.jsonl"), toJsonl(qas));
  writeAtomic(join(dir, "sessions.jsonl"), toJsonl(sessions));
  for (const f of ["edges.jsonl", "clusters.jsonl"]) {
    const p = join(dir, f);
    if (!existsSync(p)) writeFileSync(p, "");
  }
}

export async function loadSessions(dir = dataDir()): Promise<SessionMeta[]> {
  return readJsonl<SessionMeta>(join(dir, "sessions.jsonl"));
}

export interface LoadOptions {
  /** 时间截断：只要 tsAbs 严格早于此时刻的 QA（体验实验防泄露） */
  before?: number;
  /** 屏蔽的会话（体验实验里被"删掉"的原会话） */
  excludeSessions?: Iterable<string>;
  /** 只要权重 ≥ 该值的 QA；默认 >0，即只要进意图库的 */
  minWeight?: number;
  /** 是否合并 qa-orbita.jsonl（/ingest 写入的 Orbita 问答）。默认不合并：
   *  命令行离线实验的语料要固定、可复现，只有服务端（或 --with-orbita）才带上 */
  orbita?: boolean;
}

export async function loadQAs(opts: LoadOptions = {}, dir = dataDir()): Promise<QA[]> {
  const all = await readJsonl<QA>(join(dir, "qa.jsonl"));
  // 合并时按时间重排；重新 ingest（Proma 入库）不碰 qa-orbita.jsonl
  const merged = opts.orbita ? [...all, ...loadOrbitaQAs(dir)].sort((a, b) => a.tsAbs - b.tsAbs || a.qaId.localeCompare(b.qaId)) : all;
  return filterQAs(merged, opts);
}

export function filterQAs(all: QA[], opts: LoadOptions = {}): QA[] {
  const exclude = new Set(opts.excludeSessions ?? []);
  const minWeight = opts.minWeight ?? Number.MIN_VALUE;
  return all.filter(
    (qa) =>
      qa.intentWeight >= minWeight &&
      !exclude.has(qa.sessionId) &&
      (opts.before === undefined || qa.tsAbs < opts.before),
  );
}
