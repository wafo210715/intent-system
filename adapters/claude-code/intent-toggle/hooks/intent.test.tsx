import { describe, expect, mock, test } from 'claude-code/testing'

/**
 * 用测试自己的 process.run / process.spawn 假扮 intent-lab：
 * /health、/local/sources、/local/import、/feedback 走 run（curl 一次性），/recall 走 spawn（curl 流式）。
 */
const health = { value: { ok: true, contract: 6, qaVisible: 1709, swarm: { model: 'deepseek-flash' } } as any }
const baseHealth = health.value
const sources = {
  ok: true,
  sources: [
    { id: 'claude', consent: 'yes', enabled: true, sessions: 16, rowsFound: 174, rowsStored: 116, rowsActive: 116, lastSyncAt: 0, job: null },
    { id: 'codex', consent: 'unasked', enabled: true, sessions: 242, rowsFound: 1688, rowsStored: 0, rowsActive: 0, lastSyncAt: null, job: null },
  ],
}
const recallEvents = [
  { type: 'accepted', runId: 'r-1', qaTotal: 1709, budgetMs: 300000, startedAt: 0 },
  { type: 'stage', stage: 'gate', status: 'start', round: 1 },
  { type: 'stage', stage: 'gate', status: 'done', round: 1, ms: 800 },
  { type: 'gate', needIntent: true, why: '在问一个具体决定', forced: false },
  { type: 'intent', scene: '在改意图系统的插件', want: '确认接入方式' },
  { type: 'progress', stage: 's3', round: 1, step: 1, done: 1709, total: 1709, passed: 40, etaMs: null },
  { type: 'review', summary: '会用到上次的分发讨论', selected: [{ qaId: 'q1', when: '10-04 10:00', title: '分发', slots: ['同一件事'], score: 0.9, human: '内测怎么分发', connection: '同一件事' }],
    ask: [{ askId: 'a1', qaId: 'q2', slot: '同一目的', statement: '你想先给朋友内测', when: '10-04', title: '分发', quote: '给朋友用' }], askRemaining: 0, retried: false },
  { type: 'done', runId: 'r-1', injection: '<intent_context>全部不表态</intent_context>', needsFeedback: true, timing: { totalMs: 5000 } },
]

