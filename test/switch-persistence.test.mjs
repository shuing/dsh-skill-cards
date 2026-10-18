/**
 * Regression test for "关闭后 dsh 重启也要保持" — the switch must SURVIVE A RESTART.
 *
 * The bug: every per-session registry lived only in memory, and
 * `disabledForSession` seeded a new session from the LEGACY machine-wide
 * `_disabled` whenever it had nothing cached. After a restart the in-memory map
 * is empty, so every session fell back to that legacy seed and the user's own
 * switches appeared to "come back on their own".
 *
 * There are two halves to the fix, and both are covered here:
 *
 *   1. PERSISTENCE. A session's disabled set is written to
 *      `skill-cards-stats.json` under `_sessionDisabled[<sessionId>]`, and read
 *      back before the legacy seed is ever consulted.
 *
 *   2. SHADOW RECONSTRUCTION. Persisting the list is not enough on its own: the
 *      shadow provider that actually hides the skill is in-memory too. So an
 *      agent appearing re-establishes its session's shadow layer from the
 *      persisted list (`reapplyShadows`).
 *
 * The "restart" is modelled by reading through a session id the process has
 * never touched, which is exactly the state a fresh boot is in.
 *
 * Run: node --test test/switch-persistence.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { disabledForSession } from '../lib/index.js'
import {
  writeStats, readStats, writeSessionDisabled, readSessionDisabled,
  DISABLED_KEY, SESSION_DISABLED_KEY,
} from '../lib/stats.js'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

function fixture() {
  return { home: mkdtempSync(join(tmpdir(), 'sc-persist-')) }
}

test('a session\'s off choice is written to disk, not just held in memory', () => {
  const { home } = fixture()
  try {
    writeStats(home, {})
    // Simulate what /switch does after mutating the in-memory set.
    writeSessionDisabled(home, 'session-abc', ['dev-expert', 'dual-voice-prose'])

    const stored = readStats(home)[SESSION_DISABLED_KEY]
    assert.ok(stored, 'the session map must be written')
    assert.deepEqual(stored['session-abc'], { 'dev-expert': false, 'dual-voice-prose': false },
      'only DISABLED names are stored, in the sparse { name: false } shape')
    // An EMPTIED session must be recorded as \`null\`, not deleted: deleting it
    // would make it look "never written" and a restart would re-seed the legacy
    // list, turning skills back OFF on their own.
    writeSessionDisabled(home, 'session-abc', [])
    assert.equal(readStats(home)[SESSION_DISABLED_KEY]['session-abc'], null,
      'an emptied session must leave a null marker, not vanish')
    assert.equal(readSessionDisabled(readStats(home), 'session-abc').size, 0,
      'and it must read back as an empty set (decided, nothing off)')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a persisted session reads back its OWN list, ignoring the legacy seed', () => {
  const { home } = fixture()
  try {
    // Legacy machine-wide seed says "legacy-off is off".
    writeStats(home, { [DISABLED_KEY]: { 'legacy-off': false } })
    // This session turned something ELSE off, and left the legacy one on.
    writeSessionDisabled(home, 'session-persisted', ['own-off'])

    const set = disabledForSession(home, 'session-persisted')
    assert.ok(set.has('own-off'),
      'the session must keep its own off choice')
    assert.ok(!set.has('legacy-off'),
      'a persisted session must NOT be re-seeded from the legacy list — that is the bug')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a session that was never persisted still inherits the legacy seed once', () => {
  const { home } = fixture()
  try {
    writeStats(home, { [DISABLED_KEY]: { 'legacy-off': false } })
    const set = disabledForSession(home, 'session-fresh')
    assert.ok(set.has('legacy-off'),
      'a pre-upgrade user must keep their legacy choices on a never-touched session')
    // ...and that adoption is persisted, so the NEXT read takes the step-2 path
    // instead of falling back to the legacy list again after a restart.
    const stored = readSessionDisabled(readStats(home), 'session-fresh')
    assert.ok(stored, 'the adopted seed must be persisted for the next boot')
    assert.ok(stored.has('legacy-off'), 'the persisted copy must carry the adopted names')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('the legacy seed cannot resurrect a skill the session already turned back ON', () => {
  const { home } = fixture()
  try {
    writeStats(home, { [DISABLED_KEY]: { 'dev-expert': false } })
    // The session inherits, then the user turns it back on.
    const set = disabledForSession(home, 'session-on')
    assert.ok(set.has('dev-expert'), 'inherits the legacy off')
    set.delete('dev-expert')
    writeSessionDisabled(home, 'session-on', set)

    // After a "restart", the persisted EMPTY list must win over the legacy seed.
    // Without persisting the empty state, the legacy 'false' would re-apply and
    // the skill would come back off on its own.
    const again = readSessionDisabled(readStats(home), 'session-on')
    assert.ok(again !== undefined,
      'an explicitly emptied session must still be recorded as persisted')
    assert.equal(again.size, 0, 'and it must read back as nothing disabled')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('host: switching writes the session list through to disk', () => {
  const sw = hostSrc.match(/if \(route === 'switch'\) \{[\s\S]*?\n  \}/)
  assert.ok(sw, 'switch route block found')
  assert.match(sw[0], /persistSessionDisabled\(home, key\)/,
    'the switch must persist the session set, or a restart undoes it')
  // Persist AFTER the mutation, so the write reflects the new set.
  assert.ok(sw[0].indexOf('set.add(n)') < sw[0].indexOf('persistSessionDisabled(home, key)'),
    'the set must be mutated before it is persisted')
})

test('host: an appearing agent rebuilds its shadow layer from the persisted list', () => {
  // Persistence alone is not enough — the shadow provider is in-memory too.
  assert.match(hostSrc, /(?:export )?async function reapplyShadows\(ctx, home, sessionId, agent\)/,
    'the shadow-reconstruction helper must exist')
  const fn = hostSrc.match(/(?:export )?async function reapplyShadows\(ctx, home, sessionId, agent\) \{[\s\S]*?\n\}/)
  assert.ok(fn, 'reapplyShadows body not found')
  assert.match(fn[0], /disabledForSession\(home, sessionId\)/,
    'it must read the session\'s persisted disabled set')
  assert.match(fn[0], /fillShadowsSync\(sessionId, agent, skills, disabled\)/,
    'it must fill the shadow provider for the live agent')
  // And the agent-created path must actually call it.
  assert.match(hostSrc, /void reapplyShadows\(this\.ctx, defaultDshHome\(\), id, agent\)/,
    'agent creation must re-establish the shadow layer')
})
