import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Ask, Conn, Final, IntentMode, Prewarm, Run, Selected, SourceView, StageStatus } from '../types'

/**
 * 意图系统 · Claude Code 接入（接真实 intent-lab，http://127.0.0.1:8723）。
 *
 * 交互照 Orbita：输入框上方的按钮条 = 开关 + 运行卡（11 格阶段条 + 两步进度）+ 回答前确认卡；
 * 详情在侧栏；低频管理在 intent-lab 自带的管理页（/ui）。
 *
 * 一问的流程：提交 → 开关开着就拦下这句（drop）→ 先增量同步本机来源（/local/import sync）→
 * /recall（curl 流式读 NDJSON）→ 有待确认的连接就出确认卡 → /feedback → 把原话重新发出，
 * 召回结果（injection）作为 context 附在旁边给模型读（用户界面不显示）。
 *
 * 本机请求都走 curl --noproxy：设置里配了全局 HTTP 代理，不能让 127.0.0.1 的请求被代理转走。
 */

const BASE = 'http://127.0.0.1:8723'
/** 召回进行中多久没收到任何事件就判定断了（服务端心跳 10 秒一次） */
const WATCHDOG_MS = 45_000
const PANE = 'intent-detail'

const modeAtom = atom({ plugin: 'intent-toggle', key: 'mode' } as const, { sessionOn: false, forceNext: false, defaultOn: false, firstForceFromPrefs: false } as IntentMode)
const runAtom = atom({ plugin: 'intent-toggle', key: 'run' } as const, null as Run | null)
const lastAtom = atom({ plugin: 'intent-toggle', key: 'last' } as const, null as Final | null)
const connAtom = atom({ plugin: 'intent-toggle', key: 'conn' } as const, null as Conn | null)
const sourcesAtom = atom({ plugin: 'intent-toggle', key: 'sources' } as const, [] as SourceView[])
const prewarmAtom = atom({ plugin: 'intent-toggle', key: 'prewarm' } as const, null as Prewarm | null)

// ---- 模块内的临时量（只在同一个模块环境里用：确认卡的补充背景草稿，输入与提交都在按钮条里） ----
let noteDraft = ''