function fakeLab(on: any, log: string[], events: unknown[] = recallEvents) {
  apps.value = { claude: false, codex: false }
  prewarm.value = { available: false }
  on('env.get', async () => ({ value: undefined }))
  on('process.run', async ($: any, e: any) => {
    const url = String(e.argv.find((a: string) => a.startsWith('http')))
    const path = url.replace(/^http:\/\/127\.0\.0\.1:8723/, '')
    log.push(`run ${path}${e.init?.stdin ? ` ${e.init.stdin}` : ''}`)
    const body =
      path === '/health' ? health.value
      : path === '/local/sources' ? sources
      : path === '/local/prewarm' ? { ok: true, prewarm: prewarm.value }
      : path === '/local/apps' ? (e.init?.stdin ? (apps.value = { ...apps.value, ...JSON.parse(e.init.stdin) }, { ok: true, apps: apps.value }) : { ok: true, apps: apps.value })
      : path === '/feedback' ? { ok: true, injection: '<intent_context>按表态重建</intent_context>', context: { notice: '上下文文件已按你的表态更新' } }
      : { ok: true }
    return { value: { exitCode: 0, stdout: `${JSON.stringify(body)}\n200`, stderr: '' } }
  })
  on('process.spawn', async function* ($: any, e: any) {
    log.push(`spawn ${e.input}`)
    for (const ev of events) yield { stream: 'stdout', text: JSON.stringify(ev) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.start', async ($: any, e: any) => ({ cwd: e.cwd ?? '/tmp' }))
}

const apps = { value: { claude: false, codex: false } as any }
const prewarm = { value: { available: false } as any }
const props = { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100 }

describe('意图系统插件', () => {
  test('开关打开后：拦下提问 → 召回 → 确认卡 → 表态 → 带 context 重新发出', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const session = mock.session(on)
    const log: string[] = []
    fakeLab(on, log)
    const delivered: any[] = []
    on('prompt.submit', async ($: any, e: any) => {
      delivered.push(e)
      return { text: e.text, context: e.context }
    })
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'intent-toggle', surface: 'desktop', component: 'AbovePrompt', props } as any)
    expect((await ui.find({ key: 'session' }))?.text).toContain('会话：关')
    // 首次发现 Codex：给导入提示
    expect(await ui.find({ key: 'import' })).toBeDefined()

    await ui.press({ key: 'session' })
    expect((await ui.find({ key: 'session' }))?.text).toContain('会话：开')

    const r = await $.prompt.submit({ text: '插件该怎么接入？', wait: false } as any)
    expect((r as any).drop).toContain('意图系统')
    for (let i = 0; i < 20 && !(await ui.find({ key: 'confirm' })); i++) await clock.advance(300)

    // 召回前先同步已同意的 Claude；/recall 带上原话与会话 id
    if (!log.some((l) => l.includes('/local/import'))) console.log(log.join('\n'))
    expect(log.join('\n')).toContain('/local/import {"source":"claude"')
    const spawned = log.find((l) => l.startsWith('spawn'))!
    expect(JSON.parse(spawned.slice(6))).toMatchObject({ sessionId: 'claude-S1', q: '插件该怎么接入？' })

    // 确认卡：点「对」再确认
    expect(await ui.find({ text: /回答前先确认/ })).toBeDefined()
    await ui.press({ key: 'a1:yes' })
    await ui.press({ key: 'confirm' })
    await clock.settle()

    const fb = log.find((l) => l.startsWith('run /feedback'))!
    expect(JSON.parse(fb.slice('run /feedback '.length))).toMatchObject({ runId: 'r-1', answers: [{ askId: 'a1', verdict: 'yes' }] })
    // 按表态重建的召回结果先作为「模型读、界面不显示」的一行追加进对话，再把原话重新发出
    const rows = session.appended()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0]!.message)).toContain('<intent_context>按表态重建</intent_context>')
    const last = delivered[delivered.length - 1]
    expect(last.text).toBe('插件该怎么接入？')
    expect(last.origin).toMatchObject({ kind: 'plugin', asUser: true })
    expect((await ui.find({ key: 'detail' }))).toBeDefined()
  })

  test('开关关着：提问原样放行，不调 intent-lab 的召回', async ($, on) => {
    mock.clock(on, { now: 0 })
    const log: string[] = []
    fakeLab(on, log)
    on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
    const r = await $.prompt.submit({ text: '随便问问', wait: false } as any)
    expect((r as any).drop).toBeUndefined()
    expect(log.some((l) => l.startsWith('spawn'))).toBe(false)
  })

  const setup = async ($: any, on: any, events: unknown[]) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const session = mock.session(on)
    const log: string[] = []
    fakeLab(on, log, events)
    const delivered: any[] = []
    on('prompt.submit', async ($: any, e: any) => { delivered.push(e); return { text: e.text } })
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'intent-toggle', surface: 'terminal', component: 'AbovePrompt', props } as any)
    await ui.press({ key: 'session' })
    await $.prompt.submit({ text: '好的', wait: false } as any)
    for (let i = 0; i < 10; i++) await clock.advance(300)
    return { ui, session, delivered, log }
  }

  test('门卫跳过：原话直接发出、不附上下文，上一问给「做一次意图分析」', async ($, on) => {
    const { ui, session, delivered } = await setup($, on, [
      { type: 'accepted', runId: 'r-2', qaTotal: 10, budgetMs: 1000, startedAt: 0 },
      { type: 'gate', needIntent: false, why: '寒暄', forced: false },
      { type: 'done', runId: 'r-2', injection: '', needsFeedback: false, skipped: 'gate', gateWhy: '寒暄', timing: { totalMs: 300 } },
    ])
    expect(session.appended()).toHaveLength(0)
    expect(delivered.map((d: any) => d.text)).toContain('好的')
    expect((await ui.find({ key: 'redo' }))?.text).toContain('做一次意图分析')
  })

  test('召回出错：按钮条显示原因与重试，不自动发出', async ($, on) => {
    const { ui, delivered } = await setup($, on, [
      { type: 'accepted', runId: 'r-3', qaTotal: 10, budgetMs: 1000, startedAt: 0 },
      { type: 'error', stage: 's3', message: 'S3 有 41 / 812 次调用失败', retryable: true, elapsedMs: 100 },
    ])
    expect(await ui.find({ text: /S3 有 41/ })).toBeDefined()
    expect(await ui.find({ key: 'retry' })).toBeDefined()
    expect(delivered.filter((d: any) => d.origin?.kind === 'plugin')).toHaveLength(0)
    await ui.press({ key: 'send' })
    expect(delivered.some((d: any) => d.origin?.kind === 'plugin' && d.text === '好的')).toBe(true)
  })

  test('新会话偏好：开局就按偏好设开关，第一句不用先看到按钮条就走意图系统；一次性强制用掉即清', async ($, on) => {
    const clock = mock.clock(on, { now: 5_000_000 })
    mock.session(on)
    const log: string[] = []
    fakeLab(on, log)
    mock.store(on, { prefs: { newSession: 'on', firstForce: true } })
    apps.value = { claude: true, codex: false }
    on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    // 没有 mount 按钮条：直接发第一句
    const r = await $.prompt.submit({ text: '第一句就要召回', wait: false } as any)
    expect((r as any).drop).toContain('意图系统')
    for (let i = 0; i < 5; i++) await clock.advance(300)
    const spawned = log.find((l) => l.startsWith('spawn'))!
    expect(JSON.parse(spawned.slice(6))).toMatchObject({ q: '第一句就要召回', force: true })
    // 一次性的强制用掉了：再开一个会话，默认仍开，但第一句不再强制
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    const r2 = await $.command.run({ command: 'intent', args: '' } as any)
    expect((r2 as any).text).toContain('本会话：开（每句先过门卫）')
    expect((r2 as any).text).toContain('新会话默认：开')
  })

  test('/intent 作为新对话的第一个输入：不发给模型，能切本会话开关与新会话默认', async ($, on) => {
    mock.clock(on, { now: 0 })
    mock.store(on)
    fakeLab(on, [])
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    const r1 = await $.command.run({ command: 'intent', args: 'on' } as any)
    expect((r1 as any).text).toContain('本会话：开')
    const r2 = await $.command.run({ command: 'intent', args: 'default on' } as any)
    expect((r2 as any).text).toContain('新会话默认：开')
    // 存下了：新会话开局就是开
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    await $.command.run({ command: 'intent', args: 'off' } as any)
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    expect(((await $.command.run({ command: 'intent', args: '' } as any)) as any).text).toContain('本会话：开')
  })

  test('管理页概览的 Claude Code 开关决定新会话开局；按钮条改「新会话默认」也写回服务端', async ($, on) => {
    mock.clock(on, { now: 0 })
    mock.store(on)
    const log: string[] = []
    fakeLab(on, log)
    apps.value = { claude: true, codex: false }
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    expect(((await $.command.run({ command: 'intent', args: '' } as any)) as any).text).toContain('本会话：开（每句先过门卫）')
    await $.command.run({ command: 'intent', args: 'default off' } as any)
    expect(apps.value.claude).toBe(false)
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    expect(((await $.command.run({ command: 'intent', args: '' } as any)) as any).text).toContain('本会话：关')
  })

  test('未激活：提问被拦下提示先激活（附管理页指引），不进召回流程', async ($, on) => {
    const clock = mock.clock(on, { now: 12_000_000 })
    mock.session(on)
    mock.store(on)
    const log: string[] = []
    fakeLab(on, log)
    health.value = { ok: false, needsActivation: true, error: '还没有我们服务器的授权：先在管理页「设置」里输入邀请码激活' }
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    const ui = await $.ui.mount({ plugin: 'intent-toggle', surface: 'desktop', component: 'AbovePrompt', props } as any)
    await ui.press({ key: 'session' })
    const r = await $.prompt.submit({ text: '还没激活这句', wait: false } as any)
    expect((r as any).drop).toContain('还没激活')
    expect(await ui.find({ text: /还没激活/ })).toBeDefined()
    expect(log.some((l) => l.startsWith('spawn'))).toBe(false) // 不进召回
    health.value = baseHealth
  })

  test('缓存没预热完：提问先出卡问一句；直接发送不召回，仍然召回才召回', async ($, on) => {
    const clock = mock.clock(on, { now: 7_000_000 })
    mock.session(on)
    mock.store(on)
    const log: string[] = []
    fakeLab(on, log)
    prewarm.value = { available: true, phase: 'running', done: 100, total: 1000, coverage: { segs: 1000, warmed: 100 }, etaMs: 3_000_000 }
    const delivered: any[] = []
    on('prompt.submit', async ($: any, e: any) => { delivered.push(e); return { text: e.text } })
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    const ui = await $.ui.mount({ plugin: 'intent-toggle', surface: 'desktop', component: 'AbovePrompt', props } as any)
    await ui.press({ key: 'session' })

    const r = await $.prompt.submit({ text: '先问一句', wait: false } as any)
    expect((r as any).drop).toContain('缓存还没预热完')
    expect(await ui.find({ text: /缓存还没预热完（10%）/ })).toBeDefined()
    expect(log.some((l) => l.startsWith('spawn'))).toBe(false)
    await ui.press({ key: 'pw-send' })
    expect(delivered.some((d: any) => d.origin?.kind === 'plugin' && d.text === '先问一句')).toBe(true)
    expect(log.some((l) => l.startsWith('spawn'))).toBe(false)

    await $.prompt.submit({ text: '再问一句', wait: false } as any)
    await ui.press({ key: 'pw-recall' })
    for (let i = 0; i < 5; i++) await clock.advance(300)
    expect(log.some((l) => l.startsWith('spawn') && l.includes('再问一句'))).toBe(true)
  })

  test('等预热期间预热完成了：卡片翻成「预热已完成」，点「现在召回」就把这句跑掉', async ($, on) => {
    const clock = mock.clock(on, { now: 8_000_000 })
    mock.session(on)
    mock.store(on)
    const log: string[] = []
    fakeLab(on, log)
    // 拦下时还冷着 → 卡片出现；随后预热完成（3 秒轮询刷到）→ 卡片翻页
    prewarm.value = { available: true, phase: 'running', done: 100, total: 1000, coverage: { segs: 1000, warmed: 100 }, etaMs: 600_000 }
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    const ui = await $.ui.mount({ plugin: 'intent-toggle', surface: 'desktop', component: 'AbovePrompt', props } as any)
    await ui.press({ key: 'session' })
    const r = await $.prompt.submit({ text: '热好了这句', wait: false } as any)
    expect((r as any).drop).toContain('缓存还没预热完')
    expect(await ui.find({ text: /缓存还没预热完/ })).toBeDefined()
    prewarm.value = { available: true, phase: 'done', done: 1000, total: 1000, coverage: { segs: 1000, warmed: 1000 }, etaMs: null }
    for (let i = 0; i < 4; i++) await clock.advance(1000)
    expect(await ui.find({ text: /缓存预热完成/ })).toBeDefined()
    await ui.press({ key: 'pw-now' })
    for (let i = 0; i < 5; i++) await clock.advance(300)
    expect(log.some((l) => l.startsWith('spawn') && l.includes('热好了这句'))).toBe(true)
  })

  test('召回中断不再一直卡着：插件重新加载 → 标中断给重试；45 秒没有任何事件 → 标断开', async ($, on) => {
    const clock = mock.clock(on, { now: 9_000_000 })
    mock.session(on)
    mock.store(on)
    let release = () => {}
    const hang = new Promise<void>((r) => { release = r })
    on('process.run', async ($: any, e: any) => {
      const url = String(e.argv.find((a: string) => a.startsWith('http')))
      const path = url.replace(/^http:\/\/127\.0\.0\.1:8723/, '')
      const body = path === '/health' ? health.value : path === '/local/sources' ? sources : { ok: true }
      return { value: { exitCode: 0, stdout: `${JSON.stringify(body)}\n200`, stderr: '' } }
    })
    const sent: any[] = []
    on('process.spawn', async function* ($: any, e: any) {
      sent.push(JSON.parse(e.input))
      yield { stream: 'stdout', text: JSON.stringify({ type: 'accepted', runId: 'r-h', qaTotal: 9, budgetMs: 1000, startedAt: 0 }) + '\n' }
      yield { stream: 'stdout', text: JSON.stringify({ type: 'progress', stage: 's3', round: 1, step: 2, done: 468, total: 468, passed: 342, etaMs: null }) + '\n' }
      await hang // 之后再也没有输出
      return { value: { code: 0, signal: null } }
    })
    on('session.id', async () => ({ value: 'S1' }))
    on('command.register', async () => ({ value: undefined }))
    on('ui.toast', async () => ({ value: undefined }))
    on('env.get', async () => ({ value: undefined }))
    on('session.start', async ($: any, e: any) => ({ cwd: e.cwd ?? '/tmp' }))
    on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
    try {
      await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
      const ui = await $.ui.mount({ plugin: 'intent-toggle', surface: 'desktop', component: 'AbovePrompt', props } as any)
      await ui.press({ key: 'session' })
      await $.prompt.submit({ text: '会卡住的一句', wait: false } as any)
      for (let i = 0; i < 5; i++) await clock.advance(300)
      expect(await ui.find({ text: /写理由 468\/468/ })).toBeDefined()

      // 45 秒没有任何事件：看门狗标断开，给重试
      await clock.advance(46_000)
      expect(await ui.find({ text: /45 秒没有任何输出/ })).toBeDefined()
      expect(await ui.find({ key: 'retry' })).toBeDefined()

      // 再来一次，这回模拟插件重新加载（session.start 再跑一遍）
      await ui.press({ key: 'retry' })
      for (let i = 0; i < 5; i++) await clock.advance(300)
      expect(await ui.find({ text: /写理由 468\/468/ })).toBeDefined()
      // 重试沿用同一个 turnId：服务端断点认得出是同一问，已做完的部分直接复用
      expect(sent).toHaveLength(2)
      expect(sent[1].turnId).toBe(sent[0].turnId)
      expect(sent[1].q).toBe('会卡住的一句')
      await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
      await clock.settle()
      expect(await ui.find({ text: /插件刚重新加载/ })).toBeDefined()
    } finally {
      release()
      await clock.advance(10) // 让挂着的流在测试结束前收尾
    }
  })
})

