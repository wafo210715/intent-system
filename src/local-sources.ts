/**
 * 本机来源（2026-10-10）：intent-lab 直接读这台电脑上 Claude Code 与 Codex 的会话文件，
 * 切成与 /import 同一形状的行（sessionId / turnId / title / q / a / ts），走 /import 的
 * 同一条入库路径（去重、内容更新、作废、预热全复用）。给不用 Orbita 的人（Claude Code /
 * Codex 用户）一条不经迁移的入库路。
 *
 * 切行口径与 Orbita 的 qaRowsFromTranscript 一致（契约原文）：一条「用户亲口说的话」开一轮，
 * q = 用户原话（剥系统注入），a = 这一轮助手最后一段非空文字（没有 = 空串，也送），
 * ts = 那条用户消息原来的时间。清洗规则移植自 Orbita 的 main/session/claude-code.ts 与
 * codex.ts；Codex 部分按本机真实 rollout 校准过（Orbita 那份写明「本机没有真实样本」）。
 *
 * sessionId 带来源前缀（`claude-<文件名>` / `codex-<会话 id>`）——qaId 因此是
 * `orbita:claude-…:<turnId>`，与 Orbita 送来的行互不相撞，按前缀就能分来源。
 *
 * 排除（项目 / 会话 / 整个来源暂停）不删数据，只在可见集里藏（history.visibleQAs 调
 * localHiddenSessions）——恢复即时生效、不用重新入库。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { dataDir } from "./store.ts";

export type LocalSourceId = "claude" | "codex";
/**
 * 不承载意图的轮次：切轮时照常当分隔，但不生成 QA。
 * - 操作指令（/compact 等）
 * - 上下文压缩后系统自动写进来的续接摘要（不是用户打的字）
 * 2026-10-11 从 qa-builder 搬来（local-sources 不该依赖 Proma 解析那一套）
 */
export function isControlCommand(qText: string): boolean {
  const t = qText.trim();
  return /^\/(compact|clear|model|cost|help|resume|stop)\b/.test(t) || t.startsWith("This session is being continued");
}

export const LOCAL_SOURCES: readonly LocalSourceId[] = ["claude", "codex"];

/** 与 /import 的一行同形 */
export interface LocalRow {
  sessionId: string;
  turnId: string;
  title: string;
  q: string;
  a: string;
  ts: number;
}

/** 会话是谁开的：只有 user 的进库（子 agent / 定时任务 / agent 自己开的线程不承载人的意图） */
export type SessionKind = "user" | "subagent" | "automation" | "agent";

export interface ParsedSession {
  source: LocalSourceId;
  sessionId: string;
  file: string;
  title: string;
  project: string | null;
  kind: SessionKind;
  rows: LocalRow[];
  firstTs: number;
  lastTs: number;
}

const clipTitle = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 30 ? `${one.slice(0, 30)}…` : one;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const optStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const tsOf = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

// ============================== Claude Code ==============================

/** Claude Code 以用户身份写进来、但不是用户写的文字（移植自 Orbita claude-code.ts） */
const CLAUDE_GENERATED = /^\s*(?:\[Request interrupted by user|<local-command-(?:stdout|stderr|caveat)>|<task-notification>|<cross-session-message[\s>])/;

/** 用户写的一段文字 → 原话；null = 不是用户写的 */
export function claudeUserText(text: string): string | null {
  if (CLAUDE_GENERATED.test(text)) return null;
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command !== null) {
    const name = (command[1] ?? "").trim();
    const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "").trim();
    const invocation = name.startsWith("/") ? name : `/${name}`;
    return args === "" ? invocation : `${invocation} ${args}`;
  }
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/@"([^"\n]+)"/g, "@$1")
    .trim();
}

function blocksOf(content: unknown): unknown[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}
function textOf(blocks: readonly unknown[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => isRecord(b) && b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b.text)
    .join("\n");
}

interface OpenTurn {
  line: number;
  turnId: string;
  q: string;
  ts: number;
  a: string;
}

