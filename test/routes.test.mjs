/**
 * Regression test for the host-side HTTP route contract.
 *
 * DSH's desktop shell forwards only `/api/*` and `/plugins/*` from the renderer
 * to the plugin host. Any other prefix (an earlier version used `/skill-cards/`)
 * is answered 404 by the shell before it ever reaches `webServer`, so every
 * request from the UI failed while the host code was perfectly healthy.
 *
 * Also locks in two related traps:
 *   - the route prefix the client builds must equal the one the host registers;
 *   - `inject` must not list agent-scoped services, which pend `apply()` forever.
 *
 * Run: node --test test/routes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientSrc = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')
const statsSrc = readFileSync(join(here, '..', 'lib', 'stats.js'), 'utf8')

/** The prefixes DSH will actually forward from the shell to a plugin host. */
const FORWARDED_PREFIXES = ['/api/', '/plugins/']

test('host registers its routes under a shell-forwarded prefix', () => {
  const m = hostSrc.match(/const API_PREFIX = '([^']+)'/)
  assert.ok(m, 'API_PREFIX not found in lib/index.js')
  const prefix = m[1]
  assert.ok(
    FORWARDED_PREFIXES.some((p) => prefix.startsWith(p)),
    `API_PREFIX "${prefix}" is not under any shell-forwarded prefix ` +
      `(${FORWARDED_PREFIXES.join(', ')}); the UI would get 404 from the shell`,
  )
})

test('API_PREFIX has no trailing slash (it would make every route 404)', () => {
  const prefix = hostSrc.match(/const API_PREFIX = '([^']+)'/)[1]
  // dsh-host-webserver match(): pathname === prefix || startsWith(prefix + '/')
  // With a trailing slash the second clause becomes "prefix + '//'", so no real
  // request path ever matches and the whole plugin silently 404s.
  assert.ok(
    !prefix.endsWith('/'),
    `API_PREFIX "${prefix}" ends with a slash; DSH's prefix matcher would then ` +
      'require a double slash in the request path and never match',
  )
  const matcher = (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  assert.ok(matcher(`${prefix}/skills`), 'a route under the prefix must match')
  assert.ok(matcher(prefix), 'the bare prefix must match')
})

test('client builds requests against the same prefix the host registers', () => {
  const host = hostSrc.match(/const API_PREFIX = '([^']+)'/)[1].replace(/\/$/, '')
  // The client resolves its API base from document.baseURI at runtime; the
  // literal it anchors on must match the host's registered prefix.
  const m = clientSrc.match(/new URL\('([^']+)',\s*document\.baseURI\)/)
  assert.ok(m, 'client API base resolution not found')
  assert.equal(
    `/${m[1].replace(/^\//, '')}`,
    host,
    'client API base and host API_PREFIX have drifted apart',
  )
})

test('client falls back to the same prefix without a document', () => {
  const host = hostSrc.match(/const API_PREFIX = '([^']+)'/)[1].replace(/\/$/, '')
  const m = clientSrc.match(/catch\s*\{\s*return\s*'([^']+)'\s*\}/)
  assert.ok(m, 'client API fallback not found')
  assert.equal(m[1], host)
})

test('inject declares no agent-scoped services (they would pend apply forever)', () => {
  const m = hostSrc.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(m, 'inject export not found')
  const deps = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  for (const scoped of ['agents', 'skills', 'sessions']) {
    assert.ok(
      !deps.includes(scoped),
      `inject must not declare "${scoped}": it is agent-scoped, so awaiting it at ` +
        'the root scope suspends apply() and the HTTP routes never register',
    )
  }
  assert.ok(deps.includes('webServer'), 'webServer must be injected')
})

