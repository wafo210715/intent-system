/**
 * QA 原文的切段规则（与打分管线同一套；搬到这里供客户端算覆盖率复用，2026-10-11）。
 *  Q 超 15,000 字切段、段间重叠 200 字。
 */
export const SEGMENT_CHARS = 15_000;
/** 段间重叠：答案被切在边界上时，相邻段里至少有一段能完整看到它 */
export const SEGMENT_OVERLAP = 200;

/** 历史 Q 全文放不下时切段；不超长就原样一段 */
export function segmentQText(qText: string, segChars = SEGMENT_CHARS, overlap = SEGMENT_OVERLAP): string[] {
  if (qText.length <= segChars) return [qText];
  const step = segChars - overlap;
  const out: string[] = [];
  for (let i = 0; i < qText.length; i += step) {
    out.push(qText.slice(i, i + segChars));
    if (i + segChars >= qText.length) break;
  }
  return out;
}

import type { QA } from "./types.ts";

/** 预热覆盖（10-10 hosted，编排在服务端）：核心只回 pads 键集（k + 上次预热是否成功，无原文），
 *  段数本地算——与 padCoverage 同一口径，只是数据源从本地文件换成了远端键集 */
export function padCoverageFromKeys(entries: Record<string, { k: number; warmed: boolean }>, qas: QA[]): { segs: number; warmed: number } {
  let segs = 0, warmed = 0;
  for (const qa of qas) {
    const n = segmentQText(qa.qText).length;
    segs += n;
    for (let i = 0; i < n; i++) {
      if (entries[`${qa.qaId}#${i}`]?.warmed) warmed++;
    }
  }
  return { segs, warmed };
}
