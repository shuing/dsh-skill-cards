/**
 * Regression test for the "apply → this turn" contract.
 *
 * "应用只对下一条消息生效" needs a boundary that is (a) AFTER the turn that
 * consumed the skills finished, and (b) BEFORE the next turn assembles its
 * skill catalog. Two obvious candidates both fail:
 *
 *   - Watching the draft go empty: late AND unreliable. The host only clears
 *     the editor on `submit-settled` with `ev.ok`, i.e. after the turn is
 *     accepted, and it keeps the text while the turn is in flight.
 *   - Revoking on the send gesture (Enter / the primary button): can land
 *     BEFORE the agent read the catalog for that turn. That is the bug this
 *     file exists to prevent — the user applies, sends, and the turn runs
 *     WITHOUT the skill.
 *
 * The release is therefore driven by `agent/status` → 'idle' on the host: the
 * apply is HELD across the turn that uses it and released the moment that turn
 * ends. `running` means a turn is in flight, so nothing is released while the
 * agent is still working — a long turn cannot lose its skills mid-flight.
 *
 * THE SUBSCRIPTION ITSELF IS THE REGRESSION THIS FILE GUARDS. The first version
 * called `agents.on(...)`, but `AgentRegistry extends Service` and `Service` has
 * no `on()`, so every guard (`typeof agents.on === 'function'`) was false and
 * the turn-end release never registered at all — the apply simply stayed for the
 * rest of the session. Agent lifecycle is a Cordis EVENT dispatched on `ctx`, so
 * the subscription must be `ctx.on('agent/status', …)`, exactly as the built-in
 * plugins (`dsh-goal`, `dsh-compaction-basic`) do it.
 *
 * Run: node --test test/turn-apply.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientSrc = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

/**
 * Source with comments removed.
 *
 * Several assertions below forbid a SYMBOL (`agents.on(`), and the prose that
 * explains why it is wrong necessarily mentions that same symbol. Stripping
 * comments keeps the prohibition on real code instead of on documentation.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

const hostCode = codeOnly(hostSrc)
const clientCode = codeOnly(clientSrc)

test('host: the release boundary is agent/status idle, on the Cordis event bus', () => {
  // The listener exists and is wired on the CONTEXT, not on the agents service.
  assert.match(hostCode, /_wireTurnEnd\(\)/, 'the turn-end wiring must exist')
  assert.match(hostCode, /this\.ctx\.on\('agent\/status'/,
    'the host must subscribe on ctx: agents.on() does not exist on AgentRegistry')
  assert.ok(!/agents\.on\(/.test(hostCode),
    'agents.on() is not a method of AgentRegistry (it extends Service) — such a listener never registers')
  // Only 'idle' releases: a turn still running must keep its skills.
  const wire = hostCode.match(/_wireTurnEnd\(\) \{[\s\S]*?\n  \}/)
  assert.ok(wire, '_wireTurnEnd body not found')
  assert.match(wire[0], /if \(status !== 'idle'\) return/,
    'a running turn must not release the held apply')
  assert.match(wire[0], /\{ agent, status \} = \{\}/,
    'the payload is { agent, status }; agent is a field, never `this`')
  assert.match(wire[0], /settleTurnHolds\(this\.ctx, id\)/, 'idle must settle the session hold')
})

test('host: agent lifecycle is subscribed on ctx, not through the agents service', () => {
  assert.match(hostCode, /this\.ctx\.on\('agent\/created'/,
    'shadow rebuild must hang off agent/created on ctx')
  assert.match(hostCode, /this\.ctx\.on\('agent\/disposed'/,
    'registry cleanup must hang off agent/disposed on ctx')
  // The old invented event names do not exist in the harness.
  for (const bogus of ["'agent-added'", "'agent-removed'", "'active'", "'removed'"]) {
    assert.ok(!hostCode.includes(bogus),
      `${bogus} is not a harness event — subscribing to it silently does nothing`)
  }
})

test('host: an apply is held across the turn and released exactly once', () => {
  // Introducing a skill records the hold...
  assert.match(hostSrc, /holdForNextTurn\(key, \[r\.name\], turnAtApply\)/,
    'introducing a skill must record it as held for the next turn, stamped with the log turn')
  // ...and releasing drops both the registration and the hold.
  const rel = hostSrc.match(/function releaseSession\(sessionId, observedTurn\) \{[\s\S]*?\n\}/)
  assert.ok(rel, 'releaseSession not found')
  assert.match(rel[0], /pending\.delete\(holder\)/, 'the hold must be dropped, not just the registration')
  assert.match(rel[0], /revokeIntroduced\(id, name\)/, 'the registration must be revoked')
})

test('host: a hold taken mid-turn is not burned by that same turn', () => {
  // A turn that was already running when the user applied has ALREADY read its
  // catalog, so its idle edge must not spend the hold. `sessionClock` counts
  // running edges and the hold records the value it was taken at.
  assert.match(hostSrc, /const sessionClock = new Map\(\)/, 'the turn clock must exist')
  assert.match(hostSrc, /sessionClock\.set\(id, \(sessionClock\.get\(id\) \?\? 0\) \+ 1\)/,
    'every running edge must advance the clock')
  const rel = hostSrc.match(/function releaseSession\(sessionId, observedTurn\) \{[\s\S]*?\n\}/)
  assert.ok(rel, 'releaseSession not found')
  // The release also refuses while a turn is IN FLIGHT, which is what stops it
  // from stripping skills between `turn/start` and the catalog assembly.
  assert.match(rel[0], /now <= takenAt/,
    'the release must refuse to spend a hold whose clock never advanced')
  // The stamp prefers the caller's log-derived turn and falls back to the event
  // clock; an unreadable log leaves it undefined rather than inventing a value.
  assert.match(hostSrc, /const stamp = turnAtApply !== undefined \? turnAtApply : sessionClock\.get\(sessionId\)/,
    'the hold must record the turn it was taken at (log clock preferred)')
  // Both scales are never compared against each other: an unknown stamp does
  // not strand the apply, it defers to the in-flight check.
  assert.match(rel[0], /takenAt !== undefined && now !== undefined && now <= takenAt/,
    'an unknown stamp on either side must not fabricate an ordering')
})

test('host: the hold is never settled by a read, so the submit window cannot eat it', () => {
  // Between the submit and the agent flipping to 'running' there is a window
  // where status still reads 'idle'. Releasing on a read would revoke the
  // skills before the very turn they were applied for — the original bug in a
  // new costume. GET /applied must therefore only READ the hold.
  const applied = hostSrc.match(/if \(route === 'applied' && method === 'GET'\) \{[\s\S]*?\n  \}/)
  assert.ok(applied, '/applied block not found')
  assert.ok(!/releaseSession\(/.test(applied[0]),
    '/applied must not release: it can observe a pre-running idle window')
  assert.match(applied[0], /pending: /, '/applied must report the unspent hold')
})

test('host: a manual revoke clears the hold so the name cannot come back', () => {
  const revoke = hostSrc.match(/if \(route === 'revoke'\) \{[\s\S]*?\n  \}/)
  assert.ok(revoke, '/revoke block not found')
  assert.match(revoke[0], /held\.delete\(n\)/,
    'revoking a held skill must drop the hold, or it would reappear on the next turn')
})

test('host: a dying agent drops the hold along with its registrations', () => {
  const gone = hostSrc.match(/this\.ctx\.on\('agent\/disposed'[\s\S]*?\n      \}\)\)/)
  assert.ok(gone, 'the agent-disposed handler must exist')
  assert.match(gone[0], /pending\.delete\(candidate\)/, 'the hold must die with the agent')
  assert.match(gone[0], /pendingTurn\.delete\(candidate\)/, 'the turn clock entry must die with the agent')
  assert.match(gone[0], /clearSession\(id\)/, 'the registrations must die with the agent')
})

test('client: no send gesture may revoke the apply', () => {
  const fn = clientSrc.match(/function watchComposerSubmit\(store\) \{[\s\S]*?\n    \}/)
  assert.ok(fn, 'watchComposerSubmit not found')
  assert.ok(!/\/revoke/.test(fn[0]),
    'the composer watcher must not revoke: the host releases the apply when the turn ends')
  assert.ok(!/addEventListener\(['"]keydown/.test(fn[0]),
    'no keydown listener: the send gesture is not the release boundary')
  assert.ok(!/addEventListener\(['"]click/.test(fn[0]),
    'no click listener: the send button is not the release boundary either')
})

test('client: the watcher only polls while an apply is outstanding', () => {
  // An idle composer must not poll, and the timer must not hold a process open.
  assert.match(clientSrc, /const APPLIED_POLL_MS/, 'the poll interval must be a named constant')

  // Two apply buttons: 本轮 (one-shot) and 本会话 (whole session), plus a live
  // strip so the deck itself answers "which cards are usable right now".
  // Two-step flow: the scope buttons only TAG cards; 「发卡」 really applies them.
  assert.match(clientSrc, /stageFn\('turn'\)/, 'the one-shot scope button must tag for the turn')
  assert.match(clientSrc, /stageFn\('session'\)/, 'the session scope button must tag for the session')
  assert.match(clientSrc, /dealFn\(\)/, 'a separate deal button must commit the staged cards')
  // Staging must clear the ticks: the press consumes the selection.
  const stageFn = clientSrc.match(/const stageFn = useCallback\(\(mode\) => \{[\s\S]*?\n      \}, \[selected\]\)/)
  assert.ok(stageFn, 'stageFn not found')
  assert.match(stageFn[0], /setSelected\(new Set\(\)\)/,
    'tagging must clear the tick marks, per the requested flow')
  assert.ok(!/\/introduce/.test(stageFn[0]),
    'tagging must NOT call the host: nothing is applied until 发卡')
  assert.match(clientSrc, /dsh-sc-live /, 'the live strip (当前生效) is missing')
  // The applied state is painted ON the card (a colour ring) plus a 本轮/本会话
  // tag at the bottom-left — the old top-right corner badge is gone.
  assert.match(clientSrc, /sc-live/, 'the card must carry its live state as a colour')
  assert.match(clientSrc, /dsh-sc-offtag tag-live|tag-live\$\{/, 'the bottom-left tag must show the scope when live')
  assert.match(clientSrc, /tag-session/, 'the session scope must be distinguishable from the turn scope')
  const fn = clientSrc.match(/function watchComposerSubmit\(store\) \{[\s\S]*?\n    \}/)
  assert.match(fn[0], /if \(store\.get\(\)\.applied\.length === 0\) return/,
    'the poll loop must stop when nothing is applied')
  assert.match(fn[0], /unref/, 'the timer must not keep the process alive')
})