/**
 * 一份 Claude Code 会话 JSONL → 行。
 * - isSidechain（Warmup 探针）、isMeta（注入）、工具结果、后台通知、压缩摘要、合成错误回复都不是对话；
 * - 排队消息（attachment queued_command，commandMode=prompt）是用户写的，照收；
 * - 回退重写：用户写的行接在更早的一行后面 → 那一行之后收的轮作废（旧枝）；
 * - 控制命令（/compact、/clear…）与 Claude 生成的文字不开轮。
 */
export function parseClaudeSession(raw: string, file: string): ParsedSession {
  const stem = basename(file, ".jsonl");
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let cwd: string | null = null;
  let turns: OpenTurn[] = [];
  let open: OpenTurn | null = null;
  const lineByUuid = new Map<string, number>();
  let lastUuid: string | null = null;
  let line = -1;

  const startTurn = (turnId: string, q: string, ts: number): void => {
    open = { line, turnId, q, ts, a: "" };
    turns.push(open);
  };

  for (const text of raw.split("\n")) {
    if (text.trim() === "") continue;
    line += 1;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const type = obj["type"];
    if (type === "custom-title") {
      customTitle = optStr(obj["customTitle"]) ?? customTitle;
      continue;
    }
    if (type === "ai-title") {
      aiTitle = optStr(obj["aiTitle"]) ?? aiTitle;
      continue;
    }
    if (obj["isSidechain"] === true) continue;
    const uuid = optStr(obj["uuid"]);
    const remember = (): void => {
      if (uuid === null) return;
      lineByUuid.set(uuid, line);
      lastUuid = uuid;
    };

    if (type === "attachment") {
      const att = isRecord(obj["attachment"]) ? obj["attachment"] : null;
      const prompt = att === null ? null : optStr(att["prompt"]);
      if (att?.["type"] === "queued_command" && att["commandMode"] === "prompt" && prompt !== null && uuid !== null) {
        const q = claudeUserText(prompt);
        if (q && !isControlCommand(q)) startTurn(uuid, q, tsOf(obj["timestamp"]));
      }
      remember();
      continue;
    }
    if (type !== "user" && type !== "assistant") {
      remember();
      continue;
    }
    if (obj["isCompactSummary"] === true || obj["isVisibleInTranscriptOnly"] === true || obj["isApiErrorMessage"] === true) {
      remember();
      continue;
    }
    cwd ??= optStr(obj["cwd"]);
    const message = isRecord(obj["message"]) ? obj["message"] : null;
    const blocks = blocksOf(message?.["content"]);

    if (type === "user") {
      const origin = isRecord(obj["origin"]) ? optStr(obj["origin"]["kind"]) : null;
      const human =
        obj["isMeta"] !== true &&
        obj["toolUseResult"] === undefined &&
        !blocks.some((b) => isRecord(b) && b["type"] === "tool_result") &&
        (origin === null || origin === "human");
      if (human) {
        // 回退：接在更早一行后面 → 那一行之后的轮作废
        const parent = obj["parentUuid"];
        if (typeof parent === "string" && parent !== lastUuid) {
          const at = lineByUuid.get(parent);
          if (at !== undefined) turns = turns.filter((t) => t.line <= at);
        }
        const q = claudeUserText(textOf(blocks));
        open = null; // 用户写的行关闭上一轮（即使它自己不成行）
        if (q && uuid !== null && !isControlCommand(q)) startTurn(uuid, q, tsOf(obj["timestamp"]));
      }
      remember();
      continue;
    }
    // assistant：每块一行；这一轮最后一段非空文字就是回答
    const t = textOf(blocks).trim();
    const cur = open as OpenTurn | null;
    if (t !== "" && cur !== null) cur.a = t;
    remember();
  }

  const sessionId = `claude-${stem}`;
  const firstQ = turns[0]?.q ?? "";
  const title = customTitle ?? aiTitle ?? (firstQ ? clipTitle(firstQ) : "(无标题)");
  const rows = turns.map((t) => ({ sessionId, turnId: t.turnId, title, q: t.q, a: t.a, ts: t.ts }));
  return {
    source: "claude",
    sessionId,
    file,
    title,
    project: cwd,
    kind: "user",
    rows,
    firstTs: rows[0]?.ts ?? 0,
    lastTs: rows.reduce((m, r) => Math.max(m, r.ts), 0),
  };
}

// ================================ Codex ================================

