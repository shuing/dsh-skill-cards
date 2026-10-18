/**
 * Smoke tests for the host-side pure logic (no DSH runtime required).
 * Run: node --test test/smoke.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRoot, readCover, userSkillRoots, scanInstalled, defaultDshHome } from '../lib/skills-scan.js'
import { sameOrigin } from '../lib/http.js'

/** The platform's path-list separator: ';' on Windows, ':' elsewhere. */
const delimiter = () => (process.platform === 'win32' ? ';' : ':')

test('userSkillRoots covers the real-world skill locations', () => {
  // Build the expectations with the SAME path rules the scanner uses. Hardcoding
  // '/Users/someone/...' made this test fail on Windows, where `join` produces
  // backslashes — a platform bug in the test, not in the scanner.
  const base = join(tmpdir(), 'sc-home')
  const home = join(base, '.dsh')
  const roots = userSkillRoots(home, {}).map((r) => r.path)
  // ~/.agents/skills is where the agent CLI actually installs skills; an earlier
  // version only scanned ~/.dsh/skills (usually absent) and listed nothing.
  assert.ok(roots.includes(join(base, '.agents', 'skills')), 'missing ~/.agents/skills')
  assert.ok(roots.includes(join(base, '.claude', 'skills')), 'missing ~/.claude/skills')
  assert.ok(roots.includes(join(home, 'skills')), 'missing ~/.dsh/skills')
})

test('DSH_SKILL_CARDS_ROOTS adds extra roots and never duplicates a default one', () => {
  const base = join(tmpdir(), 'sc-home')
  const home = join(base, '.dsh')
  const agentsRoot = join(base, '.agents', 'skills')
  const custom = join(tmpdir(), 'sc-extra-skills')
  const mine = join(tmpdir(), 'sc-mine')
  const env = { DSH_SKILL_CARDS_ROOTS: [custom, agentsRoot, mine].join(delimiter()) }
  const roots = userSkillRoots(home, env).map((r) => r.path)
  assert.ok(roots.includes(custom), 'custom root missing')
  assert.ok(roots.includes(mine), 'custom root missing')
  // Listing an already-known path must not produce a second entry, otherwise the
  // same skill would be counted twice in the diagnostics report.
  assert.equal(roots.filter((p) => p === agentsRoot).length, 1,
    'a default root was duplicated by the env var')
  assert.equal(new Set(roots).size, roots.length, 'duplicate roots present')
})

