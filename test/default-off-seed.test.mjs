/**
 * REGRESSION: "新会话默认关闭" silently did nothing for some sessions.
 *
 * `disabledForSession` is SYNCHRONOUS but discovery is not, so the "new chats
 * start off" seed needs the set of installed skill names supplied by a scan
 * (`rememberInstalled`). A session is created BEFORE any `/skills` request, so
 * the first read could happen with that set still empty.
 *
 * The old code treated "no scan yet" as "nothing is installed": it fell back to
 * the legacy list (usually empty), and then PERSISTED that empty set as the
 * session's permanent decision (`null` in `_sessionDisabled`). The session was
 * pinned to "nothing disabled" before discovery ever ran, so default-off never
 * applied to it — for ever. On the author's machine 14 of 57 sessions had been
 * pinned that way, which is why the symptom looked like "some workspaces are
 * immune" (a workspace whose first request raced the scan lost; one that did
 * not, won).
 *
 * The contract now: an unscanned read returns a PROVISIONAL empty set and writes
 * NOTHING, so the next read (after a scan) derives the real seed.
 *
 * Run: node --test test/default-off-seed.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disabledForSession, rememberInstalled, __resetSkillCardsState } from '../lib/index.js'
import {
  writeStats, writeDisableByDefault, readStats, readSessionDisabled,
  writeSessionDisabled, SESSION_DISABLED_KEY,
} from '../lib/stats.js'

/** A throwaway DSH home holding every named skill, default-off ON. */
function fixture(names) {
  const home = mkdtempSync(join(tmpdir(), 'sc-seed-'))
  for (const name of names) {
    const dir = join(home, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nB\n`)
  }
  writeStats(home, {})
  writeDisableByDefault(home, true)
  return home
}

beforeEach(() => { __resetSkillCardsState() })

test('BEFORE any scan the seed is provisional and writes NOTHING', () => {
  const home = fixture(['alpha', 'beta'])
  try {
    // No `rememberInstalled` call: this is the state a session is created in.
    const set = disabledForSession(home, 's-early')
    assert.deepEqual([...set], [],
      'an unscanned read may only report the provisional empty set')

    // THE BUG: the decision must not be persisted.
    const stored = readSessionDisabled(readStats(home), 's-early')
    assert.equal(stored, undefined,
      'an unscanned read must not pin the session — that is what broke default-off')
    assert.equal(readStats(home)[SESSION_DISABLED_KEY], undefined,
      'the store must not gain a row for a session that has not been decided')
    // ...and nothing may be cached in memory that would short-circuit the retry.
    assert.deepEqual([...disabledForSession(home, 's-early')], [],
      'a second unscanned read is still provisional')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('AFTER a scan the same session seeds every installed skill as off', () => {
  const home = fixture(['alpha', 'beta'])
  try {
    disabledForSession(home, 's-late') // provisional
    rememberInstalled([{ name: 'alpha' }, { name: 'beta' }])

    const set = disabledForSession(home, 's-late')
    assert.deepEqual([...set].sort(), ['alpha', 'beta'],
      'the scan must turn the provisional view into the real default-off seed')

    // Now, and only now, the decision is persisted.
    const stored = readSessionDisabled(readStats(home), 's-late')
    assert.ok(stored !== undefined, 'a decided session must be persisted')
    assert.deepEqual([...stored].sort(), ['alpha', 'beta'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a session that was already pinned empty is not retro-patched (respect the record)', () => {
  const home = fixture(['alpha'])
  try {
    // A store written by the old code: an explicit "nothing off" decision.
    writeSessionDisabled(home, 's-pinned', new Set())
    rememberInstalled([{ name: 'alpha' }])
    const set = disabledForSession(home, 's-pinned')
    assert.deepEqual([...set], [],
      'an explicit existing record must win — silently rewriting it would undo real choices')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('default-off OFF still seeds from the legacy list, scanned or not', () => {
  const home = fixture([])
  try {
    const stats = readStats(home)
    writeStats(home, { ...stats, _disableByDefault: undefined, _disabled: { legacy: false } })
    const set = disabledForSession(home, 's-legacy')
    assert.deepEqual([...set], ['legacy'],
      'without default-off the legacy machine-wide list is the seed, and it needs no scan')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('two sessions sharing one scan each get their own copy', () => {
  const home = fixture(['alpha'])
  try {
    rememberInstalled([{ name: 'alpha' }])
    const a = disabledForSession(home, 's-a')
    const b = disabledForSession(home, 's-b')
    assert.deepEqual([...a], ['alpha'])
    assert.deepEqual([...b], ['alpha'])
    // Mutating one must not touch the other: they are separate Sets.
    a.delete('alpha')
    assert.deepEqual([...disabledForSession(home, 's-b')], ['alpha'],
      'the seed must give each session an independent set')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('the repair script is dry-run by default and never rewrites silently', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../diagnose/reset-pinned-sessions.mjs', import.meta.url), 'utf8')
  // A repair that mutates a user's store without an explicit flag would be a
  // second bug on top of the first: `null` is also the legitimate "all on".
  assert.match(src, /const apply = argv\.includes\('--apply'\)/,
    'the script must require an explicit --apply')
  assert.match(src, /if \(!apply\) \{/, 'there must be a dry-run exit')
  assert.match(src, /copyFileSync\(STORE, backup\)/,
    'the store must be backed up before it is rewritten')
  assert.match(src, /--keep/, 'the user must be able to keep a real choice')
})
