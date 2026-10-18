/**
 * Enumerate the user's locally-installed skills and read their metadata.
 *
 * The harness discovers a skill by finding a directory that directly contains
 * `SKILL.md` (or a flat `<name>.md`). This module mirrors that discovery so the
 * card panel can list exactly what the agent would see, and it looks for an
 * optional `cover.png` / `cover.jpg` next to `SKILL.md` to use as the card image.
 * @module dsh-skill-cards/skills-scan
 */
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'

/** Priority: explicit $DSH_HOME > ~/.dsh. */
export function defaultDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv || join(homedir(), '.dsh')
}

/**
 * The global user skill roots the harness scans.
 *
 * Ordered by precedence. On macOS/Linux the real-world locations are:
 *   - `~/.agents/skills`  — where the agent CLI installs skills (the primary one)
 *   - `~/.claude/skills`  — the Claude-compatible pool the harness also reads
 *   - `~/.dsh/skills`     — DSH's own user root
 * A missing directory is simply skipped by the scanner.
 */
export function userSkillRoots(home, env = process.env) {
  const base = dirname(home) // ~/.dsh -> ~
  const roots = [
    { path: join(home, 'skills'), source: 'user-dsh', label: 'DSH 用户技能' },
    { path: join(base, '.agents', 'skills'), source: 'user-agents', label: 'Agent 技能' },
    { path: join(base, '.claude', 'skills'), source: 'user-claude', label: 'Claude 兼容技能' },
  ]
  // Escape hatch for skills kept outside the well-known locations (a synced
  // folder, a dotfiles repo, a Windows path that is not under the profile).
  // Separator is the platform convention: ';' on Windows, ':' elsewhere.
  // A root that matches one already listed is ignored, so listing the default
  // paths explicitly is harmless.
  const extra = splitRoots(env.DSH_SKILL_CARDS_ROOTS)
  for (const path of extra) {
    if (roots.some((r) => samePath(r.path, path))) continue
    roots.push({ path, source: 'custom', label: '自定义目录' })
  }
  return roots
}

/** Split a root list on the platform's path-list separator. */
function splitRoots(value) {
  if (typeof value !== 'string') return []
  return value.split(delimiter()).map((s) => s.trim()).filter(Boolean)
}

/** `;` on Windows, `:` elsewhere (delimiter lives on win32). */
function delimiter(platform = process.platform) {
  return platform === 'win32' ? ';' : ':'
}

/** Compare two paths case-insensitively on Windows, where C:\a == c:\A. */
function samePath(a, b, platform = process.platform) {
  const norm = (p) => (platform === 'win32' ? p.toLowerCase() : p)
  return norm(a) === norm(b)
}

const COVER_NAMES = ['cover.png', 'cover.jpg', 'cover.jpeg', 'cover.webp', 'cover.svg', 'preview.png', 'preview.jpg']

/**
 * Whether a directory/file name may be used as a skill name.
 *
 * Deliberately permissive: this name is used to build a `resourceBase` DIRECTORY
 * path and to match a key in the stats store — it is never passed to a shell, so
 * the only characters that actually matter are the ones that would break a path
 * or a JSON key.
 *
 * An earlier ASCII-only rule (`[a-zA-Z0-9._-]`) silently dropped any skill whose
 * directory was not English: a folder named 中文技能 produced no card at all, and
 * the panel looked empty with no explanation. Non-ASCII names are perfectly valid
 * on disk, so they are accepted.
 *
 * Rejected: path separators (the name becomes a path segment), control and
 * bidi-override characters (they can make two different names render identically),
 * leading dots (hidden files), and the empty string.
 */
function isSkillName(name) {
  if (typeof name !== 'string' || name === '') return false
  if (name.startsWith('.')) return false
  // eslint-disable-next-line no-control-regex -- control/bidi exclusion is the point
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) return false
  // Bidi overrides + isolates can spoof a different displayed name.
  if (/[\u202a-\u202e\u2066-\u2069]/.test(name)) return false
  return true
}

/**
 * Parse the YAML frontmatter block of a SKILL.md (name / description).
 *
 * Dependency-free and tolerant: missing or malformed frontmatter yields
 * undefined fields rather than throwing. Handles the three shapes that actually
 * occur in the wild:
 *   - inline:        `description: some text`
 *   - quoted:        `description: "some: text"`  (colons are not separators)
 *   - block scalar:  `description: |-` / `>` followed by an indented body,
 *                    which real skills use for long prose. Without this the
 *                    value would come out as the literal characters "|-".
 */
