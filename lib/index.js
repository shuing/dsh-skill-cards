/**
 * Host half of dsh-skill-cards.
 *
 * Responsibilities:
 *  - Expose HTTP routes the browser client calls (relative path fetch).
 *  - Enumerate locally-installed skills (global + project roots).
 *  - Serve an optional cover image from each skill directory.
 *  - Persist the user's custom card config (image / title / description) per skill.
 *  - Introduce selected skills into the *current session* only, by registering
 *    them on the agent's session-scoped skills service (no disk writes, so other
 *    sessions and the global catalog are untouched). The introduced set is
 *    persisted so a host restart can replay it for that session.
 *
 * Slots occupied (host side): none. The UI lives entirely in the client half.
 * @module dsh-skill-cards
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { createLogger, readJsonBody, readRawBody, sameOrigin, sendError, sendJson, sendFile } from './http.js'
import { defaultDshHome, scanInstalled, readCover } from './skills-scan.js'
import {
  CATEGORY_DEFS, suggestCategory, bumpUse, readStats, writeStats, categoriesFor,
  readCustomCategories, addCustomCategory, removeCustomCategory, renameCustomCategory,
  PREF_VALUES, readPrefs, writePrefs, readDisabled,
  SESSION_DISABLED_KEY, readSessionDisabled, writeSessionDisabled,
  DISABLE_BY_DEFAULT_KEY, readDisableByDefault, writeDisableByDefault,
} from './stats.js'

const NS = 'dsh-skill-cards'
/**
 * Route prefix. DSH forwards only `/api/*` and `/plugins/*` from the shell to
 * the plugin host; any other prefix is answered 404 by the shell before it ever
 * reaches `webServer`. `/plugins/<package-name>` is the house convention and is
 * what the other installed plugins use (e.g. `/plugins/dsh-trae-checkin/...`).
 *
 * NOTE: no trailing slash. The host matches a prefix route with
 *   `pathname === prefix || pathname.startsWith(prefix + '/')`
 * (dsh-host-webserver `match()`), so registering a trailing slash would demand a
 * double slash in the request path and nothing would ever match — the route
 * silently 404s while everything else looks healthy.
 */
const API_PREFIX = '/plugins/dsh-skill-cards'
/** Same prefix as it appears in a request path; used to strip the route tail. */
const API_BASE = `${API_PREFIX}/`
const GET_ROUTES = ['skills', 'cards', 'cover', 'active-session', 'image', 'vendor', 'stats', 'applied', 'prefs', 'switch', 'default-off', 'shadow-state']
const POST_ROUTES = ['cards', 'introduce', 'revoke', 'image', 'stats', 'categories', 'i18n', 'prefs', 'switch', 'default-off']

/** Where uploaded custom cover images are stored (as files, never base64 in JSON). */
const IMAGE_DIR_NAME = 'skill-cards-images'
/** MIME → extension for accepted uploads. */
const IMAGE_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
}

/** Where the custom card config (image/title/description per skill) is stored. */
function cardConfigPath(home) {
  return join(home, 'skill-cards.json')
}

function readCardConfig(home) {
  const p = cardConfigPath(home)
  if (!existsSync(p)) return {}
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeCardConfig(home, config) {
  const p = cardConfigPath(home)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf8')
}

/** Directory where uploaded custom cover images are stored. */
function imageStoreDir(home) {
  return join(home, IMAGE_DIR_NAME)
}

/** Resolve the on-disk path for a stored image id. */
function imagePath(home, id) {
  return join(imageStoreDir(home), id)
}

/**
 * Persist an uploaded image as a file and return a protected route URL.
 *
 * The browser reads a local file as a data:/blob URL; we do NOT persist that
 * base64 string into skill-cards.json (it would balloon the config). Instead we
 * write the raw bytes to `~/.dsh/skill-cards-images/<sha256><ext>` and hand back
 * a `/plugins/.../image?id=...` URL that the GET route serves with a bounded
 * cache. Only that URL is stored in the card config.
 */
function saveImage(home, buffer, mime, ext = IMAGE_MIME[mime] ?? '.png') {
  const dir = imageStoreDir(home)
  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 24)
  const id = `${hash}${ext}`
  const p = join(dir, id)
  if (!existsSync(p)) writeFileSync(p, buffer)
  return `${API_BASE}image?id=${encodeURIComponent(id)}`
}

/**
 * Session lifecycle listener.
 *
 * WHY THIS NO LONGER USES `agents.on(...)`: `AgentRegistry extends Service`, and
 * `Service` has no `on()` — verified against the shipped build, where
 * `typeof AgentRegistry.prototype.on === 'undefined'`. The previous code guarded
 * with `if (typeof agents.on === 'function')`, so EVERY listener below silently
 * never registered. That is not a cosmetic difference: the turn-end release is
 * what makes "应用到本轮" one-shot, so its absence left the apply registered for
 * the rest of the session (the reported "本轮生效的技能撤不回来").
 *
 * Agent lifecycle is a Cordis EVENT, dispatched on `ctx` through the agent's
 * scope carrier, so the correct subscription is `ctx.on('agent/created' | …)`
 * exactly as the built-in plugins do (`dsh-goal`, `dsh-compaction-basic`, …).
 * The `agent` always arrives in the payload; it is never `this`.
 */
class ActiveSessionTracker {
  constructor(ctx) {
    this.ctx = ctx
    this._disposers = []
    this._wire()
  }

  _wire() {
    // 'agent/created' is a SERIAL event: every listener is awaited before the
    // agent becomes usable, which is what lets the shadow layer exist before the
    // first turn reads its catalog. A listener that throws rejects creation, so
    // both handlers below are fully contained.
    try {
      this._disposers.push(this.ctx.on('agent/created', ({ agent } = {}) => {
        const id = agent?.session?.id ?? agent?.id
        if (typeof id !== 'string' || id === '') return
        // Re-establish this session's shadow layer from its PERSISTED disabled
        // list. A restart empties every in-memory registry, so without this the
        // skills a user turned off are visible again the moment the chat comes
        // back — the "重启后卡片自动恢复" report. Fire-and-forget: a session that
        // cannot shadow still works, it just shows the skill.
        void reapplyShadows(this.ctx, defaultDshHome(), id, agent).catch(() => { /* best effort */ })
      }))
    } catch { /* fiber already disposed; nothing to track */ }
    try {
      // When a session's agent is removed, any skills we introduced into it die
      // with the registration — drop the registry entry so /applied and the
      // composer chips never list resurrected skills.
      this._disposers.push(this.ctx.on('agent/disposed', ({ agent } = {}) => {
        const id = agent?.session?.id ?? agent?.id
        if (typeof id !== 'string' || id === '') return
        clearSession(id)
        for (const candidate of sessionIdentities(id)) {
          pending.delete(candidate)
          applyMode.delete(candidate)
          temporarilyEnabled.delete(candidate)
          sessionDisabled.delete(candidate)
          pendingTurn.delete(candidate)
          sessionClock.delete(candidate)
        }
        // The shadow provider is registered on the agent's own context, so it
        // dies with the agent; dropping our handle just avoids a stale entry
        // that would make a later reconcile skip re-registering it.
        for (const candidate of sessionIdentities(id)) clearShadows(candidate)
      }))
    } catch { /* fiber already disposed; nothing to track */ }
    this._wireTurnEnd()
    this._wireTurnStart()
  }

  /**
   * Revoke a session's introduced skills when its TURN ENDS.
   *
   * "应用只对下一条消息生效" needs a boundary that is (a) after the turn that
   * consumed the skills has finished, and (b) before the next turn assembles its
   * skill catalog. The obvious candidates both fail:
   *
   *   - Watching the draft go empty is late AND unreliable — the host only
   *     clears the editor on `submit-settled` with `ev.ok`, i.e. after the turn
   *     is accepted, and it keeps the text while the turn is in flight.
   *   - Revoking on the send gesture (Enter / the primary button) can land
   *     BEFORE the agent has read the catalog for that turn, which is exactly
   *     the bug this replaces: the user applies, sends, and the turn runs
   *     without the skill.
   *
   * `agent/status` gives the real boundary: 'running' means a turn is in
   * flight, 'idle' means none is. So the apply is held across the running
   * window and released the moment the agent goes idle — after the turn that
   * used it, before the next one reads the catalog.
   *
   * The payload is `{ agent, status }`; `agent` is ALWAYS a field, never `this`.
   */
  _wireTurnEnd() {
    try {
      this._disposers.push(this.ctx.on('agent/status', ({ agent, status } = {}) => {
        if (status !== 'idle') return
        const id = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
        if (typeof id !== 'string' || id === '') return
        // Same settlement the read path performs, so the release happens as soon
        // as the host announces the turn ended — and still happens on the next
        // /applied poll if that notification is never delivered.
        settleTurnHolds(this.ctx, id)
      }))
    } catch {
      /* events not available; the read path still settles the hold */
    }
  }