// ---------------- 小工具 ----------------
const n = (x: number): string => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const dur = (ms: number): string => {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
const rel = (now: number, at: number | null): string => {
  if (at == null) return '未同步'
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : `${Math.floor(s / 3600)} 小时前`
}
const bar = (f: number, width = 28): string => {
  const k = Math.round(Math.min(1, Math.max(0, f)) * width)
  return '█'.repeat(k) + '░'.repeat(width - k)
}
const NAME = { claude: 'Claude', codex: 'Codex' } as const

type Http = { status: number; body: any; error: string | null }

/** 本机请求：curl 绕开代理；连不上 status=0 */
async function call($: any, path: string, body?: unknown, timeoutSec = 15): Promise<Http> {
  const argv = ['curl', '-sS', '--noproxy', '*', '-m', String(timeoutSec), '-w', '\n%{http_code}', `${BASE}${path}`]
  if (body !== undefined) argv.push('-X', 'POST', '-H', 'content-type: application/json', '--data-binary', '@-')
  try {
    const r = await $.process.run(argv, { ...(body === undefined ? {} : { stdin: JSON.stringify(body) }), timeoutMs: (timeoutSec + 5) * 1000 })
    const out: string = r.stdout ?? ''
    const cut = out.lastIndexOf('\n')
    const status = Number(out.slice(cut + 1)) || 0
    const text = cut >= 0 ? out.slice(0, cut) : ''
    if (status === 0) return { status: 0, body: null, error: (r.stderr || 'intent-lab 没有运行').trim() }
    let parsed: any = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    return { status, body: parsed, error: status >= 400 ? (parsed?.error ?? `HTTP ${status}`) : null }
  } catch (err) {
    return { status: 0, body: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 新会话偏好：存在插件自己的跨会话存储（$.store），不依赖 intent-lab 服务 */
type Prefs = { newSession: 'on' | 'off'; firstForce: boolean }
const PREFS_KEY = 'prefs'
/**
 * 新会话默认以管理页概览的「Claude Code」开关为准（intent-lab 的 /local/apps）；服务连不上时
 * 退回插件自己存的一份（$.store）。「下一个新会话第一句强制」只存在插件里。
 */
async function loadPrefs($: any): Promise<Prefs> {
  const v = (await $.store.get(PREFS_KEY).catch(() => undefined)) as Partial<Prefs> | undefined
  const local: Prefs = { newSession: v?.newSession === 'on' ? 'on' : 'off', firstForce: v?.firstForce === true }
  const r = await call($, '/local/apps', undefined, 3)
  if (r.status === 200 && typeof r.body?.apps?.claude === 'boolean') {
    const newSession = r.body.apps.claude ? 'on' : 'off'
    if (newSession !== local.newSession) await $.store.set(PREFS_KEY, { ...local, newSession }).catch(() => undefined)
    return { ...local, newSession }
  }
  return local
}
async function savePrefs($: any, patch: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await loadPrefs($)), ...patch }
  await $.store.set(PREFS_KEY, next)
  if (patch.newSession !== undefined) {
    const r = await call($, '/local/apps', { claude: patch.newSession === 'on' }, 3)
    if (r.status !== 200) $.ui.toast('intent-lab 没连上：新会话默认先记在插件里，管理页里还是旧值')
  }
  await update($, modeAtom, (m) => ({ ...m, defaultOn: next.newSession === 'on' }))
  return next
}

/** 读新会话偏好设开关（第一句之前）；环境变量 INTENT_LAB_SESSION（on / off / force）压过它 */
async function applyNewSessionPrefs($: any): Promise<void> {
  const env = ((await $.env.get('INTENT_LAB_SESSION').catch(() => undefined)) ?? '').trim().toLowerCase()
  const prefs = await loadPrefs($)
  const sessionOn = env === 'on' || env === 'force' ? true : env === 'off' ? false : prefs.newSession === 'on'
  const forceNext = env === 'force' || (env !== 'off' && prefs.firstForce === true)
  await update($, modeAtom, () => ({ sessionOn, forceNext, defaultOn: prefs.newSession === 'on', firstForceFromPrefs: forceNext && prefs.firstForce === true }))
}

async function refreshHealth($: any): Promise<void> {
  const h = await call($, '/health', undefined, 5)
  if (h.status === 0) {
    await update($, connAtom, () => ({ ok: false, reachable: false, needsActivation: false, error: 'intent-lab 没有运行', qaVisible: 0, contract: null, model: '' }))
    return
  }
  const b = h.body ?? {}
  await update($, connAtom, () => ({
    ok: b.ok === true,
    reachable: true,
    needsActivation: b.needsActivation === true,
    error: b.ok === true ? null : (b.error ?? '端点未配置完整'),
    qaVisible: b.qaVisible ?? 0,
    contract: b.contract ?? null,
    model: b.swarm?.model ?? '',
  }))
}

async function refreshSources($: any): Promise<SourceView[]> {
  const r = await call($, '/local/sources', undefined, 20)
  if (r.status !== 200 || !r.body?.sources) return read($, sourcesAtom)
  const list: SourceView[] = r.body.sources.map((s: any) => ({
    id: s.id, consent: s.consent, enabled: s.enabled, sessions: s.sessions, rowsFound: s.rowsFound,
    rowsStored: s.rowsStored, rowsActive: s.rowsActive, lastSyncAt: s.lastSyncAt, job: s.job,
  }))
  const before = await read($, sourcesAtom)
  for (const s of list) {
    const was = before.find((x) => x.id === s.id)?.job?.phase
    if ((was === 'scan' || was === 'import') && s.job?.phase === 'done' && s.job.imported > 0) {
      $.ui.toast(`${NAME[s.id]} 入库完成：新增 ${n(s.job.imported)} 条（重复 ${n(s.job.duplicates)}）`)
    }
    if ((was === 'scan' || was === 'import') && s.job?.phase === 'error') $.ui.toast(`${NAME[s.id]} 导入失败：${s.job.error}`)
  }
  await update($, sourcesAtom, () => list)
  return list
}

const jobRunning = (s: SourceView): boolean => s.job?.phase === 'scan' || s.job?.phase === 'import'

/** 缓存预热（管理页同步完就开始）：第一次全量很慢，没做完时召回会很慢——提问时先问，不默默在对话里硬跑 */
async function refreshPrewarm($: any): Promise<Prewarm | null> {
  const r = await call($, '/local/prewarm', undefined, 10)
  const p = r.status === 200 && r.body?.prewarm ? r.body.prewarm : null
  const v: Prewarm | null = p && p.available
    ? { available: true, phase: p.phase, done: p.done ?? 0, total: p.total ?? 0, coverage: p.coverage ?? { segs: 0, warmed: 0 }, etaMs: p.etaMs ?? null }
    : null
  await update($, prewarmAtom, () => v)
  return v
}
const pwRunning = (p: Prewarm | null): boolean => !!p && (p.phase === 'queued' || p.phase === 'running' || p.phase === 'paused')
const pwPct = (p: Prewarm | null): number => (p && p.coverage.segs ? p.coverage.warmed / p.coverage.segs : 1)
/** 覆盖不到 95% 才拦（刚同步进来的几条增量不算） */
const pwCold = (p: Prewarm | null): boolean => !!p && pwPct(p) < 0.95
const etaText = (ms: number | null): string => (ms == null ? '' : ms < 90_000 ? '不到 2 分钟' : ms < 3_600_000 ? `约 ${Math.round(ms / 60000)} 分钟` : `约 ${(ms / 3_600_000).toFixed(1)} 小时`)

// ---------------- 一问的流程 ----------------

const blankRun = (text: string, forced: boolean, sessionId: string, now: number, turnId = `p-${now.toString(36)}`): Run => ({
  text, forced, sessionId, turnId, startedAt: now, now, lastEventAt: now, runId: null, phase: 'sync', synced: null,
  qaTotal: null, budgetMs: null, stages: { gate: 'pending', s1: 'pending', s3: 'pending', s4: 'pending' }, step: null,
  progress: null, step1: null, step2: null, s4: null, scene: null, want: null, dedup: null, summary: null, missing: null,
  selected: [], selectedCount: null, asks: [], askRemaining: 0, injection: '', edgesWritten: null, contextAdded: null,
  error: null, skipAll: false,
})

const setRun = ($: any, fn: (r: Run) => Run): Promise<unknown> => update($, runAtom, (r) => (r === null ? r : fn(r)))

/**
 * 把原话重新发出。召回结果先作为一条「模型读得到、界面不显示」的用户行追加进对话
 * （$.session.append，isMeta），再发原话——插件自己的 $.prompt.submit 不经过自己的 hook，
 * 没法在 prompt.submit 里给它挂 context。
 */
async function deliver($: any, text: string, injection: string): Promise<void> {
  if (injection) {
    const note = `意图系统为下面这一问从用户的历史对话里召回的上下文（用户界面不显示这段；回答时按需参考，用不上就忽略）：\n\n${injection}`
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } }).catch((err: unknown) => ({ deny: String(err) }))
    if (r && 'deny' in r && r.deny) $.ui.toast(`召回结果没能附上（${r.deny}），这句照常发送`)
  }
  await $.prompt.submit({ text, asUser: true })
}

