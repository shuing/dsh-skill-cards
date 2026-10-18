/**
 * BEHAVIOURAL test for cross-session isolation of the HOST routes.
 *
 * The user-visible complaint was "各个会话单独还是会窜" — state from one chat
 * showing up in another. The source of it was not the per-session registries
 * (those are keyed correctly) but the two GUESSES the host made when a request
 * did not name a session:
 *
 *   1. `ActiveSessionTracker.current()` returned `agents.list()[0]` — the first
 *      live agent in registration order. From a given window's point of view that
 *      is a random other session, and every write route (introduce / switch /
 *      revoke) then mutated it. The bleed was not read-only.
 *   2. `/skills` and `/applied` fell back to the legacy machine-wide `_disabled`
 *      list, so a chat that had never touched its switch inherited another
 *      chat's greys.
 *
 * The contract now: a request that cannot name its session is REFUSED (400) or
 * answered as empty — never redirected onto another session. These tests drive
 * the real `apply()` with a fake web server, a fake agents service and two live
 * agents, so a regression that reintroduces an election is caught as behaviour
 * rather than as a shape.
 *
 * Run: node --test test/host-session-contract.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** A throwaway DSH home holding one installable skill. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sc-host-'))
  const dir = join(home, 'skills', 'alpha')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\n# body\n')
  return home
}

/**
 * A fake host context: a web server that records its handler, a fake agents
 * service holding two live agents, and a Cordis-like `ctx` that keeps the
 * `apply`/`on`/`effect`/`inject` surface the plugin uses.
 */
function fakeHost({ agents, turnProjection = true }) {
  let handler
  const listeners = new Map()
  const skillsCalls = []
  // The session log's own turn counter. `turnProjection: false` simulates a host
  // where `sessionProjections` is unavailable, which is the case the release
  // must survive by falling back to the event clock.
  const turns = new Map()
  // Sessions with an OPEN turn (`turn/start` seen, `turn/end` not yet).
  const openTurns = new Set()
  const makeSkills = (agentId) => ({
    register(skill) {
      skillsCalls.push({ agent: agentId, op: 'register', name: skill.name })
      return () => { skillsCalls.push({ agent: agentId, op: 'unregister', name: skill.name }) }
    },
    registerProvider(create) {
      create({ signal: { aborted: false }, invalidate() {} })
      return () => {}
    },
  })
  const agentFor = (id) => ({
    id,
    session: { id },
    ctx: { get: (n) => (n === 'skills' ? makeSkills(id) : undefined) },
  })
  const live = new Map(agents.map((id) => [id, agentFor(id)]))
  const agentsService = {
    get: (id) => live.get(id),
    list: () => [...live.values()],
  }
  const projections = turnProjection
    ? {
      stateOf: (session) => ({
        lastTurn: turns.get(session?.id) ?? 0,
        // A turn is OPEN between `turn/start` and `turn/end`. The default is
        // "no open turn", which is the state a settled session sits in.
        openTurnStartSeq: openTurns.has(session?.id) ? 1 : null,
      }),
    }
    : undefined
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (n) => {
      if (n === 'agents') return agentsService
      if (n === 'sessionProjections') return projections
      return undefined
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(_deps, fn) { fn(ctx) },
    webServer: {
      register(def) { handler = def.handler; return () => {} },
    },
  }
  return {
    ctx,
    skillsCalls,
    listeners,
    /** Advance one session's log turn counter, as a real turn would. */
    beginTurn(sessionId) {
      turns.set(sessionId, (turns.get(sessionId) ?? 0) + 1)
    },
    /** Mark a turn as still in flight (`turn/start` without `turn/end`). */
    openTurn(sessionId) {
      openTurns.add(sessionId)
    },
    /** Close the open turn (`turn/end`). */
    endTurn(sessionId) {
      openTurns.delete(sessionId)
    },
    /** Fire one scoped event at every registered listener. */
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
    /** Drive one HTTP request through the plugin's real handler. */
    async request(method, path, body) {
      assert.ok(handler, 'the plugin must register an HTTP handler')
      const url = new URL(`http://localhost/plugins/dsh-skill-cards/${path}`)
      const req = {
        method,
        url: url.pathname + url.search,
        headers: { host: 'localhost', 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body))
        },
      }
      const chunks = []
      const res = {
        headersSent: false,
        statusCode: 0,
        headers: {},
        writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; this.headersSent = true },
        write(c) { chunks.push(Buffer.from(c)) },
        end(c) { if (c) chunks.push(Buffer.from(c)) },
      }
      await handler(req, res)
      const text = Buffer.concat(chunks).toString('utf8')
      let json
      try { json = JSON.parse(text) } catch { json = undefined }
      return { status: res.statusCode, json, text }
    },
  }
}