  /**
   * Count the turn starts so a hold can prove it was actually consumed.
   *
   * `agent/status` transitions strictly alternate (the harness installs an
   * invariant that rejects a no-op repeat), so a counter of `running` edges is a
   * monotonic turn clock. A hold records the clock value at apply time and is
   * released only once the clock has ADVANCED, which is what keeps the promise
   * "the message you send next gets this skill":
   *
   *   apply while idle     → clock C, next edges are running(C+1), idle → release
   *   apply while running  → clock C (this turn already read its catalog), the
   *                          next edge is idle and does NOT advance the clock, so
   *                          the hold survives to the following turn — instead of
   *                          being burned by a turn that could never have used it
   */
  _wireTurnStart() {
    try {
      this._disposers.push(this.ctx.on('agent/status', ({ agent, status } = {}) => {
        if (status !== 'running') return
        const id = agent?.session?.id ?? agent?.id
        if (typeof id !== 'string' || id === '') return
        sessionClock.set(id, (sessionClock.get(id) ?? 0) + 1)
      }))
    } catch {
      /* events not available; the release then falls back to the plain idle edge */
    }
  }

  /**
   * The host has NO safe guess for "which session is this request about", so no
   * caller may ask for one.
   *
   * This used to fall back to `agents.list()[0]`, i.e. the first live agent in
   * registration order — a session chosen at random from the caller's point of
   * view, and the single largest source of cross-session bleed: a window that
   * sent no id was answered with another window's session, and the write routes
   * then MUTATED it, so the bleed was not read-only. The method is kept only so
   * an out-of-tree caller fails visibly (`undefined`) instead of throwing.
   */
  current() {
    return undefined
  }

  dispose() {
    for (const d of this._disposers) {
      try { d?.() } catch { /* ignore */ }
    }
  }
}

/**
 * Session-scoped registry of introduced skills.
 *
 * `introduceIntoSession` returns the skills-service disposer for each
 * registration; without keeping it there is no way to remove an applied skill
 * (previously the disposer was dropped on the floor, so "revoke" was
 * impossible without restarting the session). Keyed by sessionId → skill
 * name → disposer. Entries die with the host process, which matches the
 * session-scoped nature of the registration itself.
 */
const introduced = new Map()

/**
 * How each introduced skill was applied: 'turn' (one-shot, released when the
 * turn ends) or 'session' (stays for the whole session). /applied reports this
 * so the cards can show WHICH kind of availability each skill currently has —
 * the user asked to see that distinction on the deck itself, not just in the
 * composer chips.
 * sessionId -> Map<name, 'turn' | 'session'>
 */
const applyMode = new Map()

/** Record the mode a skill was applied under. */
function rememberMode(sessionId, name, mode) {
  if (!applyMode.has(sessionId)) applyMode.set(sessionId, new Map())
  applyMode.get(sessionId).set(name, mode)
}

/** Drop a skill's mode entry (it is no longer applied). */
function forgetMode(sessionId, name) {
  const m = applyMode.get(sessionId)
  if (!m) return
  m.delete(name)
  if (m.size === 0) applyMode.delete(sessionId)
}

function rememberIntroduced(sessionId, name, dispose) {
  if (!introduced.has(sessionId)) introduced.set(sessionId, new Map())
  introduced.get(sessionId).set(name, dispose)
}

/** Unregister one skill from a session. Returns false when it was not applied. */
function revokeIntroduced(sessionId, name) {
  const byName = introduced.get(sessionId)
  const dispose = byName?.get(name)
  if (!dispose) return false
  try { dispose() } catch { /* already gone */ }
  byName.delete(name)
  if (byName.size === 0) introduced.delete(sessionId)
  return true
}

/**
 * Skills applied for the NEXT message, held until that turn finishes.
 *
 * "Applied" used to mean "registered until something revokes it". That made the
 * one-shot promise depend on a client-side gesture that can fire before the
 * agent has read the skill catalog — the user applies, sends, and the turn runs
 * without the skill. Here the apply is instead a HELD registration:
 *
 *   apply   → register now, remember the names as held
 *   turn    → runs with the skills; nothing touches them
 *   idle    → the turn ended; release exactly the held names
 *
 * A turn that runs long, or a turn that is cancelled, both end in 'idle', so
 * there is no path where the hold leaks into the next message.
 * sessionId -> Set<skillName>
 */
const pending = new Map()

/**
 * The turn clock at the moment each hold was taken.
 *
 * A hold is released on an idle edge, but not EVERY idle edge spends it. Two
 * cases make the naive rule wrong:
 *
 *   - apply while the agent is already running. That turn has already read its
 *     catalog, so it cannot use the skill; releasing on its idle edge burns the
 *     apply without ever honouring it — the user's "应用了但本轮没用上" report.
 *   - `maintenance` phases (compaction, a title job) also flip status to idle,
 *     with no turn in between.
 *
 * `sessionClock` counts `running` edges (the harness rejects a no-op repeat, so
 * the count is a real turn clock). A hold stores the clock value it was taken
 * at and is released only once the clock has advanced — i.e. only after a turn
 * actually STARTED while the hold was outstanding. That is exactly "the message
 * you send next".
 *
 * sessionId -> number
 */
const sessionClock = new Map()

/** The clock value each live hold was taken at. sessionId -> number */
const pendingTurn = new Map()

/**
 * Skills the user turned OFF but then explicitly applied for this turn.
 *
 * The switch governs AMBIENT visibility; "apply to this turn" is an explicit,
 * one-shot opt-in. They must not be mutually exclusive: a skill that is off is
 * normally shadowed (same name, modelInvocable:false), and applying it means
 * lifting that shadow for ONE turn, then restoring it when the turn ends.
 * This map records exactly the names to restore.
 *
 * sessionId -> Map<name, skill>
 */
const temporarilyEnabled = new Map()

/** Remember that these names are applied for the session's next turn. */
function holdForNextTurn(sessionId, names, turnAtApply) {
  if (!pending.has(sessionId)) pending.set(sessionId, new Set())
  const held = pending.get(sessionId)
  for (const n of names) held.add(n)
  // Record the turn the hold was taken at. The stamp is the session LOG's turn
  // number when it can be read; the event clock is only a fallback, because the
  // two use DIFFERENT scales and comparing one against the other would misjudge
  // the hold. `undefined` records "unknown", which settlement treats as "spend it
  // once the turn that is currently open (if any) has ended".
  if (!pendingTurn.has(sessionId)) {
    const stamp = turnAtApply !== undefined ? turnAtApply : sessionClock.get(sessionId)
    pendingTurn.set(sessionId, stamp)
  }
}

/** Record a skill that was off but is now temporarily on for this turn. */
function rememberTemporary(sessionId, name, skill) {
  if (!temporarilyEnabled.has(sessionId)) temporarilyEnabled.set(sessionId, new Map())
  temporarilyEnabled.get(sessionId).set(name, skill)
}

/**
 * Drop a temporary marker because the skill is no longer turn-scoped — it was
 * re-applied as session mode, so its shadow must stay lifted for the session.
 */
function forgetTemporary(sessionId, name) {
  const m = temporarilyEnabled.get(sessionId)
  if (!m) return
  m.delete(name)
  if (m.size === 0) temporarilyEnabled.delete(sessionId)
}

/** Whether the session currently holds an unspent apply. */
function hasHold(sessionId) {
  const held = pending.get(sessionId)
  return held !== undefined && held.size > 0
}

/**
 * Release the session's held skills: unregister each one and drop the hold.
 *
 * A skill that was OFF and applied only for this turn must be shadowed again
 * once the turn ends, so the switch keeps its meaning across an explicit
 * one-shot opt-in. This function unregisters and returns the list of
 * `{ name, skill }` entries that need their shadow restored; the CALLER does
 * the async restore (it owns the context and the skill service), so this
 * function stays synchronous and easy to reason about.
 *
 * Returns `{ released, restore }`.
 */
function releaseSession(sessionId, observedTurn) {
  const ids = sessionIdentities(sessionId)
  // Track WHICH id actually held the names: the temporary markers are keyed by
  // that same id, so looking them up under the raw input would miss them (the
  // defect that left an OFF skill permanently visible after a one-turn apply).
  let holder
  let held
  for (const id of ids) {
    if (pending.has(id)) { holder = id; held = pending.get(id); break }
  }
  if (held === undefined || held.size === 0) return { released: [], restore: [] }
  // WAS THE HOLD ACTUALLY CONSUMED? Only a turn that STARTED after the apply
  // could have read the skill, and only once that turn ENDED is it safe to drop.
  // The caller has already refused to settle while a turn is in flight, so this
  // final check is about the CLOCK, not about flight.
  //
  // `observedTurn` is the session log's own `turnBoundary.lastTurn`; the event
  // clock is a fallback for callers that can only see events. The two use
  // DIFFERENT scales, so the comparison is only made against a stamp from the
  // SAME scale. A stamp of `undefined` means "the log was unreadable when the
  // user applied": the caller's in-flight check is then the whole guard, and the
  // hold may be spent (having a definite clock but an unknown stamp must not
  // strand the apply forever).
  const takenAt = pendingTurn.get(holder)
  const now = observedTurn !== undefined ? observedTurn : sessionClock.get(holder)
  if (takenAt !== undefined && now !== undefined && now <= takenAt) {
    return { released: [], restore: [] }
  }
  pending.delete(holder)
  pendingTurn.delete(holder)
  const released = []
  const restore = []
  const temps = temporarilyEnabled.get(holder)
  const modes = applyMode.get(holder)
  for (const name of held) {
    for (const id of ids) {
      if (revokeIntroduced(id, name)) { released.push(name); break }
    }
    const entry = temps?.get(name)
    if (entry !== undefined) {
      restore.push({ name, skill: entry })
      temps.delete(name)
    }
    // The hold is spent: its mode label must go with it, or /applied would keep
    // advertising a mode for a skill that is no longer applied.
    modes?.delete(name)
  }
  if (temps && temps.size === 0) temporarilyEnabled.delete(holder)
  if (modes && modes.size === 0) applyMode.delete(holder)
  return { released, restore }
}

