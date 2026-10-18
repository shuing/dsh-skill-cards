/**
 * Regression test for the "apply an OFF skill to this turn" contract.
 *
 * The switch and the one-shot apply are two different axes and must not cancel
 * each other out:
 *
 *   - The switch governs AMBIENT visibility: an off skill is shadowed (same
 *     name, modelInvocable:false) so the model catalog omits it.
 *   - "Apply to this turn" is an EXPLICIT opt-in: the user picked this skill and
 *     pressed apply, so it must work for the turn they are about to send.
 *
 * Refusing the apply — the earlier behaviour — is exactly why a user's explicit
 * opt-in silently did nothing: they picked an off skill, hit apply, sent, and
 * the turn ran without it. The correct sequence is:
 *
 *   apply off skill  → lift its shadow, register it, remember it
 *   turn runs        → the skill is present
 *   turn ends        → the shadow comes back, so it is off again
 *
 * Run: node --test test/apply-off.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientSrc = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

test('host: /introduce no longer refuses an off skill', () => {
  const intro = hostSrc.match(/if \(route === 'introduce'\) \{[\s\S]*?\n  \}/)
  assert.ok(intro, 'introduce route block not found')
  assert.ok(!/该技能已关闭|refuse|disabled skill is never introduced/.test(intro[0]),
    'the old hard reject must be gone — that is what made the opt-in do nothing')
})

test('host: applying an off skill lifts its shadow BEFORE registering', () => {
  const intro = hostSrc.match(/if \(route === 'introduce'\) \{[\s\S]*?\n  \}/)
  assert.ok(intro, 'introduce route block not found')
  // Order matters: the shadow republishes the name at rank 0, which wins the
  // same-layer duplicate over the real registration. Unshadow must run first.
  const unshadowAt = intro[0].indexOf('unshadowSkill(key, skill.name)')
  const registerAt = intro[0].indexOf('introduceIntoSession(ctx, agent, skill)')
  assert.ok(unshadowAt !== -1, 'unshadow missing')
  assert.ok(registerAt !== -1, 'register missing')
  assert.ok(unshadowAt < registerAt,
    'the shadow must be lifted BEFORE the real skill is registered, or rank 0 wins')
})

test('host: an off skill is remembered so its shadow is restored at turn end', () => {
  assert.match(hostSrc, /function rememberTemporary\(sessionId, name, skill\)/,
    'the temporary-enable registry must exist')
  assert.match(hostSrc, /rememberTemporary\(key, r\.name, skill\)/,
    'introduce must record the off skill for restore')
  const rel = hostSrc.match(/function releaseSession\(sessionId, observedTurn\) \{[\s\S]*?\n\}/)
  assert.ok(rel, 'releaseSession not found')
  assert.match(rel[0], /restore\.push\(\{ name, skill: entry \}\)/,
    'releaseSession must hand back the off skills to re-shadow')
})

test('host: the turn-end handler re-shadows an off skill that was applied for the turn', () => {
  // The restore now lives in `settleTurnHolds`, which BOTH the status listener
  // and the /applied read path call — so a host that never delivers
  // `agent/status` still restores the shadow on the next poll.
  const wire = hostSrc.match(/_wireTurnEnd\(\) \{[\s\S]*?\n  \}/)
  assert.ok(wire, '_wireTurnEnd not found')
  assert.match(wire[0], /settleTurnHolds\(this\.ctx, id\)/,
    'the idle handler must go through settleTurnHolds')
  const settle = hostSrc.match(/function settleTurnHolds\(ctx, sessionId\) \{[\s\S]*?\n\}/)
  assert.ok(settle, 'settleTurnHolds not found')
  assert.match(settle[0], /const \{ released, restore \} = releaseSession\(sessionId, turn\)/,
    'settlement must take the restore list from releaseSession, using the log turn')
  assert.match(settle[0], /shadowSkill\(ctx, sessionId, skill\)/,
    'settlement must re-shadow a skill that was off')
  // Only off skills are re-shadowed; an on skill applied for the turn stays on.
  // Session-scoped: the "still off" check reads THIS session's disabled set.
  assert.match(settle[0], /disabledForSession\(defaultDshHome\(\), sessionId\)\.has\(name\)/,
    'settlement must only re-shadow skills that are STILL off in THIS session')
})

test('client: an off skill stays selectable and applicable', () => {
  // The old client pruned off skills from the selection, silently un-ticking
  // whatever the user had picked. That must be gone.
  assert.ok(!/const off = new Set\(merged\.filter\(\(s\) => !s\.enabled\)/.test(clientSrc),
    'the selection prune must be gone: off skills are applicable')
  // Staging takes the whole selection, off skills included.
  const stageFn = clientSrc.match(/const stageFn = useCallback\(\(mode\) => \{[\s\S]*?\n      \}, \[selected\]\)/)
  assert.ok(stageFn, 'stageFn not found')
  assert.match(stageFn[0], /const names = \[\.\.\.selected\]/,
    'staging must take the whole selection, not a filtered subset')
  assert.ok(!/filter\(\s*\(s\)\s*=>\s*s\.enabled/.test(stageFn[0]),
    'staging must not filter out off skills')
  // Dealing sends each card's own scope to the host.
  const dealFn = clientSrc.match(/const dealFn = useCallback\(async \(\) => \{[\s\S]*?\n      \}, \[staged, store, t, showToast, onApplyDone, merged, ownSessionId, catDefs\]\)/)
  assert.ok(dealFn, 'dealFn not found')
  assert.match(dealFn[0], /mode: scope/, 'dealing must tell the host which scope each card wants')
})
