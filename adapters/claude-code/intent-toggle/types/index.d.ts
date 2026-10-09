export type Verdict = 'yes' | 'no' | null

export type Ask = {
  askId: string
  qaId: string
  slot: string
  statement: string
  when: string
  title: string
  quote: string
  verdict: Verdict
  edited: string | null
  editing: boolean
}

export type Selected = { when: string; title: string; slots: string; human: string; connection: string }

export type StageStatus = 'pending' | 'running' | 'done' | 'error'

export type Run = {
  text: string
  forced: boolean
  sessionId: string
  turnId: string
  startedAt: number
  now: number
  /** 最近一次收到召回事件（含心跳）的时刻：看门狗按它判断连接断了没有 */
  lastEventAt: number
  runId: string | null
  phase: 'prewarm' | 'sync' | 'running' | 'confirm' | 'finishing' | 'error'
  synced: string | null
  qaTotal: number | null
  budgetMs: number | null
  stages: { gate: StageStatus; s1: StageStatus; s3: StageStatus; s4: StageStatus }
  step: 1 | 2 | null
  progress: { done: number; total: number; passed: number; etaMs: number | null } | null
  step1: { total: number; passed: number } | null
  step2: { total: number; passed: number } | null
  s4: { done: number; chars: number } | null
  scene: string | null
  want: string | null
  dedup: { before: number; after: number } | null
  summary: string | null
  missing: string | null
  selected: Selected[]
  selectedCount: number | null
  asks: Ask[]
  askRemaining: number
  injection: string
  edgesWritten: number | null
  contextAdded: number | null
  error: { stage: string; message: string; retryable: boolean } | null
  skipAll: boolean
}

export type Final = {
  kind: 'done' | 'skipped' | 'cancelled' | 'error'
  text: string
  forced: boolean
  totalMs: number
  qaTotal: number | null
  gateWhy: string
  scene: string | null
  want: string | null
  summary: string | null
  selected: Selected[]
  selectedCount: number
  asks: Ask[]
  note: string
  answeredWithoutConfirm: boolean
  error: string | null
}

export type SourceView = {
  id: 'claude' | 'codex'
  consent: 'unasked' | 'yes' | 'no'
  enabled: boolean
  sessions: number
  rowsFound: number
  rowsStored: number
  rowsActive: number
  lastSyncAt: number | null
  job: { phase: string; mode: string; filesDone: number; filesTotal: number; rowsSent: number; rowsTotal: number; imported: number; duplicates: number; error: string | null } | null
}

export type Conn = { ok: boolean; reachable: boolean; error: string | null; qaVisible: number; contract: number | null; model: string }

export type Prewarm = {
  available: boolean
  phase: string
  done: number
  total: number
  coverage: { segs: number; warmed: number }
  etaMs: number | null
}

export type IntentMode = {
  sessionOn: boolean
  forceNext: boolean
  /** 服务端存的「新会话默认」（按钮条上可改） */
  defaultOn: boolean
  /** 本会话的强制分析来自「下一个新会话第一句强制」偏好：用掉时要回写清掉 */
  firstForceFromPrefs: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'intent-toggle': { mode: IntentMode; run: Run | null; last: Final | null; conn: Conn | null; sources: SourceView[]; prewarm: Prewarm | null }
  }
}