/** Unregister every skill applied to a session (used when the agent dies). */
function clearSession(sessionId) {
  const byName = introduced.get(sessionId)
  if (!byName) return
  for (const dispose of byName.values()) {
    try { dispose() } catch { /* already gone */ }
  }
  introduced.delete(sessionId)
}

/**
 * The session's own turn number, read from its log — the authoritative clock.
 *
 * `turnBoundary.lastTurn` counts `turn/start` events in the SESSION LOG, so it
 * answers "how many turns have begun" without depending on any live event being
 * delivered. That matters: the turn-scoped release used to hang off
 * `agent/status`, and on a host where that notification did not reach this
 * plugin the clock never advanced — so a one-turn apply was never released and
 * the chips stayed after the reply ("聊完一轮，技能没有退回去").
 *
 * Returns undefined when the projection is unavailable, which makes the caller
 * fall back to the event clock rather than guessing.
 */
function turnNumberOf(ctx, sessionId) {
  const state = turnBoundaryOf(ctx, sessionId)
  const lastTurn = state?.lastTurn
  return typeof lastTurn === 'number' ? lastTurn : undefined
}

/**
 * The session log's `turnBoundary` state, or undefined when unavailable.
 *
 * Two facts matter and they are DIFFERENT:
 *   - `lastTurn`           — how many turns have STARTED
 *   - `openTurnStartSeq`   — the currently open turn, or null when none is open
 *
 * A release needs both: the turn count must have advanced (so the message was
 * actually sent) AND no turn may be open (so that turn has finished). Releasing
 * on `lastTurn` alone fired the moment `turn/start` landed — which is BEFORE the
 * turn assembles its skill catalog — so the skills were revoked out from under
 * the very message they were applied for ("撤太快了技能都没注入").
 */
function turnBoundaryOf(ctx, sessionId) {
  const agent = resolveAgent(ctx, sessionId)
  const session = agent?.session
  if (session === undefined) return undefined
  try {
    const projections = service(ctx, 'sessionProjections')
    return projections?.stateOf?.(session, 'turnBoundary')
  } catch {
    return undefined
  }
}

/**
 * Whether a turn is still in flight for this session.
 *
 * `openTurnStartSeq !== null` means a `turn/start` has been logged without its
 * `turn/end`. Returns undefined when the log cannot be read, so the caller can
 * fall back to the event's own status rather than assuming either way.
 */
function turnInFlight(ctx, sessionId) {
  const state = turnBoundaryOf(ctx, sessionId)
  if (state === undefined) return undefined
  return state.openTurnStartSeq !== null && state.openTurnStartSeq !== undefined
}

/**
 * Settle a spent turn-scoped hold.
 *
 * RELEASES ONLY WHEN THE TURN THAT CONSUMED IT HAS FINISHED. Two independent
 * signals are used, and both must agree before anything is revoked:
 *
 *   1. the session log's turn count advanced past the count at apply time
 *      (the message was really sent), and
 *   2. no turn is currently open — or, when the log is unreadable, the agent is
 *      not `running` (the turn has really ended).
 *
 * Requirement (2) is what fixes "撤太快了": `turn/start` bumps the counter at
 * the very beginning of a turn, long before the system prompt and catalog are
 * assembled, so a release keyed on the counter alone could strip the skills
 * before the model ever saw them.
 *
 * Called from the read path (`GET /applied`) and from the status listener. Both
 * call sites are idempotent: `releaseSession` drops the hold it spends.
 *
 * SESSION-MODE HOLDS ARE DELIBERATELY UNTOUCHED — they are not in `pending` at
 * all, so a session-scoped apply stays exactly as long as the chat does.
 */
function settleTurnHolds(ctx, sessionId) {
  // The hold must be outstanding at all, or there is nothing to weigh.
  const held = pending.has(sessionId)
  if (!held) return { released: [], restore: [] }
  // A turn still in flight keeps its skills: that turn has not finished reading
  // anything yet, and may not even have assembled its catalog.
  const inFlight = turnInFlight(ctx, sessionId)
  if (inFlight === true) return { released: [], restore: [] }
  if (inFlight === undefined) {
    // The log is unreadable, so fall back to the agent's own status. `running`
    // means a turn is in flight; anything else means it is safe to settle.
    const agent = resolveAgent(ctx, sessionId)
    if (agent?.status === 'running') return { released: [], restore: [] }
  }
  const turn = turnNumberOf(ctx, sessionId)
  const { released, restore } = releaseSession(sessionId, turn)
  if (released.length === 0 && restore.length === 0) return { released, restore }
  // An OFF skill that was applied for the turn is shadowed again now that the
  // turn ended, so the switch keeps its meaning across a one-shot opt-in.
  for (const { name, skill } of restore) {
    if (disabledForSession(defaultDshHome(), sessionId).has(name)) {
      void shadowSkill(ctx, sessionId, skill).catch(() => { /* best effort */ })
    }
  }
  return { released, restore }
}

/**
 * Settle a spent turn-scoped hold, using the log clock rather than an event.
 *
 * Called from the read path (`GET /applied`) and from the status listener. Both
 * call sites are idempotent: `releaseSession` drops the hold it spends, so a
 * second call is a no-op.
 *
 * SESSION-MODE HOLDS ARE DELIBERATELY UNTOUCHED — they are not in `pending` at
 * all, so a session-scoped apply stays exactly as long as the chat does. That is
 * the split the user asked for: 本轮 clears itself after the message, 本会话
 * does not.
 */

/* ------------------------------------------------------------------------ *
 * On/off switch (可见性开关)
 *
 * The card panel lists the same skills the model can see. Turning one off has
 * to mean something at the registry, not just on the card face, so the switch
 * is enforced with a session-scoped SHADOW: a provider that republishes the
 * skill's own name with `modelInvocable: false` and `rank: 0`.
 *
 * Why a shadow rather than deleting the filesystem entry: the registry merges
 * the global layer with the viewing scope's chain, and the nearest layer wins a
 * duplicate name OUTRIGHT — rank only decides duplicates inside one layer. So a
 * provider registered on the agent's own context outranks the filesystem
 * provider for that session, and rank 0 additionally settles any same-layer
 * tie. `modelInvocable: false` keeps the name out of the model-facing
 * `<available_skills>` catalog and makes the `skill` tool refuse to load it.
 *
 * The skill's files are never touched: off is a reversible visibility choice,
 * exactly like the rest of this panel's state, and the disk copy keeps working
 * for every other agent on the machine.
 *
 * One provider per session serves every disabled skill in it, because provider
 * names must be unique within a layer — a provider per skill would collide.
 * ------------------------------------------------------------------------ */

/** Provider name for the per-session shadow layer. */
const SHADOW_PROVIDER = 'dsh-skill-cards-shadow'

/**
 * Per-session on/off switch state.
 *
 * The switch is SESSION-SCOPED, like the apply and the shadow it drives: turning
 * a skill off in one chat must not grey it out in another. The old behaviour
 * stored one machine-wide `_disabled` list and fanned the shadow out to every
 * live session, which is exactly the cross-session bleed the user is asking us
 * to remove.
 *
 * sessionId -> Set<skillName>  (only DISABLED names; absence = enabled)
 */
const sessionDisabled = new Map()

/**
 * Every skill name seen by the last successful scan.
 *
 * `disabledForSession` must answer synchronously (it backs every read), but
 * discovery is async — so the async paths (the /skills and /switch routes, and
 * the agent-created hook) record what they scanned here, and the default-off
 * seed reads it. Empty until the first scan, which the seed treats as "not
 * decided yet" rather than "nothing exists" (see `disabledForSession`).
 */
const knownSkillNames = new Set()

/** Record the skills a scan found, for the synchronous seed path. */
export function rememberInstalled(skills) {
  if (!Array.isArray(skills)) return
  knownSkillNames.clear()
  for (const s of skills) {
    const name = typeof s === 'string' ? s : s?.name
    if (typeof name === 'string' && name !== '') knownSkillNames.add(name)
  }
}

/**
 * Forget the scanned names, AND the session sets derived from them.
 *
 * Exported for tests: both are module-level state, so a suite that drives
 * `disabledForSession` directly would otherwise leak a scan (and the seeded sets)
 * into the next case. Not used on any production path.
 */
export function __resetSkillCardsState() {
  knownSkillNames.clear()
  sessionDisabled.clear()
  shadows.clear()
  setSessionClockReset()
}

/** Split out so the reset above can reach it without a forward-reference lint. */
function setSessionClockReset() {
  sessionClock.clear()
  pending.clear()
  pendingTurn.clear()
  applyMode.clear()
  temporarilyEnabled.clear()
  introduced.clear()
}

/**
 * The disabled set for one session, lazily seeded.
 *
 * A session that has never touched its switch inherits the LEGACY machine-wide
 * `_disabled` list once (so a user's existing "I turned these off" choice is
 * preserved), then diverges: every later toggle only mutates this session's own
 * set. The legacy file is read-only from here on.
 */