test('a write route refuses a request that names no session (never elects one)', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t1a', 'session-t1b'] })
    apply(host.ctx)

    for (const [route, body] of [
      ['introduce', { names: ['alpha'], mode: 'turn' }],
      ['switch', { names: ['alpha'], enabled: false }],
      ['revoke', { names: ['alpha'] }],
    ]) {
      const res = await host.request('POST', route, body)
      assert.equal(res.status, 400,
        `${route} without sessionId must be refused, not aimed at another chat`)
      assert.match(res.json?.error ?? '', /sessionId/,
        `${route} must say what is missing`)
    }
    // Nothing may have been registered into either live agent.
    assert.deepEqual(host.skillsCalls, [],
      'a refused request must not touch any session\'s registrations')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a named session is the ONLY one mutated', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t2a', 'session-t2b'] })
    apply(host.ctx)

    const res = await host.request('POST', 'introduce', {
      sessionId: 'session-t2a', names: ['alpha'], mode: 'turn',
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json?.results?.map((r) => [r.name, r.ok]), [['alpha', true]])

    // Every registration landed on A and none on B.
    const touched = new Set(host.skillsCalls.map((c) => c.agent))
    assert.deepEqual([...touched], ['session-t2a'],
      'the apply must be registered on the named session only')

    // /applied answers per session, and B sees nothing.
    const a = await host.request('GET', 'applied?sessionId=session-t2a')
    const b = await host.request('GET', 'applied?sessionId=session-t2b')
    assert.deepEqual(a.json?.skills, ['alpha'])
    assert.deepEqual(b.json?.skills, [])
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('/applied without a session answers empty instead of another chat\'s set', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t3a'] })
    apply(host.ctx)
    await host.request('POST', 'introduce', {
      sessionId: 'session-t3a', names: ['alpha'], mode: 'turn',
    })

    const bare = await host.request('GET', 'applied')
    assert.equal(bare.status, 200)
    assert.deepEqual(bare.json?.skills, [],
      'an id-less /applied must not answer with a live session\'s skills')
    assert.equal(bare.json?.noSession, true,
      'it must say WHY it is empty, so the client can tell "none" from "unknown"')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('/skills without a session does not inherit the legacy machine-wide greys', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // A pre-upgrade machine-wide "alpha is off" choice.
    const statsPath = join(home, 'skill-cards-stats.json')
    writeFileSync(statsPath, JSON.stringify({ _disabled: { alpha: false } }), 'utf8')

    const host = fakeHost({ agents: ['session-t4a'] })
    apply(host.ctx)

    const bare = await host.request('GET', 'skills')
    assert.equal(bare.status, 200)
    const alpha = bare.json?.skills?.find((s) => s.name === 'alpha')
    assert.equal(alpha?.enabled, true,
      'an id-less /skills must not report another chat\'s leftover "off"')
    assert.equal(bare.json?.noSession, true, 'it must declare that it has no session')

    // A NAMED session still inherits the legacy seed exactly once, which is the
    // migration promise: existing choices are preserved, not dropped.
    const named = await host.request('GET', 'skills?sessionId=session-t4a')
    const namedAlpha = named.json?.skills?.find((s) => s.name === 'alpha')
    assert.equal(namedAlpha?.enabled, false,
      'a named session must still inherit the legacy seed on first touch')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('the turn clock advances on every running edge, so a mid-turn apply survives', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t5a'] })
    apply(host.ctx)
    const agentA = host.ctx.get('agents').get('session-t5a')

    // Apply while the agent is ALREADY running: this turn has read its catalog,
    // so it cannot be the turn the apply was meant for. A real running edge is
    // also a `turn/start` in the log, so both clocks advance together here.
    host.beginTurn('session-t5a')
    host.emit('agent/status', { agent: agentA, status: 'running' })
    await host.request('POST', 'introduce', {
      sessionId: 'session-t5a', names: ['alpha'], mode: 'turn',
    })
    // That turn ends. The hold must NOT be spent: no NEW turn has begun since
    // the apply, so the log clock is still at its apply-time value.
    host.emit('agent/status', { agent: agentA, status: 'idle' })
    let applied = await host.request('GET', 'applied?sessionId=session-t5a')
    assert.deepEqual(applied.json?.skills, ['alpha'],
      'a hold taken mid-turn must survive that turn\'s idle edge')

    // The NEXT turn is the one the apply belongs to; its end spends the hold.
    host.beginTurn('session-t5a')
    host.emit('agent/status', { agent: agentA, status: 'running' })
    host.emit('agent/status', { agent: agentA, status: 'idle' })
    applied = await host.request('GET', 'applied?sessionId=session-t5a')
    assert.deepEqual(applied.json?.skills, [],
      'the turn that started after the apply must spend the hold')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('an idle edge with no turn in between never spends a hold', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t6a'] })
    apply(host.ctx)
    const agentA = host.ctx.get('agents').get('session-t6a')

    await host.request('POST', 'introduce', {
      sessionId: 'session-t6a', names: ['alpha'], mode: 'turn',
    })
    // A maintenance phase (compaction, title job) flips to idle with no turn.
    host.emit('agent/status', { agent: agentA, status: 'idle' })
    const applied = await host.request('GET', 'applied?sessionId=session-t6a')
    assert.deepEqual(applied.json?.skills, ['alpha'],
      'a maintenance idle must not burn the apply the user is about to send')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a disposed agent drops its hold and registrations', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t7a'] })
    apply(host.ctx)
    const agentA = host.ctx.get('agents').get('session-t7a')

    await host.request('POST', 'introduce', {
      sessionId: 'session-t7a', names: ['alpha'], mode: 'turn',
    })
    host.emit('agent/disposed', { agent: agentA })

    const applied = await host.request('GET', 'applied?sessionId=session-t7a')
    assert.deepEqual(applied.json?.skills, [], 'the registration must die with the agent')
    assert.deepEqual(applied.json?.pending, [], 'the hold must die with the agent')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a turn-scoped apply clears after the message; a session-scoped one stays', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t8a'] })
    apply(host.ctx)

    // Two skills, applied with the two different scopes in ONE request pair.
    await host.request('POST', 'introduce', {
      sessionId: 'session-t8a', names: ['alpha'], mode: 'turn',
    })
    await host.request('POST', 'introduce', {
      sessionId: 'session-t8a', names: ['alpha'], mode: 'session',
    })
    let applied = await host.request('GET', 'applied?sessionId=session-t8a')
    assert.deepEqual(applied.json?.skills, ['alpha'])
    assert.equal(applied.json?.modes?.alpha, 'session',
      'the last apply wins the mode label')

    // A DIFFERENT case: two skills, one per scope, so the split is observable.
    const host2 = fakeHost({ agents: ['session-t8b'] })
    apply(host2.ctx)
    await host2.request('POST', 'introduce', {
      sessionId: 'session-t8b', names: ['alpha'], mode: 'turn',
    })
    // Before any turn happens the turn-scoped apply must still be live.
    let now = await host2.request('GET', 'applied?sessionId=session-t8b')
    assert.deepEqual(now.json?.skills, ['alpha'],
      'an unsent apply must not be dropped by a poll')

    // The user sends, and the turn runs: the log turn counter advances.
    host2.beginTurn('session-t8b')
    now = await host2.request('GET', 'applied?sessionId=session-t8b')
    assert.deepEqual(now.json?.skills, [],
      'THE CONTRACT: a turn-scoped apply clears after its message')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a session-scoped apply survives turn after turn', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t9a'] })
    apply(host.ctx)
    await host.request('POST', 'introduce', {
      sessionId: 'session-t9a', names: ['alpha'], mode: 'session',
    })
    for (let i = 1; i <= 3; i += 1) {
      host.beginTurn('session-t9a')
      const applied = await host.request('GET', 'applied?sessionId=session-t9a')
      assert.deepEqual(applied.json?.skills, ['alpha'],
        `a session-scoped apply must survive turn ${i}`)
      assert.equal(applied.json?.modes?.alpha, 'session')
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('the release still works when the turn projection is unavailable', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // A host with no `sessionProjections` service: the log clock is unavailable,
    // so the release must fall back to the status-event clock instead of
    // silently never firing.
    const host = fakeHost({ agents: ['session-t10a'], turnProjection: false })
    apply(host.ctx)
    const agentA = host.ctx.get('agents').get('session-t10a')

    await host.request('POST', 'introduce', {
      sessionId: 'session-t10a', names: ['alpha'], mode: 'turn',
    })
    host.emit('agent/status', { agent: agentA, status: 'running' })
    host.emit('agent/status', { agent: agentA, status: 'idle' })

    const applied = await host.request('GET', 'applied?sessionId=session-t10a')
    assert.deepEqual(applied.json?.skills, [],
      'without a log clock, the running→idle edge must still spend the hold')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a turn that is STILL RUNNING must not lose its skills', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t11a'] })
    apply(host.ctx)
    await host.request('POST', 'introduce', {
      sessionId: 'session-t11a', names: ['alpha'], mode: 'turn',
    })

    // The user sends. `turn/start` logs immediately, long before the turn
    // assembles its system prompt and skill catalog.
    host.beginTurn('session-t11a')
    host.openTurn('session-t11a')

    // The client polls while the model is still working. Releasing here would
    // strip the skills before the model ever saw them — "撤太快了技能都没注入".
    let applied = await host.request('GET', 'applied?sessionId=session-t11a')
    assert.deepEqual(applied.json?.skills, ['alpha'],
      'an open turn must keep its turn-scoped skills for the whole turn')
    assert.deepEqual(applied.json?.pending, ['alpha'],
      'the hold is still unspent while the turn runs')

    // A second poll mid-turn must not release either.
    applied = await host.request('GET', 'applied?sessionId=session-t11a')
    assert.deepEqual(applied.json?.skills, ['alpha'], 'still holding mid-turn')

    // `turn/end`: now the turn is over and the hold can be spent.
    host.endTurn('session-t11a')
    applied = await host.request('GET', 'applied?sessionId=session-t11a')
    assert.deepEqual(applied.json?.skills, [],
      'once the turn ends, the turn-scoped apply clears')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('the release waits for the turn to END, not merely to start', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t12a'] })
    apply(host.ctx)
    await host.request('POST', 'introduce', {
      sessionId: 'session-t12a', names: ['alpha'], mode: 'turn',
    })

    // Start the turn: the counter advances immediately.
    host.beginTurn('session-t12a')
    host.openTurn('session-t12a')
    assert.deepEqual(
      (await host.request('GET', 'applied?sessionId=session-t12a')).json?.skills,
      ['alpha'],
      'a turn that has started but not ended must not release',
    )

    // End it: now release.
    host.endTurn('session-t12a')
    assert.deepEqual(
      (await host.request('GET', 'applied?sessionId=session-t12a')).json?.skills,
      [],
      'a finished turn releases the hold',
    )
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a turn-scoped apply is NOT dropped before any turn starts', async () => {
  const home = fixture()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = fakeHost({ agents: ['session-t13a'] })
    apply(host.ctx)
    await host.request('POST', 'introduce', {
      sessionId: 'session-t13a', names: ['alpha'], mode: 'turn',
    })
    // Poll several times with no turn at all: the user has not sent yet.
    for (let i = 0; i < 3; i += 1) {
      const applied = await host.request('GET', 'applied?sessionId=session-t13a')
      assert.deepEqual(applied.json?.skills, ['alpha'],
        'an apply the user has not sent must never be dropped by a poll')
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})
