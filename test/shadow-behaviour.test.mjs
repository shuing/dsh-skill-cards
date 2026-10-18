/**
 * BEHAVIOURAL test for the shadow layer — "面板关了，模型还能用".
 *
 * The source-shape tests in shadow-ordering.test.mjs can pass while the actual
 * registration is broken. This one drives the real function with a fake agent
 * context and asserts that the shadow provider really receives the disabled
 * names, which is the only thing that decides whether the model can use them.
 *
 * Run: node --test test/shadow-behaviour.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  disabledForSession, reapplyShadows, rememberInstalled, shadowedNames,
} from '../lib/index.js'
import { writeStats, writeDisableByDefault } from '../lib/stats.js'

/** A throwaway DSH home holding two skills. */
function fixture(names) {
  const home = mkdtempSync(join(tmpdir(), 'sc-shadow-'))
  for (const name of names) {
    const dir = join(home, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# body\n`)
  }
  return home
}

/**
 * A fake agent whose context exposes a `skills` service recording every
 * provider registration, so the test can see what the model would be offered.
 */
function fakeAgent(serviceReady = true, readyAfter = 0) {
  const providers = []
  let calls = 0
  const skills = {
    registerProvider(create) {
      providers.push(create({ signal: { aborted: false }, invalidate() {} }))
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name !== 'skills') return undefined
      if (!serviceReady) return undefined
      calls += 1
      return calls > readyAfter ? skills : undefined
    },
  }
  return { agent: { id: 'fake', session: { id: 'fake' }, ctx }, providers, skills }
}

/** What the shadow provider would hand the skill registry right now. */
async function offered(providers) {
  const out = []
  for (const p of providers) {
    if (typeof p.list !== 'function') continue
    const list = await p.list({})
    for (const c of list || []) out.push({ name: c.name, modelInvocable: c.invocation?.modelInvocable })
  }
  return out
}

test('a default-off session really shadows every installed skill', async () => {
  const home = fixture(['alpha', 'beta'])
  try {
    writeStats(home, {})
    writeDisableByDefault(home, true)
    const { agent, providers } = fakeAgent()
    // No prior scan: reapplyShadows must do it itself, or the seed is empty.
    await reapplyShadows({ get: () => undefined }, home, 's1', agent)

    assert.deepEqual(shadowedNames('s1').sort(), ['alpha', 'beta'],
      'every installed skill must end up in the shadow layer')
    const list = await offered(providers)
    assert.equal(list.length, 2, 'the shadow provider must republish both names')
    assert.ok(list.every((c) => c.modelInvocable === false),
      'and every one must be non-invocable, or the model can still use it')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a skill that is NOT disabled is not shadowed', async () => {
  const home = fixture(['alpha', 'beta'])
  try {
    writeStats(home, {})
    // default-off ON, but this session already decided alpha is fine.
    writeDisableByDefault(home, true)
    const set = disabledForSession(home, 's2')
    set.delete('alpha')

    const { agent, providers } = fakeAgent()
    await reapplyShadows({ get: () => undefined }, home, 's2', agent)
    const list = await offered(providers)
    assert.deepEqual(list.map((c) => c.name), ['beta'],
      'only the disabled skill may be shadowed')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('reapplyShadows survives a skills service that appears late', async () => {
  const home = fixture(['alpha'])
  try {
    writeStats(home, {})
    writeDisableByDefault(home, true)
    // The service is missing for the first two probes, then becomes available —
    // exactly the 'agent-added' race that left the shadow unregistered.
    const { agent, providers } = fakeAgent(true, 2)
    await reapplyShadows({ get: () => undefined }, home, 's3', agent)
    assert.deepEqual(shadowedNames('s3'), ['alpha'],
      'a late-arriving skills service must still get the shadow')
    assert.equal(providers.length, 1, 'and only one provider is registered')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('with default-off OFF nothing is shadowed', async () => {
  const home = fixture(['alpha'])
  try {
    writeStats(home, {})
    writeDisableByDefault(home, false)
    rememberInstalled(['alpha'])
    const { agent, providers } = fakeAgent()
    await reapplyShadows({ get: () => undefined }, home, 's4', agent)
    assert.deepEqual(shadowedNames('s4'), [], 'nothing off means nothing shadowed')
    assert.equal(providers.length, 0, 'and no provider is even registered')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