/** Codex 塞进用户消息的系统内容：整块以这些开头的 input_text 块不是用户写的（本机 rollout 实测） */
const CODEX_INJECTED_BLOCK = /^\s*(?:<environment_context>|<user_instructions>|<ENVIRONMENT_CONTEXT>|<recommended_plugins>|<send_user_message_question_reply>|<turn_aborted>|<subagent_notification>|<codex_delegation>|<heartbeat>|<skill>|# AGENTS\.md instructions|# Files mentioned by the user:)/;
/** 夹在用户原话里的注入块，非贪婪整块剥 */
const CODEX_INJECTED_INLINE = /<(environment_context|user_instructions|ENVIRONMENT_CONTEXT|recommended_plugins|codex_delegation|subagent_notification)>[\s\S]*?<\/\1>\s*/g;

export function codexUserText(blocks: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const b of blocks) {
    if (!isRecord(b) || typeof b["text"] !== "string") continue;
    if (b["type"] !== "input_text" && b["type"] !== "text") continue;
    const t = b["text"];
    if (CODEX_INJECTED_BLOCK.test(t)) continue;
    const s = t.replace(CODEX_INJECTED_INLINE, "").trim();
    if (s) parts.push(s);
  }
  const q = parts.join("\n\n").trim();
  return q === "" ? null : q;
}

function codexKind(meta: Record<string, unknown>): SessionKind {
  const ts = meta["thread_source"];
  const src = meta["source"];
  if (ts === "subagent" || (isRecord(src) && "subagent" in src) || typeof meta["parent_thread_id"] === "string") return "subagent";
  if (ts === "automation") return "automation";
  if (ts === "agent_created_thread") return "agent";
  return "user";
}

/**
 * 一份 Codex rollout → 行。只 JSON.parse 用得到的行（session_meta 与 message 项）——
 * rollout 里九成是推理、工具调用与 token 记录，整份解析 1GB 级的目录太慢。
 * - role=developer（系统提示）不进；agent_message（多 agent 之间传话）不进；
 * - 用户消息剥注入后没有自己的话 → 不开轮、也不关闭当前轮（注入夹在轮中间时回答不丢）；
 * - turnId = 窗口 + 行号（rollout 只追加，行号稳定）。history_mode=paginated 的会话按上下文窗口
 *   拆成多个文件（`rollout-…-<会话 id>_<窗口 id>.jsonl`，本机实测），同一会话的行号会在窗口间重复，
 *   所以 turnId 带上窗口 id（第一个窗口没有后缀，记 w0）；sessionId 仍是会话 id，几个窗口是同一个会话。
 */
export function parseCodexRollout(raw: string, file: string, titles?: Map<string, string>): ParsedSession {
  let meta: Record<string, unknown> = {};
  const turns: OpenTurn[] = [];
  let open: OpenTurn | null = null;
  let lastTs = 0;
  let line = 0;
  const window = /_([0-9a-f-]{36})\.jsonl$/.exec(basename(file))?.[1] ?? "w0";
  for (const text of raw.split("\n")) {
    line += 1;
    if (text === "") continue;
    const isMeta = text.includes('"type":"session_meta"');
    if (!isMeta && !(text.includes('"type":"response_item"') && text.includes('"type":"message"'))) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(obj) || !isRecord(obj["payload"])) continue;
    const p = obj["payload"];
    const ts = tsOf(obj["timestamp"]);
    if (ts) lastTs = Math.max(lastTs, ts);
    if (obj["type"] === "session_meta") {
      if (Object.keys(meta).length === 0) meta = p; // fork 的文件可能带多条，以第一条（本会话）为准
      continue;
    }
    if (obj["type"] !== "response_item" || p["type"] !== "message") continue;
    const content = Array.isArray(p["content"]) ? p["content"] : [];
    if (p["role"] === "user") {
      const q = codexUserText(content);
      if (q === null || isControlCommand(q)) continue;
      open = { line, turnId: `${window}:L${line}`, q, ts, a: "" };
      turns.push(open);
      continue;
    }
    if (p["role"] === "assistant" && open !== null) {
      const a = content
        .filter((b): b is { text: string } => isRecord(b) && (b["type"] === "output_text" || b["type"] === "text") && typeof b["text"] === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (a) (open as OpenTurn).a = a;
    }
  }
  const id = optStr(meta["id"]) ?? optStr(meta["session_id"]) ?? basename(file, ".jsonl");
  const sessionId = `codex-${id}`;
  const firstQ = turns[0]?.q ?? "";
  const title = titles?.get(id) ?? (firstQ ? clipTitle(firstQ) : "(无标题)");
  const rows = turns.map((t) => ({ sessionId, turnId: t.turnId, title, q: t.q, a: t.a, ts: t.ts }));
  return {
    source: "codex",
    sessionId,
    file,
    title,
    project: optStr(meta["cwd"]),
    kind: codexKind(meta),
    rows,
    firstTs: rows[0]?.ts ?? 0,
    lastTs: Math.max(lastTs, ...rows.map((r) => r.ts)),
  };
}

