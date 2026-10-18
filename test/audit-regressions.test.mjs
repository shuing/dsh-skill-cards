/**
 * Regression test for the bugs found while auditing the earlier feature work.
 *
 * Each test names the defect it prevents from coming back:
 *
 *  1. KEY DRIFT (the serious one). The per-session registries were written under
 *     the id the CLIENT sent and read back under the id the AGENT registry uses.
 *     The two spellings differ for a "session-"-prefixed chat id, so the turn-end
 *     restore looked up `temporarilyEnabled` under a key nothing had written:
 *     a skill that was OFF, applied for one turn, stayed VISIBLE for the rest of
 *     the session. Every registry now goes through `canonicalSession`.
 *
 *  2. /applied READ THE WRONG KEY. It answered from the raw id, so an applied
 *     session could report "nothing applied" and the composer chips vanished.
 *
 *  3. SESSION-MODE APPLY LEAKED ITS MODE. A spent hold left its `applyMode`
 *     entry behind, so /applied kept advertising a mode for a skill that was no
 *     longer applied.
 *
 *  4. CLIENT OVERRIDES SURVIVED A SESSION SWITCH. `enableOverrides` was never
 *     cleared, so a skill greyed out in chat A stayed grey in chat B — the exact
 *     cross-session bleed the isolation work was meant to remove.
 *
 *  5. MANUAL REVOKE DID NOT RELEASE THE TEMPORARY MARKER, so an OFF skill
 *     revoked by the composer chip kept its shadow lifted.
 *
 * Run: node --test test/audit-regressions.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { disabledForSession } from '../lib/index.js'
import { writeStats, DISABLED_KEY } from '../lib/stats.js'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientSrc = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

test('1. every route canonicalises the session key before touching a registry', () => {
  assert.match(hostSrc, /function canonicalSession\(ctx, sessionId\)/,
    'the canonical-key helper must exist')
  // It must consult the live agent, since the agent owns the authoritative id.
  const fn = hostSrc.match(/function canonicalSession\(ctx, sessionId\) \{[\s\S]*?\n\}/)
  assert.ok(fn, 'canonicalSession body not found')
  assert.match(fn[0], /resolveAgent\(ctx, sessionId\)/,
    'canonicalSession must resolve the live agent')
  // Every session-scoped route must use it.
  for (const route of ['introduce', 'switch', 'revoke']) {
    const block = hostSrc.match(new RegExp("if \\(route === '" + route + "'\\) \\{[\\s\\S]*?\\n  \\}"))
    assert.ok(block, route + ' block found')
    assert.match(block[0], /canonicalSession\(ctx, sessionId\)/,
      'the ' + route + ' route must canonicalise the session key')
  }
  // /applied canonicalises the id it will read with.
  const ap = hostSrc.match(/if \(route === 'applied' && method === 'GET'\) \{[\s\S]*?\n  \}/)
  assert.ok(ap, '/applied block found')
  assert.match(ap[0], /canonicalSession\(ctx, asked\)/,
    '/applied must canonicalise before reading the registries')
  // /skills canonicalises too, or the enabled flags are computed for no session.
  const sk = hostSrc.match(/if \(route === 'skills' && method === 'GET'\) \{[\s\S]*?\n  \}/)
  assert.ok(sk, '/skills block found')
  assert.match(sk[0], /canonicalSession\(ctx, asked\)/,
    '/skills must canonicalise the session id')
})

test('2. releaseSession looks the temporary markers up under the key that held them', () => {
  const rel = hostSrc.match(/function releaseSession\(sessionId, observedTurn\) \{[\s\S]*?\n\}/)
  assert.ok(rel, 'releaseSession not found')
  // It must remember WHICH id matched, not re-use the raw argument.
  assert.match(rel[0], /let holder/,
    'releaseSession must track the id that actually held the names')
  assert.match(rel[0], /temporarilyEnabled\.get\(holder\)/,
    'the temporary markers must be read under the holding key')
  assert.match(rel[0], /applyMode\.get\(holder\)/,
    'the mode labels must be read under the holding key')
})

test('3. a spent hold drops its mode label along with the registration', () => {
  const rel = hostSrc.match(/function releaseSession\(sessionId, observedTurn\) \{[\s\S]*?\n\}/)
  assert.ok(rel, 'releaseSession not found')
  assert.match(rel[0], /modes\?\.delete\(name\)/,
    'releasing a hold must drop its applyMode entry')
})

test('5. a manual revoke releases the temporary marker too', () => {
  const rv = hostSrc.match(/if \(route === 'revoke'\) \{[\s\S]*?\n  \}/)
  assert.ok(rv, '/revoke block found')
  assert.match(rv[0], /forgetTemporary\(key, n\)/,
    'a manual revoke must drop the temporary marker, or the shadow stays lifted')
})

test('4. the client drops session-scoped state when the session changes', () => {
  // enableOverrides is session-scoped (it mirrors the per-session switch), so it
  // must not survive into another chat.
  assert.match(clientSrc, /setEnableOverrides\(\{\}\)/,
    'the switch overrides must be clearable')
  // The panel's session is now an EXPLICIT prop, not a read of the shared store,
  // so the reset hangs off that prop rather than off a store read.
  const swEffect = clientSrc.match(/const liveSessionId = ownSessionId[\s\S]*?\}, \[load, liveSessionId\]\)/)
  assert.ok(swEffect, 'the session-change effect must exist')
  assert.match(swEffect[0], /setSelected\(new Set\(\)\)/,
    'a session switch must drop the previous selection')
  assert.match(swEffect[0], /setEnableOverrides\(\{\}\)/,
    'a session switch must drop the previous switch overrides')
  // ...and every load clears them, so a refresh cannot resurrect a stale gate.
  const load = clientSrc.match(/const load = useCallback\(async \(\) => \{[\s\S]*?\n      \}, \[ownSessionId\]\)/)
  assert.ok(load, 'load not found')
  assert.match(load[0], /setEnableOverrides\(\{\}\)/,
    'load must clear the session-scoped switch overrides')
  // The store's own session write must honour `undefined`, or switching to a
  // blank chat keeps the previous id and every request names the old session.
  assert.match(clientSrc, /const next = typeof id === 'string' && id !== '' \? id : undefined/,
    'setSession must treat "no id" as a real value, not as "keep the old one"')
})

test('regression: the disabled seed still preserves a user\'s existing choices', () => {
  const home = mkdtempSync(join(tmpdir(), 'sc-audit-'))
  try {
    writeStats(home, { [DISABLED_KEY]: { legacy: false } })
    assert.ok(disabledForSession(home, 's1').has('legacy'),
      'the legacy machine-wide choice must seed a new session')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