function finalFrom(r: Run, kind: Final['kind'], extra: Partial<Final> = {}): Final {
  return {
    kind, text: r.text, forced: r.forced, totalMs: r.now - r.startedAt, qaTotal: r.qaTotal, gateWhy: '', scene: r.scene, want: r.want,
    summary: r.summary, selected: r.selected, selectedCount: r.selectedCount ?? r.selected.length, asks: r.asks, note: '',
    answeredWithoutConfirm: false, error: r.error?.message ?? null, ...extra,
  }
}

/**
 * 跑一问。retryOf 给了 = 重试那一问：沿用它的 turnId——服务端断点按 (sessionId, turnId, q) 认同一问，
 * 已打过的分、写好的理由直接复用，只补没做完的（以前每次重试都换新 turnId，等于从头再来）。
 */
async function startRun($: any, text: string, forced: boolean, retryOf?: string): Promise<void> {
  const now = await $.clock.now()
  const sid = `claude-${await $.session.id()}`
  noteDraft = ''
  const myTurn = retryOf ?? `p-${now.toString(36)}`
  await update($, runAtom, () => blankRun(text, forced, sid, now, myTurn))

  // 1) 先增量同步已同意的本机来源（刚在 Codex / 别的 Claude 会话里说的几句赶上这次召回）
  const sources = await refreshSources($)
  const agreed = sources.filter((s) => s.consent === 'yes')
  for (const s of agreed) await call($, '/local/import', { source: s.id, mode: 'sync' })
  for (let i = 0; i < 20 && agreed.length; i++) {
    const list = await refreshSources($)
    if (!list.some(jobRunning)) break
    await $.clock.sleep(250)
  }
  if ((await read($, runAtom))?.turnId !== myTurn) return // 期间被取消
  const fresh = (await read($, sourcesAtom)).filter((s) => s.consent === 'yes' && s.job?.mode !== 'full')
  const added = fresh.reduce((t, s) => t + (s.job?.imported ?? 0), 0)
  const runningAt = await $.clock.now()
  await setRun($, (r) => ({ ...r, phase: 'running', lastEventAt: runningAt, synced: agreed.length ? `已先同步${agreed.map((s) => NAME[s.id]).join(' / ')}${added ? `：新增 ${added} 条` : ''}` : null }))

  // 2) /recall 流式
  const body = JSON.stringify({ sessionId: sid, turnId: myTurn, title: '', q: text, ...(forced ? { force: true } : {}) })
  const s = $.process.spawn({
    argv: ['curl', '-sSN', '--noproxy', '*', '-X', 'POST', '-H', 'content-type: application/json', '--data-binary', '@-', `${BASE}/recall`],
    input: body,
  })
  let buf = ''
  let ended = false
  try {
    for await (const chunk of s) {
      // 取消（按钮可能在别的模块环境里点的）：run 被清掉 / 换了一问 → 离开循环，curl 被杀，服务端随之取消
      if ((await read($, runAtom))?.turnId !== myTurn) break
      if (chunk.stream !== 'stdout') continue
      buf += chunk.text
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let ev: any
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.error && !ev.type) {
          ev = { type: 'error', stage: 'config', message: ev.error, retryable: false }
        }
        ended = (await onEvent($, ev)) || ended
      }
    }
  } catch {
    // curl 起不来
  }
  const r = await read($, runAtom)
  if (!ended && r !== null && r.turnId === myTurn) {
    await setRun($, (x) => ({ ...x, phase: 'error', error: { stage: 'config', message: 'intent-lab 的连接提前断开（服务没运行或中途重启）', retryable: true } }))
  }
}

/** 处理一个事件；返回 true = 这次召回结束了（done / error） */
async function onEvent($: any, ev: any): Promise<boolean> {
  const now = await $.clock.now()
  await setRun($, (r) => ({ ...r, lastEventAt: now })) // 看门狗：任何事件（含心跳）都算还活着
  switch (ev.type) {
    case 'accepted':
      await setRun($, (r) => ({ ...r, now, runId: ev.runId, qaTotal: ev.qaTotal, budgetMs: ev.budgetMs }))
      return false
    case 'stage': {
      const st: StageStatus = ev.status === 'start' ? 'running' : 'done'
      if (ev.stage === 'gate' || ev.stage === 's1' || ev.stage === 's3' || ev.stage === 's4') {
        await setRun($, (r) => ({ ...r, now, stages: { ...r.stages, [ev.stage]: st } }))
      }
      return false
    }
    case 'intent':
      await setRun($, (r) => ({ ...r, now, scene: ev.scene, want: ev.want }))
      return false
    case 'progress':
      if (ev.stage === 's3') {
        await setRun($, (r) => ({
          ...r, now, step: ev.step, progress: { done: ev.done, total: ev.total, passed: ev.passed, etaMs: ev.etaMs },
          ...(ev.step === 1 ? { step1: { total: ev.total, passed: ev.passed } } : { step2: { total: ev.total, passed: ev.passed } }),
        }))
      } else if (ev.stage === 's4') {
        await setRun($, (r) => ({ ...r, now, s4: { done: ev.done, chars: ev.passed } }))
      }
      return false
    case 'review': {
      const selected: Selected[] = (ev.selected ?? []).slice(0, 30).map((s: any) => ({
        when: s.when ?? '', title: s.title ?? '', slots: `${(s.slots ?? []).join(' · ')}${typeof s.score === 'number' ? ` ${s.score.toFixed(1)}` : ''}`,
        human: s.human || s.why || '', connection: s.connection ?? '',
      }))
      const asks: Ask[] = (ev.ask ?? []).map((a: any) => ({
        askId: a.askId, qaId: a.qaId, slot: a.slot, statement: a.statement, when: a.when ?? '', title: a.title ?? '', quote: a.quote ?? '',
        verdict: null, edited: null, editing: false,
      }))
      await setRun($, (r) => ({
        ...r, now, summary: ev.summary ?? null, missing: ev.missing ?? null, selected, selectedCount: (ev.selected ?? []).length,
        asks, askRemaining: ev.askRemaining ?? 0, dedup: ev.dedup ?? null,
      }))
      return false
    }
    case 'done': {
      const r = await read($, runAtom)
      if (r === null) return true
      const cur = { ...r, now, injection: ev.injection ?? '', edgesWritten: ev.edgesWritten ?? null, contextAdded: ev.context?.added ?? null }
      if (ev.skipped === 'gate') {
        await update($, lastAtom, () => finalFrom(cur, 'skipped', { gateWhy: ev.gateWhy ?? '', totalMs: ev.timing?.totalMs ?? now - r.startedAt }))
        await update($, runAtom, () => null)
        await deliver($, r.text, '')
        return true
      }
      if (ev.needsFeedback) {
        await update($, runAtom, () => ({ ...cur, phase: 'confirm' }))
        $.ui.toast(`意图系统：有 ${cur.asks.length} 条连接需要你确认（在输入框上方）`)
        return true
      }
      await update($, lastAtom, () => finalFrom(cur, 'done', { totalMs: ev.timing?.totalMs ?? now - r.startedAt }))
      await update($, runAtom, () => null)
      if (ev.context?.notice) $.ui.toast(ev.context.notice)
      await deliver($, r.text, cur.injection)
      return true
    }
    case 'error':
      await setRun($, (r) => ({ ...r, now, phase: 'error', error: { stage: String(ev.stage ?? ''), message: String(ev.message ?? '出错了'), retryable: ev.retryable !== false } }))
      return true
    default:
      if (ev.type === 'heartbeat') await setRun($, (r) => ({ ...r, now }))
      return false
  }
}