// ============================== 定位与扫描 ==============================

export function sourceRoot(id: LocalSourceId): string {
  if (id === "claude") return process.env.INTENT_LAB_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return process.env.INTENT_LAB_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** 这个来源的会话文件（只列主会话：Claude 子 agent 的转录在 <会话>/subagents/ 下，不列） */
export function listSessionFiles(id: LocalSourceId): string[] {
  const root = sourceRoot(id);
  const out: string[] = [];
  if (id === "claude") {
    const projects = join(root, "projects");
    if (!existsSync(projects)) return out;
    for (const d of readdirSync(projects, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(projects, d.name);
      for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) out.push(join(dir, f));
    }
    return out.sort();
  }
  const sessions = join(root, "sessions");
  if (!existsSync(sessions)) return out;
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.startsWith("rollout-") && d.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(sessions);
  return out.sort();
}

function codexTitles(): Map<string, string> {
  const m = new Map<string, string>();
  const p = join(sourceRoot("codex"), "session_index.jsonl");
  if (!existsSync(p)) return m;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    try {
      const r = JSON.parse(line) as { id?: string; thread_name?: string };
      if (r.id && r.thread_name) m.set(r.id, r.thread_name); // 后写覆盖 = 最新改名
    } catch {
      // 坏行跳过
    }
  }
  return m;
}

/** 解析缓存：文件 mtime+size 不变就不重读（1GB 级的 Codex 目录第一次扫约十几秒，之后毫秒级） */
const parseCache = new Map<string, { sig: string; parsed: ParsedSession }>();
export const fileSig = (file: string): string => {
  const st = statSync(file);
  return `${st.mtimeMs}:${st.size}`;
};

export async function scanSource(id: LocalSourceId, onFile?: (done: number, total: number) => void): Promise<ParsedSession[]> {
  const files = listSessionFiles(id);
  const titles = id === "codex" ? codexTitles() : undefined;
  const out: ParsedSession[] = [];
  let i = 0;
  for (const file of files) {
    i += 1;
    let sig: string;
    try {
      sig = fileSig(file);
    } catch {
      continue; // 扫描途中被删
    }
    const hit = parseCache.get(file);
    if (hit && hit.sig === sig) {
      out.push(hit.parsed);
    } else {
      const raw = await Bun.file(file).text();
      const parsed = id === "claude" ? parseClaudeSession(raw, file) : parseCodexRollout(raw, file, titles);
      parseCache.set(file, { sig, parsed });
      out.push(parsed);
      if (i % 20 === 0) await Bun.sleep(0); // 让出事件循环：扫描期间 /health、/recall 照常响应
    }
    onFile?.(i, files.length);
  }
  return out;
}

// ============================== 设置与状态 ==============================

export interface SourceState {
  /** 首次发现时问用户：unasked → yes / no */
  consent: "unasked" | "yes" | "no";
  /** 参与召回（暂停 = 数据在、召回里藏起来） */
  enabled: boolean;
  lastSyncAt: number | null;
}

/** 在哪些应用里用意图系统（管理页概览的开关；Claude 插件在新会话开局、第一句之前读） */
export interface AppSwitches {
  claude: boolean;
  /** Codex 侧还没接入（MCP 待做）：先记下，接入后生效 */
  codex: boolean;
}

