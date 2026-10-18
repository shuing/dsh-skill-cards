/**
 * REGRESSION: "重启后面板显示关闭，但模型实际可用".
 *
 * The shadow layer is what makes "off" mean something to the model, and it is a
 * Cordis EFFECT owned by the AGENT's fiber. A session that comes back after a
 * restart (or is resumed after its agent was dropped) gets a NEW agent and a NEW
 * fiber — so the provider registered for the old agent is DISPOSED.
 *
 * The defect was `ensureShadowProvider` returning the cached state without
 * checking whether its registration was still alive:
 *
 *   fillShadowsSync → "already have a state" → return early → report success
 *   ...while nothing was registered, and every "off" skill stayed usable.
 *
 * The old harness could not catch this: its fake `registerProvider` never
 * disposed anything, so a stale handle looked healthy forever. These tests use
 * the REAL `@deepseek-ai/cordis` registry and the REAL `dsh-skill` layering, and
 * they drive the plugin's real `fillShadowsSync`, so a regression that trusts a
 * dead registration fails here.
 *
 * The fixture is skipped (rather than failed) when the harness packages are not
 * installed, so the suite still runs on a bare checkout.
 *
 * Run: node --test test/shadow-liveness.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Resolve one harness package's ESM entry, or undefined when absent. */
function harnessEntry(pkg) {
  // The packages may live beside the checkout (a DSH install) or in its
  // node_modules; probe both, plus an explicit override for CI.
  const override = process.env.DSH_HARNESS_ROOT
  const roots = [
    override,
    'C:/deepseek-harness/0.2.0-rc.2/node_modules/@deepseek-ai',
    join(process.cwd(), 'node_modules', '@deepseek-ai'),
  ].filter(Boolean)
  for (const root of roots) {
    const p = join(root, pkg, 'lib', 'index.js')
    if (existsSync(p)) return `file:///${p.replace(/\\/g, '/')}`
  }
  return undefined
}

const CORDIS = harnessEntry('cordis')
const SKILL = harnessEntry('dsh-skill')
const SCOPE = harnessEntry('dsh-scope')
const HAVE_HARNESS = Boolean(CORDIS && SKILL && SCOPE)

// The plugin itself is always importable.
const { fillShadowsSync, shadowedNames } = await import('../lib/index.js')

/** One skill file on disk, shaped like a real scanned entry. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-live-'))
  const skillFile = join(dir, 'alpha.md')
  writeFileSync(skillFile, '---\nname: alpha\ndescription: real skill\n---\nBODY\n')
  return { dir, skillFile, installed: [{ name: 'alpha', description: 'real skill', skillFile, rootDir: dir }] }
}

/** A real registry with one global, model-invocable `alpha`. */
async function realRegistry() {
  const { Context } = await import(CORDIS)
  const { default: SkillRegistry } = await import(SKILL)
  const { createScope } = await import(SCOPE)
  const root = new Context()
  await root.plugin(SkillRegistry)
  root.get('skills').registerProvider(() => ({
    name: 'fake-fs',
    async list() {
      return [{
        name: 'alpha',
        description: 'real skill',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'fs',
        provider: 'fake-fs',
        rank: 400,
        locator: { path: '/x' },
      }]
    },
    async get() {
      return {
        name: 'alpha',
        description: 'real skill',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'fs',
        path: '/x',
        content: 'BODY',
      }
    },
  }))
  return { root, skills: root.get('skills'), createScope }
}

/** What the MODEL would be offered in one scope. */
async function modelView(skills, scopeKey) {
  const list = await skills.list({ scope: scopeKey })
  return list.filter((s) => s.invocation?.modelInvocable !== false).map((s) => s.name)
}

test('a shadow registered for a DISPOSED agent is not trusted as live', { skip: !HAVE_HARNESS && 'harness packages not installed' }, async () => {
  const { dir, installed } = fixture()
  try {
    const { root, createScope, skills } = await realRegistry()

    // --- first agent: the shadow works ---
    const key1 = { id: 'agent-1' }
    const scope1 = createScope(root, key1)
    const agent1 = { id: 'agent-1', session: { id: 'agent-1' }, ctx: scope1.ctx }
    assert.equal(fillShadowsSync('agent-1', agent1, installed, new Set(['alpha'])), 1)
    assert.deepEqual(await modelView(skills, key1), [], 'the off skill must not reach the model')

    // --- the agent goes away: its fiber (and the provider) unloads ---
    await scope1.dispose()
    assert.deepEqual(shadowedNames('agent-1'), [],
      'a disposed registration must not linger in the shadow registry')

    // --- the SAME session comes back as a NEW agent (restart / resume) ---
    const key2 = { id: 'agent-1' }
    const scope2 = createScope(root, key2)
    const agent2 = { id: 'agent-1', session: { id: 'agent-1' }, ctx: scope2.ctx }
    const filled = fillShadowsSync('agent-1', agent2, installed, new Set(['alpha']))

    assert.equal(filled, 1, 'the fill must really re-register on the new agent')
    assert.deepEqual(await modelView(skills, key2), [],
      'THE REGRESSION: the panel says off, so the model must not see it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('turning a skill back on removes it from the shadow layer entirely', { skip: !HAVE_HARNESS && 'harness packages not installed' }, async () => {
  const { dir, installed } = fixture()
  try {
    const { root, createScope, skills } = await realRegistry()
    const key = { id: 'agent-2' }
    const scope = createScope(root, key)
    const agent = { id: 'agent-2', session: { id: 'agent-2' }, ctx: scope.ctx }

    fillShadowsSync('agent-2', agent, installed, new Set(['alpha']))
    assert.deepEqual(await modelView(skills, key), [])

    // The user turns it back on: the provider must now contribute NOTHING.
    fillShadowsSync('agent-2', agent, installed, new Set())
    assert.deepEqual(await modelView(skills, key), ['alpha'],
      'the shadow must mirror the disabled set exactly, not just add to it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a shadow is scoped to its own agent and never leaks to another', { skip: !HAVE_HARNESS && 'harness packages not installed' }, async () => {
  const { dir, installed } = fixture()
  try {
    const { root, createScope, skills } = await realRegistry()
    const keyA = { id: 'agent-a' }
    const keyB = { id: 'agent-b' }
    const scopeA = createScope(root, keyA)
    const scopeB = createScope(root, keyB)
    const agentA = { id: 'agent-a', session: { id: 'agent-a' }, ctx: scopeA.ctx }

    fillShadowsSync('agent-a', agentA, installed, new Set(['alpha']))

    assert.deepEqual(await modelView(skills, keyA), [], 'off in A')
    assert.deepEqual(await modelView(skills, keyB), ['alpha'],
      'B must keep the skill: the switch is session-scoped')
    assert.deepEqual(shadowedNames('agent-b'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
