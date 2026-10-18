/**
 * Regression test for "面板显示关了，实际还能用".
 *
 * The panel and the model disagreed: the card said OFF, the model could still
 * use the skill. That is a SHADOW failure, not a display failure — the disabled
 * set was right, but the session-scoped shadow provider that actually hides the
 * skill was never registered.
 *
 * Two ordering bugs made it happen:
 *
 *   1. `reapplyShadows` seeded the session BEFORE scanning. A brand-new session
 *      derives its initial set from `knownSkillNames`, which only a scan fills —
 *      and an agent is created before any /skills request reaches the host. The
 *      seed therefore saw an empty list, produced an empty set, and returned
 *      with no shadow.
 *
 *   2. The agent context may not expose `skills` yet at 'agent-added' time. The
 *      old code gave up immediately, leaving the same state.
 *
 * The fix: scan (and remember) first, retry registration, and reconcile once
 * more when the panel is actually read — the moment the user would believe the
 * "off" label.
 *
 * Run: node --test test/shadow-ordering.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

test('reapplyShadows scans and remembers BEFORE seeding the session', () => {
  const fn = hostSrc.match(/(?:export )?async function reapplyShadows\(ctx, home, sessionId, agent\) \{[\s\S]*?\n\}/)
  assert.ok(fn, 'reapplyShadows not found')
  const scanAt = fn[0].indexOf('scanInstalled(')
  const rememberAt = fn[0].indexOf('rememberInstalled(')
  const seedAt = fn[0].indexOf('disabledForSession(')
  assert.ok(scanAt !== -1 && rememberAt !== -1 && seedAt !== -1, 'all three steps must exist')
  assert.ok(scanAt < seedAt,
    'the scan must run before the seed: a brand-new session seeds from knownSkillNames')
  assert.ok(rememberAt < seedAt,
    'the scan result must be recorded before the seed reads it')
})

test('reapplyShadows does not give up when skills is not ready yet', () => {
  const fn = hostSrc.match(/(?:export )?async function reapplyShadows\(ctx, home, sessionId, agent\) \{[\s\S]*?\n\}/)
  assert.ok(fn, 'reapplyShadows not found')
  // It must retry rather than return on the first undefined.
  assert.match(fn[0], /for \(let attempt = 0/, 'a bounded retry must exist')
  assert.match(fn[0], /setTimeout\(resolve, \d+\)/, 'the retry must wait between attempts')
  assert.match(fn[0], /shadows\.get\(sessionId\) === undefined/,
    'it must test whether the provider was actually registered')
})

test('/skills reconciles the shadow when the session has a disabled set', () => {
  const sk = hostSrc.match(/if \(route === 'skills' && method === 'GET'\) \{[\s\S]*?\n  \}/)
  assert.ok(sk, '/skills block found')
  // The read is the moment the user sees "off", so it is the last chance to
  // make that true.
  assert.match(sk[0], /fillShadowsSync\(sessionId, agent, skills, disabled\)/,
    '/skills must reconcile a missing shadow before answering')
  assert.match(sk[0], /disabled\.size > 0/,
    'it only needs to reconcile when something is actually off')
  assert.match(sk[0], /shadows\.get\(sessionId\) === undefined/,
    'and only when this session has no shadow layer yet')
})

test('the shadow candidate really hides the skill from the model', () => {
  // `modelInvocable: false` is what removes it from the catalog and makes the
  // skill tool refuse; rank 0 wins the same-layer duplicate. Both must hold, or
  // the shadow exists but does not actually hide anything.
  const cand = hostSrc.match(/function shadowCandidate\(def, skill\) \{[\s\S]*?\n\}/)
  assert.ok(cand, 'shadowCandidate not found')
  assert.match(cand[0], /modelInvocable: false/, 'the shadow must withdraw model invocation')
  assert.match(cand[0], /userInvocable: false/, 'and user invocation')
  assert.match(cand[0], /rank: 0/, 'rank 0 must settle a same-layer duplicate')
  // It must republish the SAME name, or it shadows nothing.
  assert.match(cand[0], /name: def\.name/, 'the shadow must reuse the skill name')
})
