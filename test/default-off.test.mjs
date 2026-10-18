/**
 * Regression test for "default off" — new chats start with every skill disabled.
 *
 * The user's report was "重启了以后仍然无法保持卡片关闭". Persistence WAS working
 * (the per-session list was on disk); the real gap was that every NEW chat is a
 * blank session with no record, so it started with everything ON. Toggling a
 * switch in one chat cannot possibly apply to a chat that does not exist yet —
 * that needs a machine-wide DEFAULT.
 *
 * The rule:
 *   - a session with no record + default-off OFF → legacy seed (existing behaviour)
 *   - a session with no record + default-off ON  → every installed skill disabled
 *   - a session WITH a record → its own list, never overridden by the default
 *
 * Run: node --test test/default-off.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { disabledForSession, rememberInstalled } from '../lib/index.js'
import {
  readStats, writeStats, readDisableByDefault, writeDisableByDefault,
  writeSessionDisabled, DISABLE_BY_DEFAULT_KEY, DISABLED_KEY,
} from '../lib/stats.js'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientSrc = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

function fixture() {
  return { home: mkdtempSync(join(tmpdir(), 'sc-defoff-')) }
}

test('the preference round-trips and defaults to OFF', () => {
  const { home } = fixture()
  try {
    writeStats(home, {})
    assert.equal(readDisableByDefault(readStats(home)), false,
      'a fresh store must NOT default to hiding skills')
    writeDisableByDefault(home, true)
    assert.equal(readStats(home)[DISABLE_BY_DEFAULT_KEY], true, 'the flag is stored')
    assert.equal(readDisableByDefault(readStats(home)), true, 'and reads back on')
    writeDisableByDefault(home, false)
    assert.equal(readStats(home)[DISABLE_BY_DEFAULT_KEY], undefined,
      'turning it off must DELETE the key, keeping the store sparse')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('default-off does not touch a session that already has its own record', () => {
  const { home } = fixture()
  try {
    // This chat decided: nothing off.
    writeSessionDisabled(home, 'session-decided', [])
    writeDisableByDefault(home, true)
    const set = disabledForSession(home, 'session-decided')
    assert.equal(set.size, 0,
      'an existing chat must keep its own choice; the default only applies to NEW chats')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('default-off ON makes a brand-new session start fully disabled', () => {
  const { home } = fixture()
  try {
    writeStats(home, {})
    writeDisableByDefault(home, true)
    // The host records what it scanned; the synchronous seed reads that list.
    rememberInstalled(['dev-expert', 'dual-voice-prose', 'writing-plans'])
    const fresh = disabledForSession(home, 'session-brand-new')
    assert.deepEqual([...fresh].sort(), ['dev-expert', 'dual-voice-prose', 'writing-plans'],
      'every installed skill must start disabled in a brand-new chat')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('default-off OFF leaves a brand-new session fully enabled', () => {
  const { home } = fixture()
  try {
    writeStats(home, {})
    writeDisableByDefault(home, false)
    rememberInstalled(['dev-expert'])
    const fresh = disabledForSession(home, 'session-normal')
    assert.equal(fresh.size, 0, 'without the preference a new chat has nothing off')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('host: the default-off seed only applies when no session record exists', () => {
  const fn = hostSrc.match(/export function disabledForSession\(home, sessionId\) \{[\s\S]*?\n\}/)
  assert.ok(fn, 'disabledForSession not found')
  // Step 2 (own record) must come BEFORE the default-off branch.
  const ownRecord = fn[0].indexOf('readSessionDisabled(stats, sessionId)')
  const defaultOff = fn[0].indexOf('readDisableByDefault(stats)')
  assert.ok(ownRecord !== -1 && defaultOff !== -1, 'both branches must exist')
  assert.ok(ownRecord < defaultOff,
    'a session with its own record must win over the machine-wide default')
  assert.match(fn[0], /knownSkillNames/, 'default-off seeds from the scanned skill names')
  // THE SEED MUST NOT BE PINNED BEFORE ANY SCAN HAS RUN.
  //
  // `knownSkillNames` is only populated by a scan, and a session is created
  // before any /skills request. Seeding then wrote an EMPTY set as the session's
  // permanent decision, so "new chats start off" silently did nothing for it —
  // 14 of 57 sessions on the author's machine were pinned that way.
  assert.match(fn[0], /if \(knownSkillNames\.size === 0\) return new Set\(\)/,
    'an unscanned session must return a PROVISIONAL empty set')
  const noScanBranch = fn[0].slice(fn[0].indexOf('if (knownSkillNames.size === 0)'))
  assert.ok(!/writeSessionDisabled/.test(noScanBranch.split('set = new Set(knownSkillNames)')[0]),
    'the unscanned branch must NOT persist a decision')
})

test('host: the route exposes and persists the preference', () => {
  assert.match(hostSrc, /'default-off'/, 'the route must be registered')
  const post = hostSrc.match(/if \(route === 'default-off'\) \{[\s\S]*?\n  \}/)
  assert.ok(post, 'POST handler found')
  assert.match(post[0], /writeDisableByDefault\(home, body\.disableByDefault\)/,
    'the handler must persist the flag')
  assert.match(post[0], /typeof body\.disableByDefault !== 'boolean'/,
    'the handler must reject a non-boolean')
})

test('client: the toolbar exposes the preference as a toggle', () => {
  assert.match(clientSrc, /\/default-off/, 'the client must call the route')
  assert.match(clientSrc, /toggleDefaultOff/, 'a toggle handler must exist')
  assert.match(clientSrc, /dsh-sc-defoff/, 'the toggle must be rendered in the toolbar')
  // It must be OFF until the host answers, so the UI never claims a state it
  // has not read.
  assert.match(clientSrc, /const \[defaultOff, setDefaultOff\] = useState\(null\)/,
    'the state must start unknown, not guessed')
})

test('host: switching a session persists its record, so default-off never re-fires', () => {
  const sw = hostSrc.match(/if \(route === 'switch'\) \{[\s\S]*?\n  \}/)
  assert.ok(sw, 'switch route found')
  assert.match(sw[0], /persistSessionDisabled\(home, key\)/,
    'a toggle must write the session record')
})
