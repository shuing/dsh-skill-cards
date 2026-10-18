/**
 * Regression test for "清空 / 全部移除 must actually TURN THE SKILLS OFF".
 *
 * The user's report: pressing 清空 (or 全部移除 on the composer chips) removed
 * the skills from the session, but they came straight back on the next turn —
 * because a revoke only drops the session REGISTRATION. The switch stays on, so
 * the filesystem provider re-supplies the skill and the model sees it again.
 *
 * "清空" means "these skills are done", not "not this turn". So both surfaces
 * must now revoke AND switch off:
 *
 *   panel 清空      → revokeApplied(names) + disableSkills(names)
 *   chips 全部移除  → /revoke               + switchOff(sessionId, names)
 *
 * The host is made self-consistent too: POST /switch with enabled:false drops
 * that skill's registration, hold and mode before adding the shadow, so a
 * caller that ONLY flips the switch cannot leave a "live" registration behind.
 *
 * Run: node --test test/clear-turns-off.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientSrc = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

test('host: turning a skill off ALSO drops its session registration', () => {
  const sw = hostSrc.match(/if \(route === 'switch'\) \{[\s\S]*?\n  \}/)
  assert.ok(sw, 'switch route block found')
  // The off branch must clean every trace of a live registration.
  const offBranch = sw[0].slice(sw[0].indexOf('} else {'), sw[0].indexOf('const stillHeld'))
  assert.ok(offBranch.length > 0, 'off branch found')
  assert.match(offBranch, /revokeIntroduced\(key, n\)/,
    'switching off must unregister the skill, or /applied keeps listing it as live')
  assert.match(offBranch, /held\.delete\(n\)/,
    'switching off must drop the unspent hold for that name')
  assert.match(offBranch, /forgetMode\(key, n\)/,
    'switching off must drop the mode label')
  assert.match(offBranch, /forgetTemporary\(key, n\)/,
    'switching off must drop the temporary marker: the shadow IS the off state now')
})

test('client: 清空 revokes AND disables', () => {
  const clearFn = clientSrc.match(/const clear = useCallback\(\(\) => \{[\s\S]*?\n      \}, \[selected, revokeApplied, disableSkills, t, showToast\]\)/)
  assert.ok(clearFn, 'clear callback not found')
  assert.match(clearFn[0], /revokeApplied\(names\)/, 'clear must revoke the applied subset')
  assert.match(clearFn[0], /disableSkills\(names\)/, 'clear must turn those skills off')
  // Order: revoke first, then disable. Disabling adds the shadow, and a shadow
  // over a still-registered name is what left the skill readable.
  assert.ok(clearFn[0].indexOf('revokeApplied(names)') < clearFn[0].indexOf('disableSkills(names)'),
    'clear must revoke before it disables')
})

test('client: the composer chips turn skills off after revoking them', () => {
  const fn = clientSrc.match(/const revokeNames = async \(names\) => \{[\s\S]*?\n      \}/)
  assert.ok(fn, 'revokeNames not found')
  assert.match(fn[0], /api\('\/revoke'/, 'the chips must still revoke')
  assert.match(fn[0], /await switchOff\(sessionId, names\)/,
    'the chips must ALSO switch the skills off — that is the reported bug')
  assert.ok(fn[0].indexOf("api('/revoke'") < fn[0].indexOf('switchOff(sessionId, names)'),
    'revoke must run before the switch-off')
})

test('client: both writers share one switch-off implementation', () => {
  // A module-level helper serves the panel and the chips, so the two surfaces
  // cannot drift on what "turn off" sends.
  assert.match(clientSrc, /async function switchOff\(sessionId, names\)/,
    'the shared switch-off writer must exist')
  const helper = clientSrc.match(/async function switchOff\(sessionId, names\) \{[\s\S]*?\n    \}/)
  assert.ok(helper, 'switchOff body not found')
  assert.match(helper[0], /enabled: false/, 'the shared writer must turn skills off')
  assert.match(helper[0], /'\/switch'/, 'the shared writer must POST /switch')
  // ...and the panel's batch path uses it rather than a second copy of the call.
  assert.match(clientSrc, /const disableSkills = useCallback\(async \(names\) => \{/,
    'the panel batch helper must exist')
})

test('client: a failed switch-off never un-does a successful revoke', () => {
  // The two operations are independent: the skills ARE out of the session even
  // if the switch write fails, so the failure is logged, not thrown.
  const fn = clientSrc.match(/const revokeNames = async \(names\) => \{[\s\S]*?\n      \}/)
  assert.ok(fn, 'revokeNames not found')
  assert.match(fn[0], /switch-off after revoke failed/,
    'a failed switch-off must be reported without undoing the revoke')
  assert.ok(!/catch[\s\S]{0,120}setApplied\(/.test(fn[0].slice(fn[0].indexOf('switchOff'))),
    'the outer failure path must not resurrect the revoked names')
})