export interface LocalState {
  apps: AppSwitches;
  sources: Record<LocalSourceId, SourceState>;
  excludedProjects: Record<LocalSourceId, string[]>;
  excludedSessions: string[];
  /** 已成功送进 /import 的文件签名（增量同步用）：file → mtime:size */
  synced: Record<string, string>;
  /** 入过库的会话 → 来源与项目（可见集过滤按项目排除用） */
  sessions: Record<string, { source: LocalSourceId; project: string | null }>;
}

const emptyState = (): LocalState => ({
  apps: { claude: false, codex: false },
  sources: {
    claude: { consent: "unasked", enabled: true, lastSyncAt: null },
    codex: { consent: "unasked", enabled: true, lastSyncAt: null },
  },
  excludedProjects: { claude: [], codex: [] },
  excludedSessions: [],
  synced: {},
  sessions: {},
});

export const localStatePath = (dir = dataDir()): string => join(dir, "local-sources", "state.json");

let stateCache: { path: string; mtimeMs: number; state: LocalState } | null = null;

export function loadLocalState(dir = dataDir()): LocalState {
  const path = localStatePath(dir);
  const mtimeMs = existsSync(path) ? statSync(path).mtimeMs : -1;
  if (stateCache && stateCache.path === path && stateCache.mtimeMs === mtimeMs) return stateCache.state;
  let state = emptyState();
  if (mtimeMs >= 0) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LocalState>;
      const base = emptyState();
      state = {
        apps: { ...base.apps, ...raw.apps },
        sources: { claude: { ...base.sources.claude, ...raw.sources?.claude }, codex: { ...base.sources.codex, ...raw.sources?.codex } },
        excludedProjects: { claude: raw.excludedProjects?.claude ?? [], codex: raw.excludedProjects?.codex ?? [] },
        excludedSessions: raw.excludedSessions ?? [],
        synced: raw.synced ?? {},
        sessions: raw.sessions ?? {},
      };
    } catch {
      // 坏文件按空状态（不丢 QA：QA 在 qa-import.jsonl 里）
    }
  }
  stateCache = { path, mtimeMs, state };
  return state;
}

export function saveLocalState(state: LocalState, dir = dataDir()): void {
  const path = localStatePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
  stateCache = { path, mtimeMs: statSync(path).mtimeMs, state };
}

export function updateLocalState(fn: (s: LocalState) => void, dir = dataDir()): LocalState {
  const s = structuredClone(loadLocalState(dir));
  fn(s);
  saveLocalState(s, dir);
  return s;
}

export function sourceOfSession(sessionId: string): LocalSourceId | null {
  if (sessionId.startsWith("claude-")) return "claude";
  if (sessionId.startsWith("codex-")) return "codex";
  return null;
}

/** 可见集里要藏的本机会话：来源暂停、项目排除、会话排除（数据保留，恢复即生效） */
export function localHiddenSessions(dir = dataDir()): (sessionId: string) => boolean {
  const s = loadLocalState(dir);
  const excludedSessions = new Set(s.excludedSessions);
  const excludedProjects = { claude: new Set(s.excludedProjects.claude), codex: new Set(s.excludedProjects.codex) };
  return (sessionId: string): boolean => {
    const src = sourceOfSession(sessionId);
    if (src === null) return false;
    if (!s.sources[src].enabled) return true;
    if (excludedSessions.has(sessionId)) return true;
    const project = s.sessions[sessionId]?.project;
    return project != null && excludedProjects[src].has(project);
  };
}

// ================================ 入库任务 ================================

export interface ImportBatchResult {
  imported: number;
  duplicates: number;
  updated: number;
}

export interface LocalJob {
  source: LocalSourceId;
  mode: "full" | "sync";
  phase: "scan" | "import" | "done" | "error";
  startedAt: number;
  finishedAt: number | null;
  filesDone: number;
  filesTotal: number;
  rowsTotal: number;
  rowsSent: number;
  imported: number;
  duplicates: number;
  updated: number;
  error: string | null;
}

const jobs = new Map<LocalSourceId, LocalJob>();
export const currentJob = (id: LocalSourceId): LocalJob | null => jobs.get(id) ?? null;