async function cancelRun($: any, refill: boolean): Promise<void> {
  const r = await read($, runAtom)
  await update($, runAtom, () => null) // 召回循环看到后自己退出（下一段输出或心跳时，最长约 10 秒）
  if (r) {
    await update($, lastAtom, () => finalFrom({ ...r, now: Date.now() }, 'cancelled'))
    if (refill) await $.prompt.fill({ text: r.text })
  }
}

async function submitFeedback($: any, skipAll: boolean): Promise<void> {
  const r = await read($, runAtom)
  if (r === null || r.runId === null) return
  const answers = r.asks.map((a) => ({
    askId: a.askId,
    verdict: skipAll ? 'skip' : (a.verdict ?? 'skip'),
    ...(!skipAll && a.edited !== null ? { edited: a.edited } : {}),
  }))
  await setRun($, (x) => ({ ...x, phase: 'finishing', skipAll }))
  const res = await call($, '/feedback', { runId: r.runId, answers, note: skipAll ? '' : noteDraft.trim() })
  const injection: string = res.body?.injection ?? r.injection
  if (res.status !== 200) $.ui.toast(`确认结果没送进 intent-lab（${res.error}），按「全部不表态」版本回答`)
  else if (res.body?.context?.notice) $.ui.toast(res.body.context.notice)
  await update($, lastAtom, () => finalFrom({ ...r, now: Date.now() }, 'done', {
    asks: skipAll ? r.asks.map((a) => ({ ...a, verdict: null, edited: null })) : r.asks,
    note: skipAll ? '' : noteDraft.trim(),
    answeredWithoutConfirm: skipAll,
  }))
  await update($, runAtom, () => null)
  await deliver($, r.text, injection)
}

// ---------------- 阶段条（Orbita v3.3 的 11 格） ----------------

type Cell = { key: string; label: string; status: StageStatus }

function cells(r: Run): Cell[] {
  const s3done = r.stages.s3 === 'done'
  const st1: StageStatus = r.stages.s3 === 'pending' ? 'pending' : r.step === 1 && !s3done ? 'running' : 'done'
  const st2: StageStatus = s3done ? 'done' : r.step === 2 ? 'running' : 'pending'
  const p = r.progress
  const after = r.phase === 'finishing'
  return [
    { key: 'gate', label: '门卫', status: r.stages.gate },
    { key: 'understand', label: '理解问题', status: r.stages.s1 },
    { key: 'score', label: `打分 ${n(r.step === 1 && p ? p.done : r.step1?.total ?? 0)}/${n(r.step1?.total ?? r.qaTotal ?? 0)}`, status: st1 },
    { key: 'passline', label: `过线 ${n(r.step1?.passed ?? 0)}`, status: st1 },
    { key: 'reasons', label: `写理由 ${n(r.step === 2 && p ? p.done : r.step2?.total ?? 0)}/${n(r.step2?.total ?? r.step1?.passed ?? 0)}`, status: st2 },
    { key: 'dedup', label: r.dedup ? `去重 → ${n(r.dedup.after)}${r.dedup.before > r.dedup.after ? ` · 合并 ${n(r.dedup.before - r.dedup.after)}` : ''}` : '去重', status: r.dedup ? 'done' : s3done ? 'running' : 'pending' },
    { key: 'keeper', label: r.selectedCount !== null ? `摘句 · 选 ${r.selectedCount} 条` : r.s4 ? `摘句 · 已写 ${r.s4.done} 条 · ${n(r.s4.chars)} 字` : '摘句', status: r.stages.s4 },
    { key: 'confirm', label: r.asks.length ? `确认 ${r.asks.length} 条` : '不用问', status: r.phase === 'confirm' ? 'running' : after ? 'done' : r.selectedCount !== null ? 'done' : 'pending' },
    { key: 'context', label: '写上下文', status: after ? 'running' : 'pending' },
    { key: 'answer', label: '回答', status: 'pending' },
  ]
}
const glyph = (s: StageStatus): string => (s === 'done' ? '✓' : s === 'running' ? '◌' : s === 'error' ? '✕' : '·')