function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return {}
  const lines = match[1].split(/\r?\n/)
  const data = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    const key = kv[1]
    let value = kv[2].trim()

    // Block scalar: `|`, `|-`, `|+`, `>`, `>-`, `>+` (optionally with a comment).
    if (/^[|>][+-]?\d*\s*(#.*)?$/.test(value)) {
      const folded = value.startsWith('>')
      const body = []
      let indent = null
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]
        if (line.trim() === '') { body.push(''); continue }
        const lead = line.match(/^\s*/)[0].length
        if (indent === null) {
          if (lead === 0) break // block ended without any indented content
          indent = lead
        } else if (lead < indent) {
          break
        }
        body.push(line.slice(indent))
      }
      // Trim the trailing blank lines the block always ends with.
      while (body.length && body[body.length - 1] === '') body.pop()
      value = folded ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n').trim()
      i += body.length
      data[key] = value
      continue
    }

    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return data
}

/**
 * Scan one root directory for skills.
 * @returns array of { name, description, source, label, rootDir, skillFile, hasCover }
 */
export async function scanRoot(root, source, label) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) continue
    const isDirectory = entry.isDirectory()
    const baseName = entry.name
    // Directory skill: <root>/<name>/SKILL.md
    // Flat skill: <root>/<name>.md
    const skillFile = isDirectory ? join(root, baseName, 'SKILL.md') : join(root, baseName)
    if (!existsSync(skillFile)) continue
    const skillName = isDirectory ? baseName : baseName.replace(/\.md$/, '')
    if (!isSkillName(skillName)) continue
    let raw = ''
    try {
      raw = await readFile(skillFile, 'utf8')
    } catch {
      continue
    }
    const fm = parseFrontmatter(raw)
    const name = (fm.name && isSkillName(fm.name)) ? fm.name : skillName
    const description = fm.description ?? ''
    // cover image: same directory as SKILL.md
    const coverDir = isDirectory ? join(root, baseName) : root
    let hasCover = false
    for (const c of COVER_NAMES) {
      if (existsSync(join(coverDir, c))) {
        hasCover = true
        break
      }
    }
    out.push({
      name,
      description,
      source,
      label,
      rootDir: isDirectory ? join(root, baseName) : root,
      skillFile,
      hasCover,
    })
  }
  return out
}

/**
 * Scan all known local skill roots (global + common project-level roots for the
 * current working directory). `cwd` lets us also pick up .dsh/skills and
 * .agents/skills next to the user's project.
 */
export async function scanInstalled(home, cwd) {
  const roots = [...userSkillRoots(home)]
  if (cwd && cwd !== home) {
    roots.push({ path: join(cwd, '.dsh', 'skills'), source: 'project-dsh', label: '项目 .dsh/skills' })
    roots.push({ path: join(cwd, '.agents', 'skills'), source: 'project-agents', label: '项目 .agents/skills' })
  }
  const lists = await Promise.all(roots.map((r) => scanRoot(r.path, r.source, r.label)))
  const merged = new Map()
  for (let i = 0; i < lists.length; i++) {
    for (const s of lists[i]) {
      // prefer the global/user root when names collide
      if (!merged.has(s.name)) merged.set(s.name, s)
    }
  }
  const skills = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
  // Report which roots were actually consulted and how many skills each one
  // contributed. When the panel comes up empty, this is the difference between
  // "your skills live somewhere we don't look" and "the folder exists but holds
  // no valid SKILL.md" — previously the user could only guess, which made a
  // missing-directory case indistinguishable from a broken install.
  const diagnostics = roots.map((r, i) => ({
    path: r.path,
    label: r.label,
    exists: existsSync(r.path),
    found: lists[i].length,
  }))
  return { skills, diagnostics }
}

/** Read an optional cover image file from a skill directory. */
export async function readCover(skillRootDir, skillFile) {
  const coverDir = dirname(skillFile)
  for (const c of COVER_NAMES) {
    const p = join(coverDir, c)
    try {
      const s = await stat(p)
      if (s.isFile()) {
        const buf = await readFile(p)
        const ext = c.split('.').pop().toLowerCase()
        const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'webp' ? 'image/webp' : ext === 'jpg' ? 'image/jpeg' : 'image/png'
        return { buffer: buf, mime }
      }
    } catch {
      /* not found, try next */
    }
  }
  return null
}