test('host reads agent-scoped services opportunistically via ctx.get', () => {
  assert.match(hostSrc, /function service\(ctx, name\)/, 'opportunistic service() helper missing')
  assert.ok(
    !/ctx\.agents\.get\(/.test(hostSrc),
    'use service(ctx, "agents")?.get?.(...) instead of a direct ctx.agents.get() read',
  )
})

test('the earlier broken prefix is not used anywhere', () => {
  assert.ok(!hostSrc.includes("'/skill-cards/'"), 'host still registers the un-forwarded /skill-cards/ prefix')
  assert.ok(!clientSrc.includes("'/skill-cards'"), 'client still targets the un-forwarded /skill-cards prefix')
})

test('image upload/persist routes are registered under the forwarded prefix', () => {
  // GET /image serves an uploaded file; POST /image persists one.
  assert.match(hostSrc, /'image'/, 'image route must be registered in the route tables')
  assert.match(hostSrc, /route === 'image' && method === 'GET'/, 'GET /image (serve) route missing')
  assert.match(hostSrc, /route === 'image'\)\s*\{|if \(route === 'image'\)/, 'POST /image (upload) route missing')
})

test('uploaded images are persisted as files, never as base64 in the card config', () => {
  // The core "no base64" guarantee: skill-cards.json stores only a served URL.
  assert.match(hostSrc, /saveImage\(/, 'saveImage helper must exist')
  assert.match(hostSrc, /IMAGE_DIR_NAME\s*=\s*'skill-cards-images'/, 'uploaded images need their own store dir')
  // The client no longer invites users to paste a base64 data: URI.
  assert.ok(/本地选图或粘贴 http/.test(clientSrc) || /Pick a local file or paste an http/.test(clientSrc),
    'client should steer users to files/URLs, not data: URIs')
  // The host rejects a pasted data:image base64 string instead of persisting it.
  assert.ok(hostSrc.includes("data:image//") || /data:image\\\//.test(hostSrc) || /data:image\//.test(hostSrc),
    'host must reject base64 data: URIs, not store them')
  // The GET route only serves strict hashed ids — no path traversal.
  assert.ok(hostSrc.includes('[a-f0-9]{24}\\.(png|jpe?g|webp|gif|svg)'),
    'image id must be a strict hex+ext format')
})

test('vendor route serves the bundled three.js and the card-back texture only', () => {
  // The 3D card wall needs three.js at runtime; DSH's client module table has
  // no `three` seed, so the plugin ships its own UMD build and serves it from
  // /plugins/dsh-skill-cards/vendor/three.min.js (same-origin, immutable cache).
  // The gacha card back likewise ships an engraved texture (card-back.jpg).
  assert.ok(hostSrc.includes("'vendor'"), 'vendor route must be in the GET route table')
  assert.match(hostSrc, /route === 'vendor' \|\| route\.startsWith\('vendor\/'\)/,
    'vendor dispatch must accept vendor/<file> tails')
  // Allow-list is table-driven now: both files must be listed with a mime.
  assert.match(hostSrc, /'three\.min\.js':\s*'application\/javascript/, 'three.min.js must be allow-listed')
  assert.match(hostSrc, /'card-back\.jpg':\s*'image\/jpeg'/, 'card-back.jpg must be allow-listed')
  assert.match(hostSrc, /new URL\('\.\.\/vendor\/', import\.meta\.url\)/,
    'vendor route must resolve against the package vendor/ directory')
  assert.match(hostSrc, /cache-control': 'public, max-age=31536000, immutable'/,
    'vendor files should be cached as immutable (they are content-addressed by plugin version)')
  // The client must load them through the API base, not a hard-coded origin.
  assert.match(clientSrc, /vendor\/three\.min\.js/, 'client must reference the vendor URL via the API base')
  assert.match(clientSrc, /vendor\/card-back\.jpg/, 'client must reference the bundled card-back texture')
  assert.match(clientSrc, /className: 'gc-back-img'/, 'card-back texture must be a real <img> element')
  assert.match(clientSrc, /object-fit:cover/, 'texture img must use object-fit:cover (background-size var layers kept failing)')
  assert.doesNotMatch(clientSrc, /background-image:var\(--dsh-sc-back-tex/, 'the fragile var()-url background layer must be gone')
})

test('stats: host exposes GET/POST /stats and merges stats+category into /skills', () => {
  // GET /stats serves the stats store and the category dictionary.
  assert.ok(hostSrc.includes("'stats'"), 'stats route must be in the GET route table')
  assert.match(hostSrc, /route === 'stats' && method === 'GET'/, 'GET /stats route missing')
  // POST /stats updates one skill's category / starred.
  assert.match(hostSrc, /route === 'stats'\)\s*\{/, 'POST /stats route missing')
  assert.match(hostSrc, /missing skill name/, 'POST /stats must validate a skill name')
  // The stats store is a separate file from the cover config.
  assert.match(statsSrc, /STATS_FILE_NAME\s*=\s*'skill-cards-stats\.json'/, 'stats must live in its own file')
  // /skills must carry per-skill stats + the resolved category + the suggestion
  // (so a cleared override can fall back without the client re-deriving it).
  assert.match(hostSrc, /stats:\s*stats\[s\.name\]/, '/skills must inline each skill stats')
  assert.match(hostSrc, /category:/, '/skills must pass the resolved category')
  assert.match(hostSrc, /suggestedCategory:/, '/skills must pass the auto-suggestion fallback')
  assert.match(hostSrc, /categories:\s*(CATEGORY_DEFS|defs)/, '/skills must expose the category dictionary')
  // Applying a skill should record a use.
  assert.match(hostSrc, /bumpUse\(/, 'introduce must bump the use counter')
  // The client reflects the same vocabulary (filter chips + per-card category).
  assert.match(clientSrc, /CatFilterRow/, 'client must render the category filter row')
  assert.match(clientSrc, /dsh-sc-cat/, 'client must expose per-card category control')
  assert.match(clientSrc, /dsh-sc-uses/, 'client must show the uses badge')
  assert.match(clientSrc, /dsh-sc-star/, 'client must render the star/favorite toggle')
  assert.match(clientSrc, /GachaReveal/, 'client must render the gacha reveal on apply')
  assert.match(clientSrc, /store\.triggerGacha\(\{ cards/, 'client must hand captured rects to the gacha reveal via the store')
  // Custom categories: host supports add/rename/remove and merges them into the
  // /skills dict (flagged custom) so the client can make them editable.
  assert.match(hostSrc, /route === 'categories'/, 'host must expose a categories management route')
  assert.match(hostSrc, /addCustomCategory/, 'host must add a custom category')
  assert.match(hostSrc, /renameCustomCategory/, 'host must rename a custom category')
  assert.match(hostSrc, /removeCustomCategory/, 'host must remove a custom category')
  assert.match(clientSrc, /CategoryManager/, 'client must render the category manager')
})

test('stats: the client plural/format helper uses t as a function (locale contract)', () => {
  // Function-valued dictionary entries are legal; ensure the locale test's
  // `t('key')` style still applies to these stat keys (they are declared, and
  // the client calls them with parentheses).
  for (const k of ['filterAll', 'filterStarred', 'sortByUses', 'clearCategory', 'usesCount']) {
    assert.ok(
      clientSrc.includes(`'${k}'`),
      `expected stat key '${k}' to appear in the client (zh and en)`,
    )
  }
})

test('stats and categories are dual-route: a POST must not be rejected as "not allowed"', () => {
  // Regression: the POST-enforcement guard previously gated on GET_ROUTES, so a
  // POST to /stats (or /categories) — both listed in POST_ROUTES — was wrongly
  // answered 405. The guard must gate on POST_ROUTES membership instead.
  const i = hostSrc.indexOf('// ---- POST routes (method enforcement) ----')
  assert.ok(i !== -1, 'found POST enforcement guard')
  // In the guard block: gate on POST_ROUTES contains(route) AND method===POST.
  const block = hostSrc.slice(i, i + 420)
  assert.match(block, /POST_ROUTES\.includes\(route\)/, 'POST guard must gate on POST_ROUTES membership')
  assert.match(block, /method !== 'POST'/, 'POST guard must still require the POST method')
  // /stats and /categories both belong to POST_ROUTES.
  assert.match(hostSrc, /const POST_ROUTES = \[[^\]]*'stats'[^\]]*\]/, 'stats must be POST-able')
  assert.match(hostSrc, /const POST_ROUTES = \[[^\]]*'categories'[^\]]*\]/, 'categories must be POST-able')
})

test('revoke: host exposes GET /applied + POST /revoke and keeps the disposer', () => {
  // The whole point of the applied registry: introduceIntoSession hands back a
  // disposer, and the host must remember it per session+skill so a chip's × can
  // actually unregister the skill (previously the disposer was dropped).
  assert.match(hostSrc, /const GET_ROUTES = \[[^\]]*'applied'[^\]]*\]/, 'applied must be GET-able')
  assert.match(hostSrc, /const POST_ROUTES = \[[^\]]*'revoke'[^\]]*\]/, 'revoke must be POST-able')
  assert.match(hostSrc, /route === 'applied' && method === 'GET'/, 'GET /applied route missing')
  assert.match(hostSrc, /route === 'revoke'/, 'POST /revoke route missing')
  assert.match(hostSrc, /rememberIntroduced\(key, r\.name, r\.dispose\)/,
    'introduce must remember the disposer for later revocation')
  assert.match(hostSrc, /function revokeIntroduced/, 'revoke helper missing')
  assert.match(hostSrc, /skills\.register\(/, 'introduce registers on the session-scoped skills service')
  // GET /applied answers with the session's applied list; the client renders it.
  assert.match(clientSrc, /api\(\`\/applied\${q}\`\)/, 'client must fetch /applied to seed the chips')
  assert.match(clientSrc, /api\('\/revoke'/, 'client must call /revoke from the chip ×')
  assert.match(clientSrc, /AppliedChips/, 'client must render applied chips')
})

test('applied chips: collapsed popover with clear-all; gacha reveal after apply', () => {
  // The composer chip area must render a collapsed toggle (count pill), not an
  // always-expanded chip row — an expanded row wraps and deforms the composer.
  assert.match(clientSrc, /dsh-sc-applied-toggle/, 'collapsed toggle pill missing')
  assert.match(clientSrc, /dsh-sc-chip-pop/, 'chip popover missing')
  // Clear-all: one POST /revoke carrying every applied name.
  assert.match(clientSrc, /revokeAll/, 'clear-all action missing')
  assert.match(clientSrc, /revokeNames\(\[\.\.\.applied\]\)/, 'clear-all must revoke every applied name at once')
  // The post-apply ceremony is the gacha reveal (card-backs fly in, then flip
  // face-up one by one); the old fly-to-centre burst is retired.
  assert.match(clientSrc, /GachaReveal/, 'client must render the gacha reveal on apply')
  assert.match(clientSrc, /store\.triggerGacha\(\{ cards/, 'client must hand captured rects to the gacha reveal (via the store, so the show survives the modal closing)')
  assert.match(clientSrc, /dsh-sc-gacha-flip/, 'gacha flip structure must exist in CSS')
  assert.match(clientSrc, /dshScGachaEnter/, 'gacha fly-in keyframes must exist')
  assert.doesNotMatch(clientSrc, /dsh-sc-burst-fly/, 'the retired warp-burst layers must be gone')
  // Reveal cards must resolve category ids to labels like the grid does.
  assert.match(clientSrc, /catDefs\[id\]/, 'gacha reveal must map category id → label')
  assert.doesNotMatch(clientSrc, /catLabel: meta\.category \|\| '·'/, 'gacha must not show the raw category id')
})

test('reopen seeds the selection with the session applied skills', () => {
  // Re-opening the panel must pre-check the skills already applied to the
  // session (GET /applied), otherwise users re-select them blindly.
  assert.match(clientSrc, /Seed the selection with the skills already applied/,
    'selection seeding effect missing')
  assert.match(clientSrc, /api\(`\/applied\$\{q\}`\)[\s\S]{0,700}setSelected\(new Set\(names\)\)/,
    'seeding must fetch /applied and put the names into `selected`')
  // Guard rails: only seed a BLANK selection — never re-check a skill the user
  // deliberately deselected, and keep the composer chips in sync either way.
  assert.match(clientSrc, /selected\.size > 0\) return/,
    'seeding must skip when the user has already selected something')
  // No session → nothing to seed, and no request that could be answered for
  // another chat.
  assert.match(clientSrc, /if \(ownSessionId === undefined\) return/,
    'seeding must not run without a session of its own')
  // The chips are only overwritten when this panel IS the composer's session, so
  // a root-scope settings mount cannot relabel another chat's chips.
  assert.match(clientSrc, /if \(store\.get\(\)\.sessionId === ownSessionId\) store\.setApplied\(names, ap\.modes\)/,
    'seeding must keep the composer chips in sync, but only for its own session')
})

test('clear semantics: popover revocation syncs the panel selection one-way', () => {
  // The composer popover is the ONLY revocation writer; the panel listens and
  // un-checks revoked skills (plan-A one-way sync). The panel "clear" button
  // clears the selection AND revokes selected skills that are already applied
  // (seeding applied skills into the selection means clear must undo them).
  assert.match(clientSrc, /notifyRevoked\(names\)/,
    'popover revoke success must notify the panel')
  assert.match(clientSrc, /onRevoked\(\(names\) =>/, 'panel must subscribe to revocation notices')
  // The clear callback resets the selection, revokes the applied subset AND
  // turns those skills OFF. The third step is the point: revoking alone leaves
  // the switch on, so the model sees the skill again on the next turn — "清空"
  // means "这批技能不要了", not "this turn only".
  const clearFn = clientSrc.match(/const clear = useCallback\(\(\) => \{[\s\S]*?\n      \}, \[selected, revokeApplied, disableSkills, t, showToast\]\)/)
  assert.ok(clearFn, 'panel clear callback missing')
  assert.match(clearFn[0], /setSelected\(new Set\(\)\)/, 'panel clear must reset the selection')
  assert.match(clearFn[0], /revokeApplied\(names\)/,
    'panel clear must revoke through the shared helper')
  assert.match(clearFn[0], /disableSkills\(names\)/,
    'panel clear must also switch the cleared skills off')
  // ...and that helper is what keeps the composer chips in sync.
  const revokeFn = clientSrc.match(/const revokeApplied = useCallback\(async \(names\) => \{[\s\S]*?\n      \}, \[store\]\)/)
  assert.ok(revokeFn, 'shared revoke helper missing')
  assert.match(revokeFn[0], /store\.notifyRevoked\(live\)/,
    'revocation must keep the composer chips in sync')
  assert.match(revokeFn[0], /store\.setApplied\(/,
    'revocation must drop the names from the applied set')
})

test('i18n: host exposes POST /i18n and the client ships the prompt protocol', () => {
  // Host: the batch Chinese-localisation write route exists and validates.
  assert.match(hostSrc, /const POST_ROUTES = \[[^\]]*'i18n'[^\]]*\]/, 'i18n must be POST-able')
  assert.match(hostSrc, /route === 'i18n'/, 'i18n route missing')
  // Unknown skill names are skipped, never written — a stale client list must
  // not pollute skill-cards.json.
  const block = hostSrc.match(/if \(route === 'i18n'\) \{[\s\S]*?\n  \}\n/)
  assert.ok(block, 'i18n route block found')
  assert.match(block[0], /known\.has\(it\.name\)/, 'i18n must skip unknown skill names')
  assert.match(block[0], /writeCardConfig\(home, config\)/, 'i18n must persist to skill-cards.json')
  // Client: prompt builder + reply parser + panel + per-card button.
  assert.match(clientSrc, /function buildI18nPrompt/, 'prompt builder missing')
  assert.match(clientSrc, /function parseI18nReply/, 'reply parser missing')
  assert.match(clientSrc, /I18nPanel/, 'i18n panel component missing')
  assert.match(clientSrc, /dsh-sc-trans/, 'per-card translate button missing')
  assert.match(clientSrc, /api\('\/i18n'/, 'client must POST /i18n')
  // The i18n write goes through the same config store; the render path prefers it.
  assert.match(clientSrc, /custom\?\.i18n\?\.zh/, 'card title must prefer the i18n name')
})

test('game-card skin: theme table drives the frame; unknown categories hash a hue', () => {
  assert.match(clientSrc, /const GC_THEMES = \{/, 'category theme table missing')
  for (const id of ['dev', 'test', 'design', 'security', 'data']) {
    assert.match(clientSrc, new RegExp(`${id}:\\s*\\{ frame:`), `theme for ${id} missing`)
  }
  assert.match(clientSrc, /function gcHashHue/, 'hash-hue fallback missing')
  assert.match(clientSrc, /function gcStyleProps/, 'style-prop builder missing')
  assert.match(clientSrc, /--gc-frame/, 'frame CSS var must be injected')
  // Foil sweep: the light-bar translates (not background-position), so the
  // loop seam is invisible.
  assert.match(clientSrc, /@keyframes dshScFoilSweep \{\s*\n\s*from \{ transform:translateX\(0\)/,
    'foil sweep must translate the light bar (seamless loop)')
  assert.doesNotMatch(clientSrc, /animation:.*foil.*ease-in-out/, 'foil sweep must not ease (would stutter)')
  // The sweep must be hover-only: an always-on SR sweep read as "moving
  // without being touched". SR is marked by a static halo instead.
  assert.doesNotMatch(clientSrc, /\.dsh-sc-gcard\.sr \.gc-foil \{ opacity:1/, 'SR foil must not sweep at rest')
  assert.match(clientSrc, /\.dsh-sc-gcard\.sr \{ box-shadow:[^}]*201,162,75/, 'SR must carry a static golden halo')
  // A halo is only a hint — the rarity must also be LABELLED on the card face,
  // otherwise a player cannot tell at grid size why one card glows.
  assert.match(clientSrc, /className: 'gc-sr'/, 'SR cards must render a readable rarity plate')
})

test('/applied answers for the session the caller names, never a remembered one', async () => {
  // Two windows share one host process. Window A applies skills; window B asks
  // for its own (empty) state. An earlier version remembered the last explicit
  // session globally, so B was answered with A's skills.
  //
  // This asserts the route contract that makes isolation possible: a named
  // sessionId decides the answer, and a request with no id must NOT silently
  // inherit another window's session.
  const source = hostSrc
  assert.ok(!/setExplicit/.test(source),
    'the host must not keep a cross-request "explicit session" — it leaks between windows')
  assert.ok(!/this\.explicitId/.test(source),
    'no global explicitId field may exist on the session tracker')
  // There is no fallback at all now: an id-less request is answered as empty,
  // because the only session the host could elect is another window's.
  assert.ok(!/explicit \|\| tracker\.current\(\)/.test(source),
    '/applied must not fall back to "the active session" — that is the bleed')
  assert.match(source, /if \(!explicit\) \{[\s\S]*?noSession: true/,
    '/applied must answer an id-less request as explicitly sessionless')
  // A named id is canonicalised so the read hits the same registry key the
  // writes used.
  assert.match(source, /const asked = explicit\n/,
    '/applied must read the caller-supplied sessionId verbatim')
  assert.match(source, /const id = canonicalSession\(ctx, asked\)/,
    '/applied must canonicalise the id before reading the registries')
})

test('the client always states its own session id when asking for applied skills', () => {
  const source = clientSrc
  // The composer and settings slots are session-scoped and receive the owning
  // session as `sessionId`; the wrapper must forward it to /applied.
  assert.match(source, /function useOwnSessionId\(props\)/, 'a shared resolver must exist')
  assert.match(source, /props && props\.sessionId/, 'the direct sessionId prop must be preferred')
  assert.match(source, /api\(`\/applied\$\{q\}`\)/, '/applied must carry the session id')
  assert.match(source, /const q = ownSessionId \? `\?sessionId=\$\{encodeURIComponent\(ownSessionId\)\}` : ''/,
    'the query must encode the window own session id')
  // Both entries must forward props, or the wrapper cannot see sessionId.
  assert.match(source, /e\(withAppliedSync\(ComposerButton\), \{ store, t, \.\.\.props \}\)/,
    'the composer entry must forward its slot props')
})
