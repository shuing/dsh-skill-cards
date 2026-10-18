#!/usr/bin/env node
/**
 * Repair sessions that the OLD code pinned to "nothing disabled" by accident.
 *
 * Background: `disabledForSession` used to seed from the scanned skill list, and
 * when no scan had run yet it fell back to the legacy list — then PERSISTED that
 * empty result as the session's permanent decision (`null` in `_sessionDisabled`).
 * A session created before the first scan was therefore pinned to "all on" and
 * "new chats start off" never applied to it.
 *
 * That is fixed in the host (an unscanned read now writes nothing), but the rows
 * already written stay. This script removes those rows so the sessions are
 * re-derived on their next visit.
 *
 * IT CANNOT TELL the two kinds of `null` apart:
 *   - "pinned by the old bug"          → should be reset
 *   - "the user really turned all on"  → must be kept
 * So it is NOT automatic. Dry-run by default; pass `--apply` to write. Review the
 * list first, and use `--keep <sessionId>` (repeatable) for any you recognise as
 * a real choice.
 *
 * Usage:
 *   node diagnose/reset-pinned-sessions.mjs                 # dry run
 *   node diagnose/reset-pinned-sessions.mjs --apply         # rewrite the store
 *   node diagnose/reset-pinned-sessions.mjs --apply --keep session-abc
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const STORE = join(DSH_HOME, 'skill-cards-stats.json')
const SESSION_KEY = '_sessionDisabled'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const keep = new Set()
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--keep' && argv[i + 1]) keep.add(argv[i + 1])
}

if (!existsSync(STORE)) {
  console.error(`no store at ${STORE}`)
  process.exit(2)
}

const raw = readFileSync(STORE, 'utf8')
let stats
try {
  stats = JSON.parse(raw)
} catch (error) {
  console.error(`store is not valid JSON: ${error.message}`)
  process.exit(2)
}

const all = stats?.[SESSION_KEY]
if (!all || typeof all !== 'object' || Array.isArray(all)) {
  console.log('no _sessionDisabled map — nothing to do')
  process.exit(0)
}

// A session is "pinned" when it holds the `null` sentinel. `{}` and real lists
// are left alone: those are unambiguously deliberate or already seeded.
const pinned = Object.entries(all).filter(([, v]) => v === null).map(([k]) => k)
const targets = pinned.filter((id) => !keep.has(id))

console.log(`store      : ${STORE}`)
console.log(`pinned     : ${pinned.length}`)
console.log(`keeping    : ${pinned.length - targets.length}`)
console.log(`to reset   : ${targets.length}`)
for (const id of targets) console.log('  -', id)

if (targets.length === 0) {
  console.log('\nnothing to reset')
  process.exit(0)
}

if (!apply) {
  console.log('\nDRY RUN — re-run with --apply to remove these rows.')
  console.log('Each removed session will be re-derived (default-off, if enabled) on its next visit.')
  process.exit(0)
}

const backup = `${STORE}.bak-pinned-${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(STORE, backup)
console.log(`\nbackup     : ${backup}`)

const nextMap = { ...all }
for (const id of targets) delete nextMap[id]
const next = { ...stats, [SESSION_KEY]: nextMap }
writeFileSync(STORE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
console.log(`wrote      : ${STORE}`)
console.log(`\nRestart DSH so the host re-seeds those sessions.`)
