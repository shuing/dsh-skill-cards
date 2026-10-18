/**
 * Behavioural test for the ACTUAL reported bug:
 * "第一个会话默认关闭，但面板显示开启 / 面板关了实际还能用".
 *
 * The panel and the model disagreed because the shadow provider was filled
 * asynchronously while /skills answered synchronously. Two things had to hold
 * together, and only one did:
 *
 *   - the disabled SET was right (so the panel said "off"), and
 *   - the shadow PROVIDER was populated (so the model obeyed).
 *
 * These tests drive `fillShadowsSync` — the function /skills now calls inline —
 * and assert on what the provider actually hands the registry, because that is
 * the only thing that decides whether the model can use a skill.
 *
 * Run: node --test test/shadow-sync.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  disabledForSession, fillShadowsSync, shadowedNames, rememberInstalled,
} from '../lib/index.js'
import { writeStats, writeDisableByDefault } from '../lib/stats.js'
import { scanInstalled } from '../lib/skills-scan.js'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

function fixture(names) {
  const home = mkdtempSync(join(tmpdir(), 'sc-sync-'))
  for (const name of names) {
    const dir = join(home, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: d\n---\n# body\n')
  }
  return home
}

/** An agent whose context exposes a recording `skills` service. */
function fakeAgent(id, ready) {
  const providers = []
  const skills = {
    registerProvider(create) {
      providers.push(create({ signal: { aborted: false }, invalidate() {} }))
      return () => {}
    },
  }
  return {
    agent: { id, session: { id }, ctx: { get: (n) => (n === 'skills' && ready ? skills : undefined) } },
    providers,
  }
}

test('fillShadowsSync populates the provider in the SAME tick', async () => {
  const home = fixture(['alpha', 'beta'])
  try {
    writeStats(home, {})
    writeDisableByDefault(home, true)
    const skills = (await scanInstalled(home, process.cwd())).skills
    rememberInstalled(skills)
    const disabled = disabledForSession(home, 'sync-1')
    const { agent, providers } = fakeAgent('sync-1', true)

    const filled = fillShadowsSync('sync-1', agent, skills, disabled)
    assert.equal(filled, 2, 'both skills are filled synchronously')
    assert.deepEqual(shadowedNames('sync-1').sort(), ['alpha', 'beta'])

    for (const p of providers) {
      const list = await p.list({})
      assert.ok(list.length === 2 && list.every((c) => c.invocation.modelInvocable === false),
        'every shadowed skill must be non-invocable')
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('fillShadowsSync returns 0 (not a throw) when the service is absent', () => {
  const home = fixture(['alpha'])
  try {
    writeStats(home, {})
    writeDisableByDefault(home, true)
    const { agent } = fakeAgent('sync-2', false)
    const skills = [{ name: 'alpha', skillFile: join(home, 'skills', 'alpha', 'SKILL.md'), description: 'd' }]
    const filled = fillShadowsSync('sync-2', agent, skills, new Set(['alpha']))
    assert.equal(filled, 0, 'an absent skills service must report 0, never throw')
    assert.deepEqual(shadowedNames('sync-2'), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('/skills fills the shadow SYNCHRONOUSLY, so the answer matches enforcement', () => {
  const sk = hostSrc.match(/if \(route === 'skills' && method === 'GET'\) \{[\s\S]*?\n  \}/)
  assert.ok(sk, '/skills block found')
  assert.match(sk[0], /fillShadowsSync\(sessionId, agent, skills, disabled\)/,
    '/skills must fill the shadow inline')
  assert.ok(!/void reapplyShadows/.test(sk[0]),
    '/skills must not fire-and-forget the shadow: that is exactly the bug')
})

test('reapplyShadows fills synchronously before its retry loop', () => {
  const fn = hostSrc.match(/export async function reapplyShadows\(ctx, home, sessionId, agent\) \{[\s\S]*?\n\}/)
  assert.ok(fn, 'reapplyShadows not found')
  const fillAt = fn[0].indexOf('fillShadowsSync(')
  const retryAt = fn[0].indexOf('for (let attempt = 0')
  assert.ok(fillAt !== -1, 'it must fill synchronously')
  assert.ok(retryAt !== -1, 'and still retry for a late service')
  assert.ok(fillAt < retryAt,
    'the synchronous fill must run FIRST; the retry only covers an absent service')
})

test('the synchronous reader exists and mirrors the async one', () => {
  assert.match(hostSrc, /function readSkillContentSync\(skill\)/,
    'a synchronous body reader is required for the inline fill')
  const fn = hostSrc.match(/function readSkillContentSync\(skill\) \{[\s\S]*?\n\}/)
  assert.ok(fn, 'readSkillContentSync not found')
  assert.match(fn[0], /readFileSync\(skill\.skillFile, 'utf8'\)/, 'it must read the file synchronously')
  assert.match(fn[0], /name: skill\.name/, 'and keep the same shape as the async reader')
})