export function disabledForSession(home, sessionId) {
  // 1. The live in-memory set wins while the process is up.
  let set = sessionDisabled.get(sessionId)
  if (set !== undefined) return set
  // 2. Otherwise read this session's OWN persisted list. This is what makes a
  //    close survive a restart — the in-memory map is empty after a boot, so
  //    without this step every session silently fell back to the legacy seed
  //    and the user's switches "came back on their own".
  const stats = readStats(home)
  const stored = readSessionDisabled(stats, sessionId)
  if (stored !== undefined) {
    sessionDisabled.set(sessionId, stored)
    return stored
  }
  // 3. A session that has never been written gets its INITIAL state:
  //    - "default off" is on → every installed skill starts disabled;
  //    - otherwise → the legacy machine-wide `_disabled` list (so a pre-upgrade
  //      user keeps their choices).
  if (!readDisableByDefault(stats)) {
    set = new Set(readDisabled(stats))
    sessionDisabled.set(sessionId, set)
    try { writeSessionDisabled(home, sessionId, set) } catch { /* best effort */ }
    return set
  }
  // "Default off" needs to know WHICH skills exist, and this function is
  // synchronous while discovery is not — the caller supplies the names it just
  // scanned (see `rememberInstalled`).
  //
  // WHEN NOBODY HAS SCANNED YET, DO NOT SEED AND DO NOT PERSIST. The previous
  // version fell back to the legacy list, which is usually empty, and then wrote
  // that empty set as the session's permanent decision (`null` in the store).
  // The session was thereby pinned to "nothing disabled" BEFORE the first scan,
  // so "new chats start off" silently did nothing for it — for ever. 14 of 57
  // sessions on the author's machine had been pinned that way.
  //
  // Returning an empty set is safe here: it is a PROVISIONAL view, nothing is
  // written, and the next read (after a scan has populated `knownSkillNames`)
  // derives the real seed. A session created while the filesystem probe is still
  // in flight therefore ends up correctly off instead of permanently on.
  if (knownSkillNames.size === 0) return new Set()
  set = new Set(knownSkillNames)
  sessionDisabled.set(sessionId, set)
  try { writeSessionDisabled(home, sessionId, set) } catch { /* best effort */ }
  return set
}

/**
 * Persist a session's disabled set after a mutation.
 *
 * Kept separate from `disabledForSession` so reads stay cheap and a write only
 * happens when something actually changed. Failures are swallowed: a store that
 * cannot be written must not break the live switch, which is still enforced by
 * the in-memory set plus the shadow.
 */
function persistSessionDisabled(home, sessionId) {
  const set = sessionDisabled.get(sessionId)
  if (set === undefined) return
  try { writeSessionDisabled(home, sessionId, set) } catch { /* best effort */ }
}

/** sessionId -> { agent, items: Map<name, {def, skill}>, dispose } */
const shadows = new Map()

/**
 * Candidate ids a session may be addressed by.
 *
 * The client passes the id the slot renderer handed it, which is not always the
 * same string the agent registry is keyed by (a `session-` prefixed chat id and
 * a bare uuid both occur). Try both shapes rather than silently resolving no
 * agent — a switch that reports success while enforcing nothing is the one
 * failure mode worth spending code on.
 */
function sessionIdentities(sessionId) {
  const ids = [sessionId]
  if (typeof sessionId === 'string' && sessionId.startsWith('session-')) {
    ids.push(sessionId.slice('session-'.length))
  }
  return ids
}

/**
 * Canonical key for every per-session registry in this file.
 *
 * The client sends the id its slot renderer handed it; the agent registry keys
 * by its OWN id, and the two can differ (a `session-`-prefixed chat id vs the
 * bare uuid). `pending`, `applyMode`, `temporarilyEnabled`, `sessionDisabled`,
 * `shadows` and `introduced` must all agree on ONE key, or a write through one
 * shape becomes invisible to a read through the other.
 *
 * That mismatch was a real defect: `rememberTemporary` wrote under the client
 * id while the turn-end handler looked it up under the agent id, so the restore
 * never ran and a skill that was OFF stayed VISIBLE for the rest of the session
 * after being applied for a single turn.
 *
 * Resolution order: the live agent's own id when it can be found, otherwise the
 * id as given (a session whose agent is not live yet still needs a stable key).
 */
function canonicalSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return sessionId
  const agent = resolveAgent(ctx, sessionId)
  if (agent === undefined) return sessionId
  const id = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
  return typeof id === 'string' && id !== '' ? id : sessionId
}

/** Resolve the live agent for a session id, tolerating either id shape. */
function resolveAgent(ctx, sessionId) {
  const agents = service(ctx, 'agents')
  if (!agents) return undefined
  const wanted = new Set(sessionIdentities(sessionId))
  for (const id of wanted) {
    try {
      const agent = agents.get?.(id)
      if (agent) return agent
    } catch { /* keep trying */ }
  }
  // Fall back to a scan: the registry's own key is the authority, and the id
  // the client sent may be a third spelling we did not anticipate.
  try {
    for (const agent of agents.list?.() ?? []) {
      const id = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
      if (typeof id === 'string' && wanted.has(id)) return agent
    }
  } catch { /* ignore */ }
  return undefined
}

/** The model-facing shape of a shadowed skill: same name, not invocable. */
function shadowCandidate(def, skill) {
  return {
    name: def.name,
    description: def.description,
    invocation: { modelInvocable: false, userInvocable: false },
    source: 'dsh-skill-cards-session',
    provider: SHADOW_PROVIDER,
    // Wins a same-layer duplicate; the layer itself already wins across layers.
    rank: 0,
    locator: { path: skill.skillFile, directory: skill.rootDir },
  }
}

/** Load-back shape for a shadowed skill (kept consistent with the candidate). */
function shadowDefinition(def, skill) {
  return {
    name: def.name,
    description: def.description,
    invocation: { modelInvocable: false, userInvocable: false },
    source: 'dsh-skill-cards-session',
    provider: SHADOW_PROVIDER,
    resourceBase: { kind: 'directory', path: skill.rootDir },
    path: skill.skillFile,
    content: def.content,
  }
}

/**
 * Register the session's shadow provider, if it has none LIVE yet.
 *
 * A cached state is only reusable while its registration is still live. The
 * registration is a Cordis effect owned by the AGENT's fiber, so it dies the
 * moment that agent's scope unloads — and a session that comes back (a restart,
 * or a resume after the agent was dropped) gets a NEW agent and a NEW fiber.
 * The old `shadows` entry then pointed at a disposed provider: `fillShadowsSync`
 * saw "already have a state", returned without registering, and reported success
 * while the model could still use every "off" skill. That is the
 * "重启后面板显示关闭，但模型实际可用" report.
 *
 * `state.live` is flipped by the registration's own abort signal, which Cordis
 * fires on dispose, so a dead entry can never be mistaken for a healthy one.
 */
function ensureShadowProvider(sessionId, agent) {
  const existing = shadows.get(sessionId)
  // Reuse ONLY a live registration belonging to the SAME agent. A different
  // agent object means the session was re-created, and its provider must be
  // registered on the new scope or it enforces nothing.
  if (existing !== undefined && existing.live && existing.agent === agent) return existing
  if (existing !== undefined) {
    // Stale: drop the handle (its disposer already ran, or belongs to a dead
    // scope) so we do not keep leaking it, then re-register below.
    shadows.delete(sessionId)
  }
  const skills = agent?.ctx?.get?.('skills')
  if (skills === undefined || typeof skills.registerProvider !== 'function') return undefined
  const state = { agent, items: new Map(), dispose: undefined, live: true, invalidate: undefined }
  state.dispose = skills.registerProvider((control) => {
    // Cordis aborts this signal when the registration is disposed — which
    // happens when the owning fiber (the agent's scope) unloads. That is the
    // only reliable "the provider is gone" notification, so it is what keeps
    // `state.live` honest. A provider harness that supplies no signal simply
    // never flips it, which is the old (always-live) behaviour.
    const signal = control?.signal
    // `invalidate` drops the registry's cached collection. The shadow's content
    // changes WITHOUT the provider being re-registered (turn one off, or off and
    // back on), so without this the registry keeps serving a stale list: the
    // panel says the skill is back on while the cached collection still hides
    // it. Stored on the state so the mutation sites below can call it.
    if (typeof control?.invalidate === 'function') state.invalidate = control.invalidate
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => {
        state.live = false
        if (shadows.get(sessionId) === state) shadows.delete(sessionId)
      }, { once: true })
    }
    return {
      name: SHADOW_PROVIDER,
      async list() {
        // A disposed registration must contribute nothing; the registry may
        // still hold the entry for the remainder of the current collection pass.
        if (signal?.aborted === true) return []
        return [...state.items.values()].map(({ def, skill }) => shadowCandidate(def, skill))
      },
      async get(candidate) {
        const entry = state.items.get(candidate.name)
        return entry === undefined ? undefined : shadowDefinition(entry.def, entry.skill)
      },
    }
  })
  shadows.set(sessionId, state)
  return state
}

/** Add one skill's name to the session's shadow layer. */
async function shadowSkill(ctx, sessionId, skill) {
  const agent = resolveAgent(ctx, sessionId)
  if (agent === undefined) return { ok: false, reason: `会话 "${sessionId}" 不是活跃会话` }
  const state = ensureShadowProvider(sessionId, agent)
  if (state === undefined) return { ok: false, reason: 'skills 服务不可用（会话级）' }
  const def = await readSkillContent(skill)
  if (def === undefined) return { ok: false, reason: `"${skill.name}" 不可读` }
  state.items.set(def.name, { def, skill })
  // The provider was not re-registered, so the registry must be told the
  // collection changed or it keeps serving the previous (uns shadowed) list.
  try { state.invalidate?.() } catch { /* cache invalidation is best effort */ }
  return { ok: true, name: def.name }
}