/**
 * 导入 / 增量同步一个来源。full = 全部文件重送（服务端去重兜底）；sync = 只送签名变了的文件。
 * 只送 kind=user 的会话。按 500 行一批调 importBatch（服务端传 /import 的同一个实现）。
 * 一批成功才记那一批文件的签名——中途失败，下次 sync 从没记上的接着送。
 */
export function startLocalImport(
  id: LocalSourceId,
  mode: "full" | "sync",
  importBatch: (rows: LocalRow[]) => ImportBatchResult,
  /** 任务成功结束后调（服务端用它接着开始预热） */
  onDone?: (job: LocalJob) => void,
): LocalJob {
  const running = jobs.get(id);
  if (running && (running.phase === "scan" || running.phase === "import")) return running;
  const job: LocalJob = {
    source: id, mode, phase: "scan", startedAt: Date.now(), finishedAt: null,
    filesDone: 0, filesTotal: 0, rowsTotal: 0, rowsSent: 0, imported: 0, duplicates: 0, updated: 0, error: null,
  };
  jobs.set(id, job);
  updateLocalState((s) => {
    if (s.sources[id].consent !== "yes") s.sources[id].consent = "yes";
  });
  void (async () => {
    try {
      const parsed = await scanSource(id, (done, total) => {
        job.filesDone = done;
        job.filesTotal = total;
      });
      const state = loadLocalState();
      const todo = parsed.filter((p) => p.kind === "user" && (mode === "full" || state.synced[p.file] !== safeSig(p.file)));
      job.rowsTotal = todo.reduce((n, p) => n + p.rows.length, 0);
      job.phase = "import";
      let batch: LocalRow[] = [];
      let batchFiles: ParsedSession[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length) {
          const r = importBatch(batch);
          job.imported += r.imported;
          job.duplicates += r.duplicates;
          job.updated += r.updated;
          job.rowsSent += batch.length;
        }
        const files = batchFiles;
        updateLocalState((s) => {
          for (const p of files) {
            s.synced[p.file] = safeSig(p.file);
            s.sessions[p.sessionId] = { source: id, project: p.project };
          }
        });
        batch = [];
        batchFiles = [];
        await Bun.sleep(0);
      };
      for (const p of todo) {
        if (batch.length + p.rows.length > 500 && batch.length) await flush();
        // 单个会话超过 500 行：拆开送（签名在最后一片送完才记）
        for (let i = 0; i < p.rows.length; i += 500) {
          const slice = p.rows.slice(i, i + 500);
          if (batch.length + slice.length > 500) await flush();
          batch.push(...slice);
        }
        batchFiles.push(p);
      }
      await flush();
      updateLocalState((s) => {
        s.sources[id].lastSyncAt = Date.now();
      });
      job.phase = "done";
      onDone?.(job);
    } catch (err) {
      job.phase = "error";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}

function safeSig(file: string): string {
  try {
    return fileSig(file);
  } catch {
    return "";
  }
}

/** 测试用：清掉模块内缓存 */
export function resetLocalCaches(): void {
  parseCache.clear();
  stateCache = null;
  jobs.clear();
}

/** 一个会话的汇总（Codex 的分页会话由几个窗口文件组成，合成一条） */
export interface SessionSummary {
  source: LocalSourceId;
  sessionId: string;
  title: string;
  project: string | null;
  kind: SessionKind;
  files: string[];
  rows: number;
  firstTs: number;
  lastTs: number;
}

export function summarizeSessions(parsed: readonly ParsedSession[]): SessionSummary[] {
  const by = new Map<string, SessionSummary>();
  for (const p of parsed) {
    const cur = by.get(p.sessionId);
    if (!cur) {
      by.set(p.sessionId, { source: p.source, sessionId: p.sessionId, title: p.title, project: p.project, kind: p.kind, files: [p.file], rows: p.rows.length, firstTs: p.firstTs, lastTs: p.lastTs });
      continue;
    }
    cur.files.push(p.file);
    cur.rows += p.rows.length;
    if (p.firstTs && (!cur.firstTs || p.firstTs < cur.firstTs)) {
      cur.firstTs = p.firstTs;
      cur.title = p.title; // 标题以第一个窗口为准
      cur.project = p.project ?? cur.project;
    }
    cur.lastTs = Math.max(cur.lastTs, p.lastTs);
  }
  return [...by.values()];
}
