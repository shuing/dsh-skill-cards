/**
 * Behavioural test for session isolation of the on/off switch.
 *
 * The switch is session-scoped: turning a skill off in one chat must not grey it
 * out in another. `disabledForSession` is the single source of truth — it lazily
 * seeds a session's disabled set from the legacy machine-wide `_disabled` list
 * ONCE, then every later toggle mutates only that session's own set.
 *
 * These tests drive the real function (exported from lib/index.js for exactly
 * this purpose) rather than asserting on source text, so a regression that
 * changes the semantics without changing the shape is caught here.
 *
 * Run: node --test test/session-isolation.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disabledForSession } from '../lib/index.js'
import { writeStats, DISABLED_KEY } from '../lib/stats.js'

/** A throwaway DSH home. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sc-iso-'))
  return { home }
}

test('two sessions start from the same legacy seed, then diverge', () => {
  const { home } = fixture()
  try {
    // Legacy machine-wide state: dev-expert was turned off before the upgrade.
    writeStats(home, { [DISABLED_KEY]: { 'dev-expert': false } })

    const a = disabledForSession(home, 'session-A')
    const b = disabledForSession(home, 'session-B')

    // Both inherit the legacy "off" choice exactly once.
    assert.ok(a.has('dev-expert'), 'session A must inherit the legacy off')
    assert.ok(b.has('dev-expert'), 'session B must inherit the legacy off')

    // Turn it back ON in session A only.
    a.delete('dev-expert')
    assert.ok(!disabledForSession(home, 'session-A').has('dev-expert'),
      'session A must be independent after its own toggle')
    assert.ok(disabledForSession(home, 'session-B').has('dev-expert'),
      'session B must NOT see session A\'s toggle — that is the whole point')

    // Turn a DIFFERENT skill off in session B; session A must not see it.
    b.add('code-security-audit-v2')
    assert.ok(disabledForSession(home, 'session-B').has('code-security-audit-v2'),
      'session B keeps its own off choice')
    assert.ok(!disabledForSession(home, 'session-A').has('code-security-audit-v2'),
      'session A must not inherit a skill session B turned off')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a session is seeded exactly once — later reads return the same live set', () => {
  const { home } = fixture()
  try {
    writeStats(home, { [DISABLED_KEY]: { a: false } })
    const first = disabledForSession(home, 's1')
    const second = disabledForSession(home, 's1')
    assert.equal(first, second, 'the session set must be cached, not re-seeded on every read')
    // A later mutation of the legacy store must NOT leak into an already-seeded
    // session — the seed is a one-time snapshot.
    writeStats(home, { [DISABLED_KEY]: { a: false, b: false } })
    assert.ok(!disabledForSession(home, 's1').has('b'),
      'a session seeded before a store write must not pick up the new entry')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a session with no legacy seed starts empty (everything on)', () => {
  const { home } = fixture()
  try {
    assert.equal(disabledForSession(home, 'fresh').size, 0,
      'a fresh session on a fresh store must disable nothing')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