function finalLine(f: Final): string {
  if (f.kind === 'skipped') return `这句没有做意图分析 · 门卫：跳过——${f.gateWhy}`
  if (f.kind === 'cancelled') return '已取消，本轮未回答'
  if (f.kind === 'error') return `召回失败：${f.error ?? ''}`
  const v = f.asks.length && !f.answeredWithoutConfirm
    ? ` · 对 ${f.asks.filter((a) => a.verdict === 'yes').length} / 不对 ${f.asks.filter((a) => a.verdict === 'no').length} / 不表态 ${f.asks.filter((a) => a.verdict === null).length}`
    : f.asks.length ? ' · 未确认，直接回答' : ''
  return `读了 ${f.qaTotal === null ? '?' : n(f.qaTotal)} 条，选中 ${f.selectedCount} 条，问了你 ${f.asks.length} 条 · 用时 ${dur(f.totalMs)}${v}`
}

// ---------------- 注册 ----------------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    // 新会话偏好：桌面版要等第一句发出才启动会话，按钮条在那之前画不出来——所以开关在会话外选
    // （菜单栏 / 管理页 / 按钮条的「新会话默认」），这里在第一句被处理之前读进来。
    // session.start 保证在第一句之前跑完，所以第一句就按选好的开关走。环境变量 INTENT_LAB_SESSION
    // （on / off / force）压过它，给桌面版的会话预设用。
    await applyNewSessionPrefs($)
    // 插件重新加载（改了插件文件 / 会话重启）时，在跑的召回已随旧模块一起断了（读流的 curl 被杀，服务端取消），
    // 但 $.state 里的运行卡还在——不标出来就会一直停在原地（2026-10-09「卡在写理由」）
    const stale = await read($, runAtom)
    if (stale !== null && (stale.phase === 'sync' || stale.phase === 'running' || stale.phase === 'finishing')) {
      await setRun($, (r) => ({ ...r, phase: 'error', error: { stage: 'config', message: '插件刚重新加载（或会话重启），这次召回中断了', retryable: true } }))
    }
    // 命令注册失败（某些宿主没有）不影响按钮条
    await $.command.register({ name: 'intent', description: '意图系统：新对话先输入它，在第一句之前选开关（on / off / force / default on|off / ui）' }).catch(() => undefined)
    void refreshHealth($)
    void refreshSources($)
    void refreshPrewarm($)
    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      void (async () => {
        const run = await read($, runAtom)
        const t = await $.clock.now()
        if (run !== null && run.phase === 'running' && t - run.lastEventAt > WATCHDOG_MS) {
          // 服务端每 10 秒发心跳；这么久什么都没收到 = 连接断了（服务重启 / 网络 / 读流的进程没了），别让界面一直停着
          await setRun($, (r) => ({ ...r, phase: 'error', error: { stage: 'config', message: `intent-lab 已经 ${Math.round(WATCHDOG_MS / 1000)} 秒没有任何输出（服务重启或连接中断），这次召回中断了`, retryable: true } }))
        } else if (run !== null && run.phase !== 'confirm' && run.phase !== 'error' && run.phase !== 'prewarm') await setRun($, (r) => ({ ...r, now: t }))
        const sources = await read($, sourcesAtom)
        if (sources.some(jobRunning)) await refreshSources($)
        // 预热卡显示期间每 3 秒刷一次（完成后卡片要翻成「预热已完成」；只看 running 会停在旧百分比）
        if (ticks % 3 === 0 && (pwRunning(await read($, prewarmAtom)) || (run !== null && run.phase === 'prewarm'))) await refreshPrewarm($)
        if (ticks % 30 === 0) {
          await refreshHealth($)
          if (run === null) { await refreshSources($); await refreshPrewarm($) }
        }
      })()
    })
    return next(e)
  })

  /**
   * /intent —— 新对话里先输入它（不发给模型）：会话随之启动、按钮条出现，第一句之前就能选开关。
   *   /intent             看状态（按钮条也出来了）
   *   /intent on | off    本会话开 / 关
   *   /intent force       下一句强制分析（跳过门卫）
   *   /intent default on|off   之后新会话的默认
   *   /intent ui          在浏览器打开管理页（来源、召回记录、表态、设置）
   */
  on('command.run', { command: 'intent' }, async ($, e) => {
    const [a, b] = e.args.trim().toLowerCase().split(/\s+/)
    const conn0 = await read($, connAtom)
    if (conn0?.needsActivation) return { text: '意图系统还没激活：点输入框上方的「管理」（或 /intent ui）打开管理页，在①输入邀请码激活。激活 → 导入 → 预热完成后再来提问。' }
    if (a === 'ui' || a === '管理') {
      await $.process.run(['open', `${BASE}/ui`]).catch(() => undefined)
      return { text: `已在浏览器打开 ${BASE}/ui` }
    }
    if (a === 'on' || a === '开') await update($, modeAtom, (m) => ({ ...m, sessionOn: true }))
    else if (a === 'off' || a === '关') await update($, modeAtom, (m) => ({ ...m, sessionOn: false, forceNext: false }))
    else if (a === 'force' || a === '强制') await update($, modeAtom, (m) => ({ ...m, forceNext: true }))
    else if (a === 'default' || a === '默认') {
      if (b !== 'on' && b !== 'off' && b !== '开' && b !== '关') return { text: '用法：/intent default on 或 /intent default off' }
      await savePrefs($, { newSession: b === 'on' || b === '开' ? 'on' : 'off' })
    } else if (a) return { text: '用法：/intent [on | off | force | default on|off | ui]' }
    const m = await read($, modeAtom)
    const conn = await read($, connAtom)
    return {
      text: [
        `意图系统 · 本会话：${m.forceNext ? '下一句强制分析' : m.sessionOn ? '开（每句先过门卫）' : '关'} · 新会话默认：${m.defaultOn ? '开' : '关'}`,
        conn === null ? 'intent-lab：连接中…' : conn.reachable ? `intent-lab：${conn.ok ? '正常' : `⚠ ${conn.error}`} · 可召回 ${n(conn.qaVisible)} 条` : `intent-lab 没有运行（${BASE}）`,
        '输入框上方的按钮条也能切换；/intent ui 打开管理页',
      ].join('\n'),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin') return next(e)
    if (e.text.trim().startsWith('/')) return next(e)

    const mode = await read($, modeAtom)
    if (!mode.sessionOn && !mode.forceNext) return next(e)
    const forced = mode.forceNext
    if (forced) {
      await update($, modeAtom, (m) => ({ ...m, forceNext: false, firstForceFromPrefs: false }))
      // 「下一个新会话第一句强制分析」是一次性的：用掉就清
      if (mode.firstForceFromPrefs) await savePrefs($, { firstForce: false })
    }
    if ((await read($, runAtom)) !== null) return { drop: '意图系统还在处理上一句：先在输入框上方确认或取消' }
    const conn = await read($, connAtom)
    if (conn !== null && !conn.reachable) {
      $.ui.toast('intent-lab 没有运行，这句照常发送（没有做意图分析）')
      return next(e)
    }
    if (conn !== null && conn.needsActivation) {
      $.ui.toast('意图系统还没激活：打开管理页输入邀请码（① 激活）后再来')
      return { drop: '意图系统还没激活：点上方「管理」打开管理页，输入邀请码激活（约 1 分钟）' }
    }
    const pw = await refreshPrewarm($)
    if (pwCold(pw)) {
      const now = await $.clock.now()
      await update($, runAtom, () => ({ ...blankRun(e.text, forced, '', now), phase: 'prewarm' }))
      return { drop: '缓存还没预热完：在输入框上方选一下这句怎么处理' }
    }
    void startRun($, e.text, forced)
    return { drop: '意图系统正在召回相关的历史对话：在输入框上方看进度，完成后这句会自动发出' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    /** 输入框不是每种界面都有（手机端没有）：没有就不给改字 / 补背景 */
    const Input = 'Input' in ui ? ui.Input : null
    const mode = await read($, modeAtom)
    const run = await read($, runAtom)
    const last = await read($, lastAtom)
    const conn = await read($, connAtom)
    const sources = await read($, sourcesAtom)
    const prewarm = await read($, prewarmAtom)

    // ---------- 缓存没预热完：这句怎么处理（等待期间每 3 秒在刷，热好了自动翻页） ----------
    if (run !== null && run.phase === 'prewarm') {
      const pw = await read($, prewarmAtom)
      if (!pwCold(pw)) {
        // 等的这一会儿预热完成了（或拦下时覆盖率其实已够）：直接给「现在召回」
        return (
          <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Text bold color="suggestion">✅ 缓存预热完成</Text>
            <Text dimColor>现在召回能命中缓存，速度正常。这句要跑一遍意图召回吗？</Text>
            <Box columnGap={1} marginTop={1} flexWrap="wrap">
              <Button key="pw-now" label="现在召回" variant="primary" onPress={() => void startRun($, run.text, run.forced)} />
              <Button key="pw-send" label="不做意图分析，直接发送" dimColor
                onPress={async () => { await update($, runAtom, () => null); await deliver($, run.text, '') }} />
              <Button key="pw-cancel" label="取消（原话放回）" dimColor
                onPress={async () => { await update($, runAtom, () => null); await $.prompt.fill({ text: run.text }) }} />
            </Box>
          </Box>
        )
      }
      const pct = Math.round(pwPct(pw) * 100)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text bold color="warning">⏳ 缓存还没预热完（{pct}%）</Text>
          <Text dimColor>
            {pwRunning(pw)
              ? `管理页正在预热${pw!.etaMs != null ? `，还要${etaText(pw!.etaMs)}` : ''}。现在召回不命中缓存，会很慢，还会拖慢预热。`
              : '还没开始预热：现在召回不命中缓存，会很慢。预热在管理页「来源」开始（两边同一份进度）。'}
          </Text>
          <Box columnGap={1} marginTop={1} flexWrap="wrap">
            <Button key="pw-send" label="不做意图分析，直接发送" variant="primary"
              onPress={async () => { await update($, runAtom, () => null); await deliver($, run.text, '') }} />
            <Button key="pw-recall" label="仍然召回（会很慢）" onPress={() => void startRun($, run.text, run.forced)} />
            <Button key="pw-open" label="打开管理页看预热" dimColor onPress={openUi} />
            <Button key="pw-cancel" label="取消（原话放回）" dimColor
              onPress={async () => { await update($, runAtom, () => null); await $.prompt.fill({ text: run.text }) }} />
          </Box>
        </Box>
      )
    }

    // ---------- 回答前确认卡 ----------
    if (run !== null && run.phase === 'confirm') {
      const setAsk = (askId: string, fn: (a: Ask) => Ask) => setRun($, (r) => ({ ...r, asks: r.asks.map((a) => (a.askId === askId ? fn(a) : a)) }))
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text bold color="warning">⚠ 回答前先确认</Text>
          <Text dimColor>我把你的问题和下面几段旧对话连了起来，但还没得到你确认。对的点「对」，不对的点「不对」，说法不准就点「改字」。不表态的，这次照样参考，下次再问。</Text>
          {run.asks.map((a) => (
            <Box key={`row:${a.askId}`} flexDirection="column" marginTop={1}>
              <Box columnGap={1} flexWrap="wrap">
                <Button key={`${a.askId}:yes`} label={a.verdict === 'yes' ? '✓ 对' : '对'} variant={a.verdict === 'yes' ? 'primary' : 'secondary'}
                  onPress={() => setAsk(a.askId, (x) => ({ ...x, verdict: x.verdict === 'yes' ? null : 'yes' }))} />
                <Button key={`${a.askId}:no`} label={a.verdict === 'no' ? '✗ 不对' : '不对'} variant={a.verdict === 'no' ? 'primary' : 'secondary'}
                  onPress={() => setAsk(a.askId, (x) => ({ ...x, verdict: x.verdict === 'no' ? null : 'no' }))} />
                <Text dimColor>[{a.slot}]</Text>
                <Text strikethrough={a.verdict === 'no'} bold>{a.edited ?? a.statement}</Text>
                {a.edited !== null && <Text color="suggestion">（你改的说法）</Text>}
                {Input && <Button key={`${a.askId}:edit`} label={a.editing ? '收起' : '改字'} dimColor onPress={() => setAsk(a.askId, (x) => ({ ...x, editing: !x.editing }))} />}
              </Box>
              {a.editing && Input && (
                <Input key={`${a.askId}:input`} label="  改为：" value={a.edited ?? a.statement} submitLabel="保存" autoFocus
                  onSubmit={(v: string) => {
                    const t = v.trim()
                    void setAsk(a.askId, (x) => ({ ...x, edited: t === '' || t === x.statement ? null : t, editing: false }))
                  }} />
              )}
              <Text dimColor>{'      '}{a.when} · {a.title}{a.quote ? ` · “${a.quote}”` : ''}</Text>
            </Box>
          ))}
          {Input && <Box marginTop={1}>
            <Input key="note" label="补充背景：" placeholder="漏了什么？补一句背景…" submitLabel="记下"
              onInput={(v: string) => { noteDraft = v }}
              onSubmit={(v: string) => { noteDraft = v; $.ui.toast('已记下补充背景') }} />
          </Box>}
          <Box justifyContent="space-between" marginTop={1}>
            <Button key="skip-all" label="不确认，直接回答" dimColor onPress={() => submitFeedback($, true)} />
            <Button key="confirm" label="确认并回答" variant="primary" onPress={() => submitFeedback($, false)} />
          </Box>
        </Box>
      )
    }

    // ---------- 出错 ----------
    if (run !== null && run.phase === 'error') {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
          <Text bold color="error">✕ 意图召回失败{run.error?.stage ? ` · 停在 ${run.error.stage}` : ''}</Text>
          <Text>{run.error?.message ?? ''}</Text>
          <Box columnGap={1} marginTop={1}>
            {run.error?.retryable !== false && <Button key="retry" label="↻ 重试（接着上次的进度）" variant="primary" onPress={async () => { const t = run.text; const f = run.forced; const id = run.turnId; await update($, runAtom, () => null); void startRun($, t, f, id) }} />}
            <Button key="send" label="不做意图分析，直接发送" onPress={async () => { await update($, lastAtom, () => finalFrom(run, 'error')); await update($, runAtom, () => null); await deliver($, run.text, '') }} />
            <Button key="drop" label="取消（原话放回输入框）" dimColor onPress={() => cancelRun($, true)} />
          </Box>
        </Box>
      )
    }

    // ---------- 运行卡 ----------
    if (run !== null) {
      const ms = run.now - run.startedAt
      const p = run.progress
      const s3running = run.stages.s3 === 'running' && p !== null
      const eta = s3running && p!.etaMs !== null && p!.done < p!.total ? Math.max(1, Math.round(p!.etaMs! / 60000)) : null
      return (
        <Box flexDirection="column">
          <Box columnGap={1}>
            <Text bold>◆ 意图系统{run.forced ? ' · 补做' : ''}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-end">{run.scene || run.want ? [run.scene, run.want].filter(Boolean).join(' · ') : run.phase === 'sync' ? '同步本机记录…' : ''}</Text>
            </Box>
            <Text dimColor>{run.budgetMs && run.phase === 'running' ? `${clock(ms)} / ${clock(run.budgetMs)}` : clock(ms)}</Text>
            {run.phase !== 'finishing' && <Button key="cancel" label="✕ 取消" dimColor onPress={() => cancelRun($, true)} />}
          </Box>
          <Box flexWrap="wrap" columnGap={2}>
            {cells(run).map((c) => (
              <Box key={`cell:${c.key}`}>
                <Text dimColor={c.status !== 'running'} color={c.status === 'done' ? 'success' : undefined}>{glyph(c.status)} {c.label}</Text>
              </Box>
            ))}
          </Box>
          {s3running && (
            <Box columnGap={2}>
              <Text>{run.step === 2 ? `第二步 · 写理由 ${n(p!.done)}/${n(p!.total)} · 报名 ${n(p!.passed)}` : `第一步 · 打分 ${n(p!.done)}/${n(p!.total)} · 过线 ${n(p!.passed)}`}</Text>
              {eta !== null && <Text dimColor>预计还要 {eta} 分钟</Text>}
            </Box>
          )}
          {s3running && <Text color="suggestion">{bar(p!.total ? p!.done / p!.total : 0)}</Text>}
          {run.stages.s4 === 'running' && run.s4 && <Text dimColor>守门员摘句 · 已写 {run.s4.done} 条 · {n(run.s4.chars)} 字</Text>}
          {run.synced && run.stages.s1 !== 'done' && <Text dimColor>{run.synced}</Text>}
          {run.phase === 'finishing' && <Text dimColor>写上下文，马上把你的原话发出…</Text>}
        </Box>
      )
    }

    // ---------- 空闲：开关 + 连接 / 来源 + 上一问 ----------
    const openUi = () => void $.process.run(['open', `${BASE}/ui`]).catch(() => undefined)
    const unasked = conn?.reachable ? sources.find((s) => s.consent === 'unasked' && s.rowsFound > 0) : undefined
    const importing = sources.filter(jobRunning)
    return (
      <Box flexDirection="column">
        <Box columnGap={1} flexWrap="wrap">
          <Text bold>意图系统</Text>
          <Button key="session" label={mode.sessionOn ? '● 会话：开' : '○ 会话：关'} variant={mode.sessionOn ? 'primary' : 'secondary'}
            onPress={() => update($, modeAtom, (m) => ({ ...m, sessionOn: !m.sessionOn }))} />
          <Button key="force" label={mode.forceNext ? '● 本问：强制分析' : '○ 本问：强制分析'} variant={mode.forceNext ? 'primary' : 'secondary'}
            onPress={() => update($, modeAtom, (m) => ({ ...m, forceNext: !m.forceNext }))} />
          <Text dimColor>{mode.forceNext ? '下一句跳过门卫、必做分析' : mode.sessionOn ? '每句先过门卫' : '不做意图分析'}</Text>
          <Button key="default" label={mode.defaultOn ? '新会话默认：开' : '新会话默认：关'} dimColor
            onPress={async () => {
              const want = mode.defaultOn ? 'off' : 'on'
              await savePrefs($, { newSession: want })
              $.ui.toast(want === 'on' ? '之后的新会话一开局就打开意图系统' : '之后的新会话默认不做意图分析')
            }} />
          <Button key="manage" label="管理" dimColor onPress={openUi} />
        </Box>
        {conn === null ? (
          <Text dimColor>连接 intent-lab…</Text>
        ) : !conn.reachable ? (
          <Box columnGap={1} flexWrap="wrap">
            <Text color="warning">intent-lab 没有运行（{BASE}）：在 intent-lab 目录执行 bun run serve</Text>
            <Button key="reconnect" label="重新连接" dimColor onPress={() => { void refreshHealth($); void refreshSources($) }} />
          </Box>
        ) : unasked ? (
          <Box columnGap={1} flexWrap="wrap">
            <Text color="suggestion">发现 {NAME[unasked.id]} 记录 · {unasked.sessions} 个会话 / {n(unasked.rowsFound)} 条，要一起用于召回吗？</Text>
            <Button key="import" label="导入" variant="primary" onPress={async () => { await call($, '/local/import', { source: unasked.id, mode: 'full' }); await refreshSources($) }} />
            <Button key="decline" label="不要" dimColor onPress={async () => { await call($, '/local/settings', { source: unasked.id, consent: 'no' }); await refreshSources($) }} />
            <Button key="more" label="管理…" dimColor onPress={openUi} />
          </Box>
        ) : (
          <Text dimColor>
            {conn.needsActivation ? '🔑 意图系统还没激活：点「管理」打开管理页，输入邀请码（① 激活） · ' : ''}
            {pwRunning(prewarm) ? `⏳ 缓存预热 ${Math.round(pwPct(prewarm) * 100)}%${prewarm!.etaMs != null ? `（还要${etaText(prewarm!.etaMs)}）` : ''} · ` : pwCold(prewarm) ? '⚠ 缓存没预热完，召回会很慢（进度与开始都在管理页「来源」）· ' : ''}
            {!conn.ok ? `⚠ ${conn.error} · ` : ''}
            可召回 {n(conn.qaVisible)} 条 ·{' '}
            {importing.length
              ? importing.map((s) => `${NAME[s.id]} ${s.job!.phase === 'scan' ? `扫描 ${n(s.job!.filesDone)}/${n(s.job!.filesTotal)}` : `入库 ${n(s.job!.rowsSent)}/${n(s.job!.rowsTotal)}`}`).join(' · ')
              : sources.filter((s) => s.consent === 'yes').map((s) => `${NAME[s.id]} ${s.enabled ? rel(Date.now(), s.lastSyncAt) : '已暂停'}`).join(' · ') || '还没有导入任何来源'}
          </Text>
        )}
        {last !== null && (
          <Box columnGap={1} flexWrap="wrap">
            <Text dimColor color={last.kind === 'error' ? 'error' : last.kind === 'cancelled' ? 'warning' : undefined}>
              {last.kind === 'done' ? '✓' : last.kind === 'skipped' ? '○' : '✕'} 上一问 · {finalLine(last)}
            </Text>
            {last.kind === 'done' && <Button key="detail" label="详情" dimColor onPress={() => void $.ui.open({ id: PANE, title: '意图系统 · 上一问' })} />}
            {last.kind === 'skipped' && !last.forced && <Button key="redo" label="↻ 做一次意图分析" dimColor onPress={() => void startRun($, last.text, true)} />}
          </Box>
        )}
      </Box>
    )
  })

  // ---------- 详情侧栏：上一问 ----------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const last = await read($, lastAtom)
    if (last === null || last.kind !== 'done') return <Box><Text dimColor>还没有完整走完的一问。</Text></Box>
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text bold>{finalLine(last)}</Text>
        {(last.scene || last.want) && <Text dimColor>场景：{last.scene ?? ''} · 诉求：{last.want ?? ''}</Text>}
        {last.summary && <Text>{last.summary}</Text>}
        {last.asks.length > 0 && (
          <Box flexDirection="column">
            <Text>问了你 {last.asks.length} 条{last.note ? ` · ${last.note}` : ''}</Text>
            {last.asks.map((a) => (
              <Box key={`pask:${a.askId}`}>
                <Text dimColor>[{a.slot}] {a.statement}{a.edited ? ` → ${a.edited}（你改的说法）` : ''} · {a.verdict === 'yes' ? '对' : a.verdict === 'no' ? '不对' : '不表态'}</Text>
              </Box>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <Text>选中 {last.selectedCount} 条{last.selected.length < last.selectedCount ? `（列出 ${last.selected.length} 条）` : ''}</Text>
          {last.selected.map((s, i) => (
            <Box key={`psel:${i}`} flexDirection="column">
              <Text dimColor>{s.when} · {s.title} · {s.slots}</Text>
              <Text>  {s.human}</Text>
              {s.connection && <Text dimColor>  连接：{s.connection}</Text>}
            </Box>
          ))}
        </Box>
        <Text dimColor>完整记录在管理页「召回记录」（/intent 打开）</Text>
      </Box>
    )
  })
}
