/**
 * Regression test for the skill on/off switch (可见性开关).
 *
 * The switch has to mean something at the skill registry, not just on the card
 * face. These tests lock in the three properties that make it real:
 *
 *   1. OFF IS ENFORCED BY A SESSION-SCOPED SHADOW PROVIDER. The registry merges
 *      the global layer with the viewing scope's chain and the nearest layer
 *      wins a duplicate name outright, so a provider registered on the agent's
 *      own context outranks the filesystem provider for that session. The
 *      shadow republishes the same name with `modelInvocable: false`, which is
 *      what keeps it out of the model-facing catalog and makes the `skill` tool
 *      refuse to load it. Rank 0 additionally settles a same-layer tie.
 *
 *   2. OFF NEVER TOUCHES THE FILES. The skill keeps working for every other
 *      agent on the machine, and turning it back on is just releasing the
 *      shadow. A switch that deleted or moved directories would not be
 *      reversible, and "off" here is a visibility choice, not an uninstall.
 *
 *   3. OFF UNDOES AN EXISTING SESSION REGISTRATION FIRST. A skill already
 *      introduced via /introduce stays visible to the model until it is
 *      revoked; adding a shadow on top of it would leave the model still
 *      reading a skill the user just turned off.
 *
 * The store is deliberately sparse and machine-wide: only DISABLED skills are
 * written, and a skill with no entry is enabled, so installing this plugin on a
 * machine that already has skills changes nothing until the user acts.
 *
 * Run: node --test test/switch.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDisabled, setDisabled, DISABLED_KEY, readStats, writeStats } from '../lib/stats.js'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientSrc = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

/** A throwaway DSH home with one skill on disk. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sc-switch-'))
  const dir = join(home, 'skills', 'demo-skill')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\n# body\n')
  return { home, dir }
}

test('a skill with no stored entry is enabled (absent means on)', () => {
  const { home } = fixture()
  try {
    assert.equal(readDisabled(readStats(home)).size, 0,
      'a fresh store must disable nothing — this plugin is installed on machines that already have skills')
    // And it must not have written a store just by being read.
    assert.equal(readStats(home)[DISABLED_KEY], undefined, 'reading must not create the key')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('disabling stores only the disabled name, and enabling removes the entry', () => {
  const { home } = fixture()
  try {
    const off = setDisabled(home, 'demo-skill', false)
    assert.deepEqual([...off], ['demo-skill'], 'the disabled set must carry the name')
    // Sparse: the stored shape is { name: false }, never a list of trues.
    assert.deepEqual(readStats(home)[DISABLED_KEY], { 'demo-skill': false })
    const on = setDisabled(home, 'demo-skill', true)
    assert.equal(on.size, 0, 'enabling must clear the entry')
    assert.equal(readStats(home)[DISABLED_KEY], undefined,
      'the reserved key must be dropped when nothing is disabled, not left as an empty object')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('only an explicit false disables: a hand-edited store cannot hide a skill by accident', () => {
  const { home } = fixture()
  try {
    writeStats(home, { [DISABLED_KEY]: { a: false, b: true, c: null, d: 'no', e: 0 } })
    assert.deepEqual([...readDisabled(readStats(home))], ['a'],
      'true / null / strings / numbers must all read as enabled')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a corrupt or malformed disabled store reads as "nothing disabled"', () => {
  const { home } = fixture()
  try {
    writeStats(home, { [DISABLED_KEY]: [] })
    assert.equal(readDisabled(readStats(home)).size, 0, 'an array is not a gate map')
    writeStats(home, { [DISABLED_KEY]: 'off' })
    assert.equal(readDisabled(readStats(home)).size, 0, 'a string is not a gate map')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('host: off is enforced by a session-scoped shadow provider, not by touching files', () => {
  // The route exists and is reachable through both the GET and POST tables.
  assert.match(hostSrc, /'switch'/, 'switch must be a known route')
  assert.match(hostSrc, /if \(route === 'switch'\)/, 'switch route missing')
  // Enforcement mechanism: a provider that republishes the name as not invocable.
  assert.match(hostSrc, /registerProvider\(/, 'the shadow must be a provider registration')
  assert.match(hostSrc, /modelInvocable: false/, 'the shadow must withdraw model invocation')
  assert.match(hostSrc, /rank: 0/, 'rank 0 must settle a same-layer duplicate')
  // It must be registered on the AGENT's context: a global registration would
  // be in the same layer as the filesystem provider, where rank alone decides
  // and a user skill could win.
  assert.match(hostSrc, /agent\?\.ctx\?\.get\?\.\('skills'\)/,
    'the shadow provider must be registered on the agent session scope')
  // And it must never touch the skill's files.
  assert.ok(!/rmSync|unlinkSync|renameSync/.test(hostSrc),
    'the switch must not delete, move or rewrite any skill file')
})

test('host: applying an OFF skill lifts its shadow for one turn, then restores it', () => {
  // The switch governs AMBIENT visibility; "apply to this turn" is an explicit
  // one-shot opt-in. They are not mutually exclusive: an off skill is normally
  // shadowed, and applying it lifts the shadow for the turn. Refusing here was
  // exactly why the user's explicit opt-in silently did nothing.
  const intro = hostSrc.match(/if \(route === 'introduce'\) \{[\s\S]*?\n  \}/)
  assert.ok(intro, 'introduce route block found')
  assert.match(intro[0], /const wasOff = disabledForSession\(home, key\)\.has\(skill\.name\)/,
    'introduce must detect whether the skill was off IN THIS session')
  assert.match(intro[0], /unshadowSkill\(key, skill\.name\)/,
    'applying an off skill must lift its shadow first, or rank 0 shadows the registration')
  assert.match(intro[0], /rememberTemporary\(key, r\.name, skill\)/,
    'the off skill must be remembered so its shadow is restored at turn end')
  // And the turn-end release returns the entries whose shadow needs restoring,
  // so the caller can re-shadow an off skill that was only on for the turn.
  assert.match(hostSrc, /return \{ released, restore \}/,
    'releaseSession must return the entries whose shadow needs restoring')
  assert.match(hostSrc, /shadowSkill\(ctx, sessionId, skill\)/,
    'settlement must re-shadow a skill that was off')
})

test('host: the switch is session-scoped, so one chat cannot bleed into another', () => {
  // The switch is per-session, exactly like the apply and the shadow it drives.
  // Turning a skill off in one chat must NOT grey it out in another — that is
  // the cross-session bleed this test exists to prevent. There must be no
  // machine-wide fan-out left.
  assert.ok(!/shadowEverywhere|unshadowEverywhere/.test(hostSrc),
    'the machine-wide fan-out helpers must be gone')
  const sw = hostSrc.match(/if \(route === 'switch'\) \{[\s\S]*?\n  \}/)
  assert.ok(sw, 'switch route block found')
  assert.match(sw[0], /disabledForSession\(home, key\)/,
    'the switch must mutate THIS session\'s disabled set')
  assert.match(sw[0], /shadowSkill\(ctx, key, byName\.get\(n\)\)/,
    'the switch must shadow only THIS session, not every live one')
  assert.match(sw[0], /unshadowSkill\(key, n\)/,
    'turning on must release only THIS session\'s shadow')
  // No machine-wide persistence: the choice lives in the session's own in-memory
  // set, seeded once from the legacy file, then diverging.
  assert.ok(!/setDisabled\(/.test(sw[0]),
    'the switch must not write the machine-wide store any more')
  // A stale client cannot write a choice for a skill that is not installed.
  assert.match(sw[0], /known\.has\(n\)/, 'unknown names must be skipped, never stored')
})

test('host: a new session inherits the legacy disabled list once, then diverges', () => {
  // Migration: the old machine-wide `_disabled` is read once as a session's
  // starting state, so an existing user's "I turned these off" choice survives.
  // After that the session's set is independent.
  assert.match(hostSrc, /function disabledForSession\(home, sessionId\)/,
    'the session-scoped disabled helper must exist')
  // A fresh session seeds from the legacy machine-wide list UNLESS the
  // "default off" preference is set, in which case it seeds from everything
  // installed. Both branches must exist.
  assert.match(hostSrc, /set = new Set\(readDisabled\(stats\)\)/,
    'the legacy seed must still exist for the default-off=off case')
  assert.match(hostSrc, /sessionDisabled\.set\(sessionId, set\)/,
    'the seed must be cached per session so later toggles diverge')
})

test('host: every skill carries its enabled flag, and absent still means on', () => {
  const payload = hostSrc.match(/const payload = skills\.map\(\(s\) => \(\{[\s\S]*?\}\)\)/)
  assert.ok(payload, 'skills payload block found')
  assert.match(payload[0], /enabled: !disabled\.has\(s\.name\)/,
    'the catalog must report each skill enabled state')
  // /applied reports the disabled set too, so the composer can show the state.
  assert.match(hostSrc, /disabled: \[\.\.\.disabled\]/,
    '/applied must report the disabled set')
})

test('client: the switch is wired end to end and cannot silently no-op', () => {
  // The card exposes a real role=switch control.
  assert.match(clientSrc, /role: 'switch'/, 'the card needs a switch control')
  assert.match(clientSrc, /'aria-checked': enabled \? 'true' : 'false'/,
    'the switch must expose its state to assistive tech')
  assert.match(clientSrc, /onEnabled\(skill\.name, !enabled\)/, 'the card switch must call the handler')
  // Both layouts receive it (the fan and the wall render the same Card).
  const passed = [...clientSrc.matchAll(/onEnabled: setEnabled/g)]
  assert.ok(passed.length >= 2, 'both layouts must pass the switch handler down')
  // Turning off revokes first: a registered skill stays visible to the model
  // until it is revoked, so shadowing alone would leave it in use.
  const fn = clientSrc.match(/const setEnabled = useCallback\(async \(name, enabled\) => \{[\s\S]*?\n      \}, \[store, t, showToast, revokeApplied, disableSkills\]\)/)
  assert.ok(fn, 'setEnabled callback missing')
  assert.ok(fn[0].indexOf('revokeApplied(') < fn[0].indexOf('disableSkills('),
    'the session registration must be revoked before the skill is shadowed')
  // A failed write rolls the local state back rather than showing a lie.
  assert.match(fn[0], /delete next\[name\]/, 'a failed switch must roll the optimistic state back')
  // Bulk switching is computed from ALL skills, not the filtered view: "全部开启"
  // has to reach the disabled cards, which are hidden from the grid by default.
  const bulk = clientSrc.match(/const setAllEnabled = useCallback\(async \(enabled\) => \{[\s\S]*?\n      \}, \[merged, store, t, showToast, revokeApplied, disableSkills\]\)/)
  assert.ok(bulk, 'setAllEnabled callback missing')
  assert.match(bulk[0], /merged\.filter\(/, 'bulk switching must be computed from every skill')
  // 「全部移除 / 移除该技能」在卡片芯片里也必须关掉技能，而不只是撤销注册。
  assert.match(clientSrc, /await switchOff\(sessionId, names\)/,
    'the composer chips must switch the skills off after revoking them')
})

test('client: the grid always shows every skill, including the disabled ones', () => {
  // The deck is a view of ALL installed skills, not of the usable subset.
  // Hiding the off ones left an empty grid the moment everything was turned
  // off, with no way to see what had been closed or how to reopen it. Status is
  // now carried by the bottom-left tag instead of by presence/absence.
  assert.ok(!/list = list\.filter\(\(s\) => s\.enabled/.test(clientSrc),
    'the grid must NOT filter out disabled skills')
  assert.ok(!/showDisabled/.test(clientSrc),
    'the "show disabled" toggle is gone: there is nothing to reveal')
  assert.ok(!/dsh-sc-offchip/.test(clientSrc),
    'and its chip is gone from the filter row')
  // A disabled skill must remain fully interactive: it can be ticked and applied
  // (apply is an explicit opt-in that overrides the switch for one turn).
  assert.ok(!/const off = new Set\(merged\.filter\(\(s\) => !s\.enabled\)/.test(clientSrc),
    'disabled skills must NOT be pruned from the selection')
  // The card still carries the status tag, and still carries the live glow.
  assert.match(clientSrc, /dsh-sc-offtag/, 'the bottom-left status tag must remain')
  assert.match(clientSrc, /sc-live/, 'the live state must still be visible on the card')
})

test('client: an unknown enabled flag reads as enabled (forward and backward compatible)', () => {
  // An older host does not send the field; the card must behave exactly as it
  // did before rather than rendering every skill as switched off.
  assert.match(clientSrc, /const enabled = skill\.enabled !== false/,
    'the card must treat a missing flag as enabled')
  assert.match(clientSrc, /s\.enabled !== false\s*,/,
    'the panel must treat a missing flag as enabled too')
})

test('client: the no-live-session case is reported, not claimed as applied', () => {
  // The switch is session-scoped now, so there is no machine-wide fan-out to
  // count. The honest signal is a null sessionId: with no live chat the toggle
  // could not be enforced on any shadow, so say so instead of claiming the
  // model lost access.
  assert.match(clientSrc, /res\.sessionId === null/, 'the client must detect a missing session')
  assert.match(clientSrc, /switchStored/, 'and must use the "stored for next time" message')
})