/**
 * Rebuild one session's shadow layer from its persisted disabled set.
 *
 * Called whenever an agent appears (fresh session, or the FIRST session after a
 * restart). The shadow is what actually keeps a skill out of the model's
 * catalog, and it lives only in memory — so a restart drops it, and without
 * this the user's "关闭" choices would be silently undone even though the
 * disabled list itself was persisted.
 *
 * Idempotent: `ensureShadowProvider` reuses an existing provider and
 * `state.items.set` just overwrites the same name, so a duplicate call for a
 * live session is harmless.
 */
export async function reapplyShadows(ctx, home, sessionId, agent) {
  try {
    // SCAN FIRST. `disabledForSession` seeds a brand-new session synchronously
    // from `knownSkillNames`, which is only populated by a scan — and an agent
    // is created BEFORE any /skills request reaches this host. Seeding first
    // therefore saw an empty list, produced an empty disabled set, and returned
    // below with no shadow at all: the panel said "off" while the model could
    // still use the skill. Scanning here closes that window.
    const skills = (await scanInstalled(home, process.cwd())).skills
    rememberInstalled(skills)
    const disabled = disabledForSession(home, sessionId)
    if (disabled.size === 0) return
    // Register the provider and fill it SYNCHRONOUSLY. The previous version
    // awaited the retry loop and each skill body, which left a window where
    // /skills could answer "off" while the shadow was still empty — the model
    // stayed able to use the skill the panel had just hidden.
    fillShadowsSync(sessionId, agent, skills, disabled)
    // If the skills service was not ready at this instant, retry in the
    // background: 'agent/created' fires before the agent exposes it on some
    // compositions, so one attempt can land too early.
    // The retry now also covers a STALE state: `ensureShadowProvider` drops a
    // dead registration, so `shadows.get` is undefined again and this loop
    // re-registers instead of trusting a handle whose fiber is gone.
    if (shadows.get(sessionId) === undefined) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (shadows.get(sessionId) !== undefined) break
        fillShadowsSync(sessionId, agent, skills, disabled)
      }
    }
  } catch {
    /* best effort — a failure here only leaves skills visible */
  }
}

/**
 * Register the session's shadow provider and fill it from `disabled`, entirely
 * synchronously.
 *
 * Synchronous is a requirement, not a preference: every read path that answers
 * the panel ("is this off?") must be followed by an already-populated shadow, or
 * the UI reports a state the model does not obey. Skill bodies are small files
 * and this runs once per session, so the blocking read is cheap.
 *
 * Returns the number of skills now shadowed (0 when the service is absent).
 */
export function fillShadowsSync(sessionId, agent, skills, disabled) {
  const state = ensureShadowProvider(sessionId, agent)
  // No provider means nothing is enforced. Returning 0 (rather than a count)
  // keeps the caller honest: a reported fill that enforces nothing is exactly
  // the "panel says off, model can still use it" bug.
  if (state === undefined) return 0
  const byName = new Map((skills || []).map((s) => [s.name, s]))
  // REPLACE the item set, do not merely add to it. A stale layer must not keep
  // hiding a skill the user turned back on: `state.items` is the provider's whole
  // contribution, so it has to mirror `disabled` exactly.
  const next = new Map()
  for (const name of disabled) {
    const skill = byName.get(name)
    // A disabled name with no installed skill (uninstalled, or a stale entry)
    // is skipped: there is nothing to shadow, and the stored choice is kept so
    // reinstalling restores it.
    if (skill === undefined) continue
    const def = readSkillContentSync(skill)
    if (def === undefined) continue
    next.set(def.name, { def, skill })
  }
  state.items = next
  // The provider was NOT re-registered, so the registry has no reason to notice
  // the change on its own — it would keep serving the previous collection. Tell
  // it explicitly, or "turn the skill back on" would not reach the model.
  try { state.invalidate?.() } catch { /* cache invalidation is best effort */ }
  return state.live ? next.size : 0
}

/**
 * Names this session currently has a shadow for.
 *
 * Exported for tests: the difference between "the panel says off" and "the model
 * cannot use it" is exactly this set, so it has to be observable.
 */
export function shadowedNames(sessionId) {
  const state = shadows.get(sessionId)
  return state === undefined ? [] : [...state.items.keys()]
}

/** Drop one name from the session's shadow layer (no-op when absent). */
function unshadowSkill(sessionId, name) {
  const state = shadows.get(sessionId)
  if (!state) return false
  const removed = state.items.delete(name)
  // The layer may still hold other names, and the provider stays registered —
  // so the registry's cached collection must be invalidated explicitly, or the
  // skill the user just turned back on stays hidden until something else
  // happens to bust the cache.
  if (removed && state.items.size > 0) {
    try { state.invalidate?.() } catch { /* cache invalidation is best effort */ }
  }
  // Nothing left to hide: release the provider so the layer is empty again.
  if (state.items.size === 0) {
    try { state.dispose?.() } catch { /* already gone */ }
    shadows.delete(sessionId)
  }
  return removed
}

/** Release a whole session's shadow layer (agent removed / session reset). */
function clearShadows(sessionId) {
  const state = shadows.get(sessionId)
  if (!state) return
  try { state.dispose?.() } catch { /* already gone */ }
  shadows.delete(sessionId)
}

/**
 * Introduce a skill into a session by registering it on the agent's session
 * scope. Returns the disposer so we can also remove it later if desired.
 * Logic mirrors dshp-plugin-panel's introduceSkill.
 */
async function introduceIntoSession(ctx, agent, skill) {
  // Must register on the *agent's* session-scoped skills service, never the
  // host-global one — otherwise the skill would leak into every session.
  const skills = agent.ctx?.get?.('skills')
  if (skills === undefined) return { ok: false, reason: 'skills 服务不可用（会话级）' }
  const def = await readSkillContent(skill)
  if (def === undefined) return { ok: false, reason: `"${skill.name}" 不可读` }
  const dispose = skills.register({
    name: def.name,
    description: def.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'dsh-skill-cards-session',
    content: def.content,
    resourceBase: { kind: 'directory', path: skill.rootDir },
  })
  return { ok: true, name: def.name, dispose }
}

async function readSkillContent(skill) {
  try {
    const raw = await import('node:fs/promises').then((m) => m.readFile(skill.skillFile, 'utf8'))
    // description already parsed by the scanner; content is the full doc.
    return { name: skill.name, description: skill.description, content: raw }
  } catch {
    return undefined
  }
}

/**
 * Same shape as {@link readSkillContent}, but synchronous.
 *
 * The shadow MUST be populated before any read path answers "off", so the fill
 * cannot await. A skill body is a small markdown file and this runs once per
 * session per disabled skill, so the blocking read is cheap.
 */
function readSkillContentSync(skill) {
  try {
    const raw = readFileSync(skill.skillFile, 'utf8')
    return { name: skill.name, description: skill.description, content: raw }
  } catch {
    return undefined
  }
}

export const name = NS

/**
 * Only `webServer` is declared: the plugin cannot expose any UI without it.
 * `agents` / `skills` are deliberately NOT injected — `skills` is an
 * agent-scoped service, and awaiting it at the root scope makes Cordis pend
 * `apply()` forever, so the HTTP routes never register (the symptom: the button
 * appears from the client half, but every request 404s). They are read
 * opportunistically through `ctx.get()` instead, which answers `undefined`
 * while absent rather than suspending the fiber.
 */
export const inject = ['webServer']

/** Opportunistic service lookup — never throws, answers undefined while absent. */
function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * The session a write request names, or `undefined` when it named none.
 *
 * There is deliberately NO fallback to "the active session". The host is one
 * process serving every open window, so the only session it could elect is
 * whichever one happened to be registered or touched first — not the one the
 * caller is looking at. Every write route (`introduce`, `switch`, `revoke`) then
 * reports 400 rather than mutating an unrelated chat.
 */