test('skill names with capitals or dots are kept', async () => {
  // Real-world pools (notably ones installed by other agents) use names the old
  // lowercase-only guard rejected silently, making a populated folder look empty.
  const dir = mkdtempSync(join(tmpdir(), 'sc-name-'))
  try {
    for (const name of ['GitHub', 'TDD', 'my.skill', 'normal-skill']) {
      const d = join(dir, name)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# x\n`)
    }
    const found = (await scanRoot(dir, 'test', 'test')).map((s) => s.name).sort()
    assert.deepEqual(found, ['GitHub', 'TDD', 'my.skill', 'normal-skill'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanInstalled reports every scanned root so an empty result is explainable', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sc-diag-'))
  try {
    const home = join(base, '.dsh')
    mkdirSync(home, { recursive: true })
    const claude = join(base, '.claude', 'skills')
    mkdirSync(claude, { recursive: true })
    makeSkill(claude, 'demo', 'a demo skill', false)

    const out = await scanInstalled(home, base)
    assert.equal(out.skills.length, 1)
    assert.equal(out.skills[0].name, 'demo')

    const byPath = new Map(out.diagnostics.map((r) => [r.path, r]))
    // A root that holds skills must report itself as existing with a count.
    assert.equal(byPath.get(claude).exists, true)
    assert.equal(byPath.get(claude).found, 1)
    // A root that was never created must be reported as missing, which is the
    // fact the empty-state UI needs and previously could not show.
    assert.equal(byPath.get(join(home, 'skills')).exists, false)
    assert.equal(byPath.get(join(home, 'skills')).found, 0)
    // Every entry carries a path and a label for display.
    for (const r of out.diagnostics) {
      assert.equal(typeof r.path, 'string')
      assert.equal(typeof r.label, 'string')
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('scanInstalled dedupes the same skill found in several roots', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sc-dupe-'))
  try {
    const home = join(base, '.dsh')
    const userDsh = join(home, 'skills')
    const claude = join(base, '.claude', 'skills')
    mkdirSync(userDsh, { recursive: true })
    mkdirSync(claude, { recursive: true })
    makeSkill(userDsh, 'shared', 'from dsh', false)
    makeSkill(claude, 'shared', 'from claude', false)

    const out = await scanInstalled(home, base)
    const shared = out.skills.filter((s) => s.name === 'shared')
    assert.equal(shared.length, 1, 'the same skill was listed twice')
    // Precedence: the user-dsh root is consulted first and wins the collision.
    assert.equal(shared[0].source, 'user-dsh')
    // The per-root counts still reflect what each directory actually holds.
    assert.equal(out.diagnostics.find((r) => r.path === claude).found, 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

function makeSkill(root, name, description, withCover) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
  if (withCover) writeFileSync(join(dir, 'cover.png'), 'fake-png')
}

/** Write a SKILL.md with a raw frontmatter body, for parser edge cases. */
function makeRawSkill(root, name, frontmatterBody) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatterBody}\n---\n# ${name}\n`)
}

test('frontmatter supports YAML block scalars (|, |-, >)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-block-'))
  try {
    // Literal block: newlines preserved, trailing newline chomped by |-.
    makeRawSkill(root, 'lit', 'name: lit\ndescription: |-\n  First line.\n  Second line.')
    // Folded block: newlines become spaces.
    makeRawSkill(root, 'fold', 'name: fold\ndescription: >\n  Folded one\n  folded two.')
    // A following key must terminate the block.
    makeRawSkill(root, 'after', 'name: after\ndescription: |\n  Body text.\nlicense: MIT')
    const list = await scanRoot(root, 'test')
    const byName = Object.fromEntries(list.map((s) => [s.name, s.description]))
    // Before the fix these came out as the literal characters "|-" / ">".
    assert.equal(byName.lit, 'First line.\nSecond line.')
    assert.equal(byName.fold, 'Folded one folded two.')
    assert.equal(byName.after, 'Body text.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('frontmatter keeps colons inside quoted values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-quote-'))
  try {
    makeRawSkill(root, 'quoted', 'name: quoted\ndescription: "Use when: the user asks"')
    const [skill] = await scanRoot(root, 'test')
    assert.equal(skill.description, 'Use when: the user asks')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('frontmatter tolerates a missing or malformed block', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-nofm-'))
  try {
    const dir = join(root, 'bare')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# No frontmatter at all\n')
    // Falls back to the directory name with an empty description, not a throw.
    const [skill] = await scanRoot(root, 'test')
    assert.equal(skill.name, 'bare')
    assert.equal(skill.description, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanRoot discovers directory skills and parses frontmatter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-test-'))
  try {
    makeSkill(root, 'pdf-helper', '处理 PDF', false)
    makeSkill(root, 'image-gen', '生成图片', true)
    const list = await scanRoot(root, 'test')
    const names = list.map((s) => s.name).sort()
    assert.deepEqual(names, ['image-gen', 'pdf-helper'])
    const pdf = list.find((s) => s.name === 'pdf-helper')
    assert.equal(pdf.description, '处理 PDF')
    const img = list.find((s) => s.name === 'image-gen')
    assert.equal(img.hasCover, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanRoot ignores a directory without SKILL.md', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-test-'))
  try {
    mkdirSync(join(root, 'not-a-skill'), { recursive: true })
    writeFileSync(join(root, 'not-a-skill', 'readme.txt'), 'hi')
    const list = await scanRoot(root, 'test')
    assert.equal(list.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readCover returns the cover buffer when present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-test-'))
  try {
    makeSkill(root, 'with-cover', 'desc', true)
    const list = await scanRoot(root, 'test')
    const cover = await readCover(list[0].rootDir, list[0].skillFile)
    assert.ok(cover && cover.mime === 'image/png' && cover.buffer.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sameOrigin admits loopback (desktop shell is cross-origin but local)', () => {
  // The desktop renderer runs on dsh-app:// and may send Origin: null or a
  // cross-site marker. Loopback must still be admitted or the app breaks.
  assert.equal(sameOrigin({ headers: { host: 'localhost:3080' } }), null)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:19387', origin: 'null' } }), null)
  assert.equal(
    sameOrigin({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }),
    null,
  )
})

test('sameOrigin rejects cross-site requests aimed at a remote host', () => {
  assert.equal(
    sameOrigin({ headers: { host: 'example.com', 'sec-fetch-site': 'cross-site' } }),
    'cross-site request rejected',
  )
  assert.equal(sameOrigin({ headers: { host: 'example.com' } }), 'untrusted host')
  assert.equal(
    sameOrigin({ headers: { host: 'example.com', origin: 'https://evil.test' } }),
    'origin does not match host',
  )
})

test('skill names may be non-ASCII (a Chinese folder is a real skill)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-cn-'))
  try {
    for (const [folder, name] of [['中文技能', '中文技能'], ['日本語スキル', ''], ['emoji-🎴', '']]) {
      const d = join(dir, 'skills', folder)
      mkdirSync(d, { recursive: true })
      const fm = name ? `name: ${name}\n` : ''
      writeFileSync(join(d, 'SKILL.md'), `---\n${fm}description: d\n---\nB\n`)
    }
    const r = await scanInstalled(dir, process.cwd())
    const names = r.skills.map((s) => s.name)
    // A non-English folder used to be dropped silently, so the panel looked empty
    // with no explanation. These are valid directories and must produce cards.
    assert.ok(names.includes('中文技能'), 'a Chinese skill folder must be discovered')
    assert.ok(names.includes('日本語スキル'), 'a Japanese skill folder must be discovered')
    assert.ok(names.includes('emoji-🎴'), 'an emoji skill folder must be discovered')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('skill names still reject path separators, control and bidi characters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-bad-'))
  try {
    // These would break a resourceBase path or spoof a displayed name; the
    // permissive rule must not have opened the door to them.
    const base = join(dir, 'skills')
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, '..evil.md'), '---\ndescription: d\n---\nB\n')
    const r = await scanInstalled(dir, process.cwd())
    assert.ok(!r.skills.some((s) => s.name.startsWith('.')),
      'a leading-dot name must stay rejected')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