function requiredSessionId(body) {
  const id = body?.sessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function apply(ctx) {
  const log = createLogger(ctx.logger, NS)
  const home = defaultDshHome()
  const tracker = new ActiveSessionTracker(ctx)

  ctx.inject(['webServer'], (hostCtx) => {
    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        // Strip "/plugins/dsh-skill-cards/" (with slash) to leave the route tail.
        const route = url.pathname.startsWith(API_BASE)
          ? url.pathname.slice(API_BASE.length)
          : url.pathname.slice(API_PREFIX.length).replace(/^\//, '')
        const method = request.method ?? 'GET'
        const cors = sameOrigin(request)
        if (cors) {
          sendError(response, 403, cors)
          return
        }
        try {
          await dispatch({ route, method, url, request, response, ctx, home, tracker, log })
        } catch (error) {
          log.warn(`${method} ${route} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (!response.headersSent) {
            sendError(response, 500, error instanceof Error ? error.message : String(error))
          } else {
            response.end()
          }
        }
      },
    })
    hostCtx.effect(() => dispose, `${NS}: http routes`)
  })

  ctx.effect(() => tracker.dispose(), `${NS}: active session tracker`)
}

async function dispatch({ route, method, url, request, response, ctx, home, tracker, log }) {
  // Vendor static tails ("vendor/<file>") are not in GET_ROUTES (that list
  // holds bare route names) — admit them here; the vendor handler below
  // enforces its own allow-list.
  const isVendorTail = route === 'vendor' || route.startsWith('vendor/')
  if (!GET_ROUTES.includes(route) && !POST_ROUTES.includes(route) && !isVendorTail) {
    sendError(response, 404, `no such route: ${route}`)
    return
  }

  // ---- GET routes ----
  // Vendor static files shipped with the plugin (e.g. three.min.js for the 3D
  // card wall, card-back.jpg for the gacha back face). The route tail is
  // "vendor/<file>"; only allow-listed names are served, resolved against the
  // plugin's own vendor/ directory (import.meta.url is the package's lib/, so
  // ../vendor is the sibling directory).
  const VENDOR_FILES = {
    'three.min.js': 'application/javascript; charset=utf-8',
    'card-back.jpg': 'image/jpeg',
  }
  if (route === 'vendor' || route.startsWith('vendor/')) {
    const fileName = route.slice('vendor/'.length)
    const mime = VENDOR_FILES[fileName]
    if (method !== 'GET' || !mime) {
      sendError(response, 404, `no such vendor file: ${fileName}`)
      return
    }
    const vendorRoot = new URL('../vendor/', import.meta.url)
    const fileUrl = new URL(fileName, vendorRoot)
    // Stay inside the vendor directory (belt and braces after the allow-list).
    if (!fileUrl.pathname.startsWith(vendorRoot.pathname)) {
      sendError(response, 404, `no such vendor file: ${fileName}`)
      return
    }
    let buf
    try {
      buf = readFileSync(fileUrl)
    } catch {
      sendError(response, 404, `no such vendor file: ${fileName}`)
      return
    }
    response.writeHead(200, {
      'content-type': mime,
      'cache-control': 'public, max-age=31536000, immutable',
    })
    response.end(buf)
    return
  }
  if (route === 'skills' && method === 'GET') {
    const cwd = url.searchParams.get('cwd') || process.cwd()
    const scan = await scanInstalled(home, cwd)
    const skills = scan.skills
    // Remember what exists right now: the synchronous default-off seed reads it.
    rememberInstalled(skills)
    const cards = readCardConfig(home)
    const stats = readStats(home)
    // The switch is session-scoped, so the enabled flag must be computed for the
    // SESSION asking, not machine-wide. Canonicalised, because a read under the
    // client's id spelling would miss the session's own set and silently report
    // every skill as enabled.
    //
    // No id now means "no session" and is reported as such (`noSession: true`,
    // every card enabled). It deliberately does NOT fall back to the legacy
    // machine-wide `_disabled`: that list is another chat's leftover, and showing
    // its greys here is precisely the cross-session bleed being fixed.
    const asked = url.searchParams.get('sessionId') || undefined
    const sessionId = asked === undefined ? undefined : canonicalSession(ctx, asked)
    // Merge built-in + user-defined categories so the client can offer them all
    // (and so a skill assigned to a custom category resolves instead of falling
    // back to "其它"). Custom categories are flagged so the UI can make
    // built-in (auto-grouped) ones read-only versus user-editable ones.
    const customCats = readCustomCategories(stats)
    const disabled = sessionId !== undefined
      ? disabledForSession(home, sessionId)
      : new Set()
    // LAST CHANCE to make the panel's "off" true. The agent-created hook can run
    // before this host ever scans (or before the agent exposes `skills`), and
    // when it does the session has a disabled set but no shadow — the UI would
    // show the skill as off while the model still receives it. Rendering the
    // panel is exactly the moment the user would believe that lie, so reconcile
    // here too. Fire-and-forget: the response must not wait on a provider.
    if (sessionId !== undefined && disabled.size > 0) {
      const agent = resolveAgent(ctx, sessionId)
      if (agent !== undefined && shadows.get(sessionId) === undefined) {
        // SYNCHRONOUS. An async fire-and-forget let this very response report
        // "off" before the shadow existed, so the model stayed able to use the
        // skill the panel had just hidden. Filling inline makes the answer and
        // the enforcement land together.
        try { fillShadowsSync(sessionId, agent, skills, disabled) } catch { /* best effort */ }
      }
    }
    const defs = {
      ...CATEGORY_DEFS,
      ...Object.fromEntries(Object.entries(customCats).map(([id, def]) => [id, { ...def, custom: true }])),
    }
    const payload = skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      label: s.label || s.source,
      hasCover: s.hasCover,
      // Absent from the session's disabled set means on: a skill this session has
      // never touched is reported enabled rather than guessed into a hidden state.
      enabled: !disabled.has(s.name),
      coverUrl: s.hasCover ? `${API_BASE}cover?skill=${encodeURIComponent(s.name)}` : null,
      custom: cards[s.name] ?? null,
      stats: stats[s.name] ?? null,
      category: categoriesFor({ name: s.name, description: s.description, stats: stats[s.name], defs }),
      suggestedCategory: suggestCategory(s.name, s.description),
    }))
    sendJson(response, 200, {
      ok: true,
      skills: payload,
      categories: defs,
      roots: scan.diagnostics,
      // Tells the panel it is rendering without a session, so it must not offer
      // "应用到本轮" (there is nothing to apply TO) and must not read the enabled
      // flags as a per-chat truth.
      noSession: sessionId === undefined,
      sessionId: sessionId ?? null,
    })
    return
  }

  if (route === 'cards' && method === 'GET') {
    sendJson(response, 200, { ok: true, cards: readCardConfig(home) })
    return
  }

  if (route === 'stats' && method === 'GET') {
    const stats = readStats(home)
    const customCats = readCustomCategories(stats)
    const defs = {
      ...CATEGORY_DEFS,
      ...Object.fromEntries(Object.entries(customCats).map(([id, def]) => [id, { ...def, custom: true }])),
    }
    sendJson(response, 200, { ok: true, stats, categories: defs })
    return
  }

  if (route === 'default-off' && method === 'GET') {
    // Whether brand-new chats start with every skill turned off.
    sendJson(response, 200, { ok: true, disableByDefault: readDisableByDefault(readStats(home)) })
    return
  }

  if (route === 'prefs' && method === 'GET') {
    // Always fully populated (defaults filled in), so the client never has to
    // guess a default of its own.
    sendJson(response, 200, { ok: true, prefs: readPrefs(readStats(home)) })
    return
  }

  if (route === 'cover' && method === 'GET') {
    const name = url.searchParams.get('skill')
    if (!name) {
      sendError(response, 400, 'missing skill name')
      return
    }
    const skills = (await scanInstalled(home, process.cwd())).skills
    const skill = skills.find((s) => s.name === name)
    if (!skill) {
      sendError(response, 404, `skill not found: ${name}`)
      return
    }
    const cover = await readCover(skill.rootDir, skill.skillFile)
    if (!cover) {
      sendError(response, 404, 'no cover image')
      return
    }
    sendFile(response, 200, cover.mime, cover.buffer)
    return
  }

  if (route === 'active-session' && method === 'GET') {
    // There is no honest machine-wide answer: the host serves every window, so
    // any id it could name is another chat's. Reported as null, always. Kept so
    // an older client gets a clean "none" instead of a 404.
    sendJson(response, 200, { ok: true, sessionId: null })
    return
  }

  if (route === 'shadow-state' && method === 'GET') {
    // Read-only introspection for the one failure that is otherwise invisible:
    // the panel says "off" while the model still sees the skill. That is a
    // disagreement between three separate things — the persisted disabled set,
    // the in-memory shadow provider, and the live skill registry — and guessing
    // which one is wrong has cost several rounds. This reports all three.
    const asked = url.searchParams.get('sessionId')
    if (!asked) {
      sendJson(response, 200, { ok: true, error: 'sessionId is required' })
      return
    }
    const id = canonicalSession(ctx, asked)
    const agent = resolveAgent(ctx, id)
    const state = shadows.get(id)
    const installed = (await scanInstalled(home, url.searchParams.get('cwd') || process.cwd())).skills
    // What the MODEL would be offered, read from the real registry through the
    // agent's own scope. This is the ground truth the other two are compared to.
    let modelView = null
    try {
      const skillsService = agent?.ctx?.get?.('skills')
      const list = skillsService === undefined
        ? undefined
        : await skillsService.list({ scope: agent, cwd: process.cwd() })
      modelView = list === undefined
        ? null
        : list
          .filter((s) => s.invocation?.modelInvocable !== false)
          .map((s) => s.name)
          .sort()
    } catch { modelView = null }
    sendJson(response, 200, {
      ok: true,
      sessionId: id,
      agentLive: agent !== undefined,
      // 1. what the panel believes
      persistedDisabled: [...disabledForSession(home, id)].sort(),
      // 2. what the in-memory shadow layer holds (should equal the previous)
      shadowed: shadowedNames(id).sort(),
      shadowProviderRegistered: state !== undefined,
      // 3. what the model can actually use (must NOT contain any of the above)
      modelView,
      installed: installed.map((s) => s.name).sort(),
    })
    return
  }

  if (route === 'applied' && method === 'GET') {
    // Skills currently introduced into a session, newest last. `sessionId` must
    // be passed by the caller when it knows which window it is rendering —
    // otherwise the answer is whichever session happens to be most active, which
    // is shared across windows and therefore not what this window is showing.
    //
    // No id now means "no session", answered as empty, instead of the previous
    // `tracker.current()` fallback: that elected some other window's session and
    // rendered ITS chips here, which is the cross-session bleed being fixed.
    const explicit = url.searchParams.get('sessionId')
    if (!explicit) {
      sendJson(response, 200, {
        ok: true, sessionId: null, skills: [], modes: {}, disabled: [], pending: [], noSession: true,
      })
      return
    }
    const asked = explicit
    // Canonical key: the registries are written under the agent's own id, so a
    // read under the client's spelling would answer "nothing applied" for a
    // session that is very much applied. Falls back to the raw id when no live
    // agent matches, which is also the case where every registry is empty.
    const id = canonicalSession(ctx, asked)
    // SETTLE A SPENT TURN-SCOPED HOLD HERE, before answering.
    //
    // The read path is where a turn-scoped apply is retired, and it uses the
    // session LOG's turn number rather than a status event. The earlier rule
    // ("only `agent/status` may release") was a dead end on a host where that
    // notification never arrived: the hold was never spent, so the chips and the
    // registration survived the reply — "聊完一轮，技能没有退回去".
    //
    // This cannot revoke early. `settleTurnHolds` only releases when the log's
    // turn count has ADVANCED past the turn the apply was taken at, so an apply
    // made for a message that has not been sent yet is never touched. A
    // SESSION-mode apply is not in `pending` at all and is left alone.
    if (id !== undefined) settleTurnHolds(ctx, id)
    // `disabled` rides along so the composer chip and the panel can show the
    // session's real visibility state without a second round-trip. Session-scoped.
    const disabled = id !== undefined ? disabledForSession(home, id) : readDisabled(readStats(home))
    const live = id !== undefined ? introduced.get(id) : undefined
    // How each applied skill was applied. The cards use this to show WHICH kind
    // of availability a skill has right now — 本轮 (turn) burns at the turn
    // boundary, 本会话 (session) lasts until the chat closes.
    const modes = id !== undefined && applyMode.has(id)
      ? Object.fromEntries(applyMode.get(id))
      : {}
    sendJson(response, 200, {
      ok: true,
      sessionId: id ?? null,
      skills: live ? [...live.keys()] : [],
      modes,
      disabled: [...disabled],
      // The skills applied for the NEXT message, still unspent.
      pending: id !== undefined && pending.has(id) ? [...pending.get(id)] : [],
    })
    return
  }

  if (route === 'image' && method === 'GET') {
    const id = url.searchParams.get('id')
    if (!id || !/^[a-f0-9]{24}\.(png|jpe?g|webp|gif|svg)$/.test(id)) {
      sendError(response, 400, 'bad image id')
      return
    }
    const p = imagePath(home, id)
    if (!existsSync(p)) {
      sendError(response, 404, 'image not found')
      return
    }
    const ext = extname(id).toLowerCase()
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.webp' ? 'image/webp' : ext === '.jpg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png'
    const buf = readFileSync(p)
    sendFile(response, 200, mime, buf)
    return
  }

  // ---- POST routes (method enforcement) ----
  // Only routes explicitly meant for POST may pass; a GET on a POST-only route
  // (or a non-POST method) is rejected. Note `stats`/`categories` may also be
  // absent from GET_ROUTES, so gate on POST_ROUTES, not on the absence of GET.
  if (!POST_ROUTES.includes(route) || method !== 'POST') {
    sendError(response, 405, `method ${method} is not allowed on ${route}`)
    return
  }

  // Image upload carries a raw body (not JSON), so handle it before readJsonBody.
  if (route === 'image') {
    const contentType = String(request.headers['content-type'] || '')
    const mime = contentType.split(';')[0].trim().toLowerCase()
    if (!(mime in IMAGE_MIME)) {
      sendError(response, 415, 'unsupported image type')
      return
    }
    const buffer = await readRawBody(request)
    if (buffer.length === 0) {
      sendError(response, 400, 'empty image')
      return
    }
    const url = saveImage(home, buffer, mime)
    sendJson(response, 200, { ok: true, url })
    return
  }

  const body = await readJsonBody(request)

  if (route === 'cards') {
    // body: { name, image?, title?, description?, i18n? }  (image empty string clears;
    // i18n null clears the Chinese overlay, { zh, zhDesc? } sets it)
    const { name, image, title, description, i18n } = body
    if (typeof name !== 'string' || !name) {
      sendError(response, 400, 'missing skill name')
      return
    }
    // No base64 persistence: an image must be a served URL or a remote http(s)
    // link. Rejecting a pasted data: URI keeps skill-cards.json small.
    if (typeof image === 'string' && /^data:image\//i.test(image)) {
      sendError(response, 400, 'data:image is not supported; use a URL or local upload')
      return
    }
    if (i18n !== undefined && i18n !== null && (typeof i18n !== 'object' || typeof i18n.zh !== 'string' || !i18n.zh.trim())) {
      sendError(response, 400, 'i18n must be null or { zh, zhDesc? }')
      return
    }
    const config = readCardConfig(home)
    if (image === '' && title === undefined && description === undefined && i18n === undefined) {
      delete config[name]
    } else {
      const prev = config[name] || {}
      config[name] = {
        image: image === undefined ? (prev.image ?? null) : (image || null),
        title: title === undefined ? (prev.title ?? null) : (title || null),
        description: description === undefined ? (prev.description ?? null) : (description || null),
        // i18n: undefined keeps what is stored; null clears it; { zh,… } overwrites.
        i18n: i18n === undefined ? (prev.i18n ?? null) : (i18n ? { zh: i18n.zh.trim(), zhDesc: i18n.zhDesc ? String(i18n.zhDesc).trim() : null } : null),
      }
    }
    writeCardConfig(home, config)
    sendJson(response, 200, { ok: true, cards: config })
    return
  }

  if (route === 'i18n') {
    // body: { items: [{ name, zh, zhDesc? }] }  — batch Chinese-localisation
    // write produced by the in-panel prompt builder (or called directly by an
    // agent in the conversation). `name` must round-trip an installed skill;
    // unknown names are skipped so a stale client list cannot pollute config.
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) {
      sendError(response, 400, 'items is empty')
      return
    }
    const skills = (await scanInstalled(home, process.cwd())).skills
    const known = new Set(skills.map((s) => s.name))
    const config = readCardConfig(home)
    let applied = 0
    const skipped = []
    for (const it of items) {
      if (!it || typeof it.name !== 'string' || !it.name) continue
      if (typeof it.zh !== 'string' || !it.zh.trim()) { skipped.push(it.name); continue }
      if (!known.has(it.name)) { skipped.push(it.name); continue }
      const prev = config[it.name] || {}
      config[it.name] = {
        image: prev.image ?? null,
        title: prev.title ?? null,
        description: prev.description ?? null,
        i18n: {
          zh: it.zh.trim(),
          zhDesc: typeof it.zhDesc === 'string' && it.zhDesc.trim() ? it.zhDesc.trim() : null,
        },
      }
      applied++
    }
    writeCardConfig(home, config)
    sendJson(response, 200, { ok: true, applied, skipped })
    return
  }

  if (route === 'stats') {
    // body: { name, category?, starred? }  — partial update to one skill's stats
    const { name } = body
    if (typeof name !== 'string' || !name) {
      sendError(response, 400, 'missing skill name')
      return
    }
    const stats = readStats(home)
    const prev = stats[name] || {}
    const next = { ...prev }
    if (body.category === undefined && body.starred === undefined) {
      sendError(response, 400, 'nothing to update (provide category or starred)')
      return
    }
    if (body.category !== undefined) {
      const customCats = readCustomCategories(stats)
      const known = body.category in CATEGORY_DEFS || body.category in customCats
      if (body.category === null || body.category === '' || body.category === false) {
        // clearing the override → will fall back to the auto-suggestion
        delete next.category
      } else if (typeof body.category === 'string' && known) {
        next.category = body.category
      } else {
        sendError(response, 400, `unknown category: ${body.category}`)
        return
      }
    }
    if (body.starred !== undefined) {
      next.starred = !!body.starred
    }
    const updated = { ...stats, [name]: next }
    writeStats(home, updated)
    sendJson(response, 200, { ok: true, stats: updated })
    return
  }

  if (route === 'prefs') {
    // body: { layout?: 'fan'|'wall' } — partial update to the user's UI prefs
    const patch = {}
    if (body.layout !== undefined) {
      if (!PREF_VALUES.layout.includes(body.layout)) {
        sendError(response, 400, `unknown layout: ${body.layout}`)
        return
      }
      patch.layout = body.layout
    }
    if (Object.keys(patch).length === 0) {
      sendError(response, 400, 'nothing to update (provide layout)')
      return
    }
    // `writePrefs` whitelists again on its own and always returns the full,
    // authoritative set — the response can never disagree with the file.
    sendJson(response, 200, { ok: true, prefs: writePrefs(home, patch) })
    return
  }

  if (route === 'default-off') {
    // body: { disableByDefault: boolean }
    //
    // A machine-wide DEFAULT for sessions that have never been written. It does
    // not touch any existing session: those already own a persisted list, and
    // silently rewriting them would undo real per-chat choices.
    if (typeof body.disableByDefault !== 'boolean') {
      sendError(response, 400, 'disableByDefault must be boolean')
      return
    }
    const value = writeDisableByDefault(home, body.disableByDefault)
    sendJson(response, 200, { ok: true, disableByDefault: value })
    return
  }

  if (route === 'categories') {
    // body: { action: "add"|"rename"|"remove", label?, id? }
    const { action } = body
    if (action === 'add') {
      const id = addCustomCategory(home, body.label)
      if (id === null) {
        sendError(response, 400, `invalid or empty category label: ${body.label}`)
        return
      }
      sendJson(response, 200, { ok: true, id })
      return
    }
    if (action === 'rename') {
      const ok = typeof body.id === 'string' && renameCustomCategory(home, body.id, body.label)
      if (!ok) {
        sendError(response, 400, `cannot rename category: ${body.id}`)
        return
      }
      sendJson(response, 200, { ok: true })
      return
    }
    if (action === 'remove') {
      const ok = typeof body.id === 'string' && removeCustomCategory(home, body.id)
      if (!ok) {
        sendError(response, 400, `cannot remove category: ${body.id}`)
        return
      }
      sendJson(response, 200, { ok: true })
      return
    }
    sendError(response, 400, `unknown action: ${action}`)
    return
  }

  if (route === 'introduce') {
    // body: { sessionId?, names: string[], mode?: 'turn' | 'session' }
    //
    // mode selects the availability scope the user asked for:
    //   'turn'    — the default. Held across the turn the user is about to
    //               send, released the moment that turn ends. One-shot.
    //   'session' — stays registered for the whole session. Released when the
    //               session's agent is removed, not by the turn boundary.
    // The difference is purely WHICH registry the name is held in; the
    // registration and the shadow handling below are identical, because both
    // modes need the model to see the skill for the upcoming turn.
    const names = Array.isArray(body.names) ? body.names : []
    const mode = body.mode === 'session' ? 'session' : 'turn'
    if (names.length === 0) {
      sendError(response, 400, 'names is empty')
      return
    }
    const sessionId = requiredSessionId(body)
    if (sessionId === undefined) {
      // A MISSING id is not "use whatever is active". The host serves every open
      // window from one process, so guessing here wrote skills into an unrelated
      // chat — the reported 窜会话. Refuse instead.
      sendError(response, 400, 'missing sessionId (the host does not guess a session)')
      return
    }
    const agent = resolveAgent(ctx, sessionId)
    if (agent === undefined) {
      sendError(response, 404, `session "${sessionId}" is not a live agent`)
      return
    }
    // Every registry below is keyed by this ONE id, so a write here is visible
    // to the turn-end release and the /switch route.
    const key = canonicalSession(ctx, sessionId)
    const skills = (await scanInstalled(home, process.cwd())).skills
    const byName = new Map(skills.map((s) => [s.name, s]))
    const results = []
    for (const n of names) {
      const skill = byName.get(n)
      if (!skill) {
        results.push({ name: n, ok: false, reason: 'skill not found locally' })
        continue
      }
      // The switch governs AMBIENT visibility; "apply to this turn" is an
      // explicit one-shot opt-in. They are NOT mutually exclusive: a skill that
      // is off is normally shadowed (same name, modelInvocable:false). Applying
      // it lifts that shadow for one turn, then the shadow comes back when the
      // turn ends. Refusing here — the previous behaviour — is exactly why a
      // user's explicit opt-in silently did nothing.
      const wasOff = disabledForSession(home, key).has(skill.name)
      if (wasOff) {
        // Drop the shadow FIRST: it republishes the name at rank 0, which wins
        // over the real registration we are about to make in the same layer.
        unshadowSkill(key, skill.name)
      }
      try {
        const r = await introduceIntoSession(ctx, agent, skill)
        if (r.ok) {
          rememberIntroduced(key, r.name, r.dispose)
          results.push({ name: r.name, ok: true })
          log.info(`introduced "${r.name}" into session ${key}`)
          bumpUse(home, skill.name)
          rememberMode(key, r.name, mode)
          if (mode === 'turn') {
            // Held for the NEXT turn. The stamp is the session log's own turn
            // number, so the release can tell "the message was sent" from "no
            // message yet" without depending on any event being delivered.
            const turnAtApply = turnNumberOf(ctx, key)
            holdForNextTurn(key, [r.name], turnAtApply)
            // Remember that it was off, so the turn-end release restores the
            // shadow instead of leaving the skill permanently visible.
            if (wasOff) rememberTemporary(key, r.name, skill)
          } else {
            // Session mode: it stays for the whole session, so an off skill that
            // was applied this way stays lifted. Drop the temporary marker —
            // there is no turn boundary to restore it at.
            if (wasOff) forgetTemporary(key, r.name)
          }
        } else {
          results.push({ name: n, ok: false, reason: r.reason })
        }
      } catch (e) {
        results.push({ name: n, ok: false, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    sendJson(response, 200, { ok: true, sessionId, results })
    return
  }

  if (route === 'switch') {
    // body: { sessionId?, names: string[], enabled: boolean }
    //
    // Two jobs, in this order: persist the user's choice, then make the
    // session's shadow layer agree with it. Persisting first means a failure to
    // register the shadow still leaves a coherent store, and the response's
    // `results` reports exactly which names could not be enforced.
    const names = Array.isArray(body.names) ? body.names : []
    const enabled = body.enabled
    if (names.length === 0) {
      sendError(response, 400, 'names is empty')
      return
    }
    if (typeof enabled !== 'boolean') {
      sendError(response, 400, 'enabled must be boolean')
      return
    }
    const installed = (await scanInstalled(home, process.cwd())).skills
    rememberInstalled(installed)
    const known = new Set(installed.map((s) => s.name))
    const sessionId = requiredSessionId(body)
    if (sessionId === undefined) {
      // Same rule as /introduce: no id means no session, never "the active one".
      // A switch is a WRITE to a session's visibility, so a guess here greys out
      // skills in a chat the user is not even looking at.
      sendError(response, 400, 'missing sessionId (the host does not guess a session)')
      return
    }
    const applied = []
    const skipped = []
    const byName = new Map(installed.map((s) => [s.name, s]))
    for (const n of names) {
      if (typeof n !== 'string' || n === '') continue
      // An unknown name is skipped rather than stored: a stale client list must
      // not be able to write a choice for a skill that is not installed.
      if (!known.has(n)) { skipped.push(n); continue }
      applied.push(n)
    }
    // The switch is SESSION-SCOPED. Only THIS session's disabled set changes,
    // and only THIS session's shadow is touched — a toggle in one chat must not
    // grey the same skill out in another. No persistence, because the shadow it
    // drives is in-memory too: close the chat and the skill is visible again.
    //
    // The key is CANONICALISED first (see canonicalSession): every registry in
    // this file must agree on one key, or a write through the client's spelling
    // is invisible to a read through the agent's.
    const key = canonicalSession(ctx, sessionId)
    let results = []
    if (key !== undefined) {
      const set = disabledForSession(home, key)
      for (const n of applied) { if (enabled) set.delete(n); else set.add(n) }
      // Persist the choice so it survives a restart. This is the fix for
      // "关闭后 dsh 重启也要保持": the in-memory set alone is emptied on boot.
      persistSessionDisabled(home, key)
      if (enabled) {
        // Turning on: release the shadow for this session only.
        for (const n of applied) unshadowSkill(key, n)
        results = applied.map((n) => ({ name: n, ok: true }))
      } else {
        for (const n of applied) {
          // Revoke BEFORE shadowing, so the two are consistent whatever the
          // caller sent. A caller that only flips the switch (全部关闭, or the
          // panel's 清空 / the chips' 全部移除) must not leave a "live"
          // registration behind: /applied would keep listing the skill as
          // applied while the switch says it is off.
          revokeIntroduced(key, n)
          const held = pending.get(key)
          if (held) held.delete(n)
          forgetMode(key, n)
          // The shadow we are about to add IS the off state, so drop any
          // temporary marker — the turn-end restore would only re-add it.
          forgetTemporary(key, n)
          try {
            results.push(await shadowSkill(ctx, key, byName.get(n)))
          } catch (e) {
            results.push({ name: n, ok: false, reason: e instanceof Error ? e.message : String(e) })
          }
        }
        const stillHeld = pending.get(key)
        if (stillHeld && stillHeld.size === 0) pending.delete(key)
      }
    }
    sendJson(response, 200, {
      ok: true,
      sessionId: sessionId ?? null,
      enabled,
      applied,
      skipped,
      results,
      // No live session means the choice could not be enforced on a shadow, but
      // it is still recorded for this session if one existed.
      sessions: key !== undefined ? (shadows.has(key) ? 1 : 0) : 0,
      disabled: key !== undefined ? [...disabledForSession(home, key)] : [],
    })
    return
  }

  if (route === 'revoke') {
    // body: { sessionId?, names: string[] }  — remove applied skills from a session
    const names = Array.isArray(body.names) ? body.names : []
    if (names.length === 0) {
      sendError(response, 400, 'names is empty')
      return
    }
    const sessionId = requiredSessionId(body)
    if (sessionId === undefined) {
      sendError(response, 400, 'missing sessionId (the host does not guess a session)')
      return
    }
    const key = canonicalSession(ctx, sessionId)
    const held = pending.get(key)
    if (held) for (const n of names) held.delete(n)
    if (held && held.size === 0) { pending.delete(key); pendingTurn.delete(key) }
    // A manual revoke must release the temporary marker too, or an OFF skill
    // that was applied for this turn would keep its shadow lifted forever.
    for (const n of names) { forgetMode(key, n); forgetTemporary(key, n) }
    const results = names.map((n) => ({ name: n, ok: revokeIntroduced(key, n) }))
    const removed = results.filter((r) => r.ok).map((r) => r.name)
    if (removed.length > 0) log.info(`revoked [${removed.join(', ')}] from session ${sessionId}`)
    sendJson(response, 200, { ok: true, sessionId, results })
    return
  }
}
