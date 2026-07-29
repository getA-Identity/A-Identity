/**
 * Check config.mjs before it reaches Discord.
 *
 *   npm run validate
 *
 * Why this exists: a live setup run is not a safe place to discover a typo. Half the
 * config lands, the run throws, and you are left reconciling a partly built server by
 * hand. Everything asserted here is either a documented Discord limit or a requirement
 * of how setup.mjs works, and all of it is knowable offline.
 *
 * The one that is easiest to get wrong and hardest to notice: Discord silently rewrites
 * text and forum channel names to lowercase-with-hyphens. Name a channel "Mod Log" and
 * Discord creates "mod-log", so setup.mjs looks for "Mod Log" on the next run, does not
 * find it, and creates a second channel. Forever. Idempotency depends on the name you
 * write being the name Discord keeps.
 */
import { ROLES, TREE, SCAM_PHRASES, IMPERSONATION_PATTERNS, welcomeEmbed, announcementEmbed, roadmapEmbed, generalEmbed } from './config.mjs'
import { PermissionFlagsBits } from 'discord.js'
import { readFileSync } from 'node:fs'

let failures = 0
let checks = 0
const fail = (msg) => { failures += 1; console.log(`  \x1b[31m✗\x1b[0m ${msg}`) }
const pass = (msg) => { checks += 1; console.log(`  \x1b[32m✓\x1b[0m ${msg}`) }
const assert = (cond, okMsg, failMsg) => (cond ? pass(okMsg) : fail(failMsg ?? okMsg))
const group = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

const allChannels = TREE.flatMap((g) => g.channels.map((c) => ({ ...c, category: g.category })))

// ── roles ────────────────────────────────────────────────────────────────────
group('Roles')
const roleNames = ROLES.map((r) => r.name)
assert(new Set(roleNames).size === roleNames.length, 'role names are unique', `duplicate role name: ${roleNames.filter((n, i) => roleNames.indexOf(n) !== i)}`)
const roleKeys = ROLES.map((r) => r.key)
assert(new Set(roleKeys).size === roleKeys.length, 'role keys are unique')
assert(roleNames.every((n) => n.length <= 100), 'every role name is within 100 characters')
const admins = ROLES.filter((r) => r.admin)
assert(admins.length === 1 && admins[0].key === 'core', 'exactly one role carries Administrator, and it is Core Team', `admin roles: ${admins.map((r) => r.name)}`)
const mod = ROLES.find((r) => r.key === 'mod')
assert(mod && !mod.admin, 'Moderator is not an administrator')
assert(
  mod && !mod.permissions?.includes(PermissionFlagsBits.Administrator) && !mod.permissions?.includes(PermissionFlagsBits.ManageGuild) && !mod.permissions?.includes(PermissionFlagsBits.ManageRoles),
  'Moderator cannot manage the server or roles, only messages and members',
)
assert(!roleNames.some((n) => /^verified$/i.test(n)), 'no role is called "Verified", which would read as a product KYA claim')

// ── channels ─────────────────────────────────────────────────────────────────
group('Channels')
const chNames = allChannels.map((c) => c.name)
assert(
  new Set(chNames).size === chNames.length,
  'channel names are unique across every category',
  `setup.mjs matches channels by name, so duplicates never converge: ${chNames.filter((n, i) => chNames.indexOf(n) !== i)}`,
)
const catNames = TREE.map((g) => g.category)
assert(new Set(catNames).size === catNames.length, 'category names are unique')

// Discord slugifies text and forum channel names. Voice channels keep what you give them.
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9\-_]+/g, '-').replace(/^-+|-+$/g, '')
const badNames = allChannels.filter((c) => c.type !== 'voice' && slug(c.name) !== c.name)
assert(
  badNames.length === 0,
  'every text and forum channel name survives Discord slugification unchanged',
  `Discord would rewrite these, breaking idempotency: ${badNames.map((c) => `${c.name} → ${slug(c.name)}`).join(', ')}`,
)
assert(allChannels.every((c) => c.name.length >= 1 && c.name.length <= 100), 'channel names are within 100 characters')
const longTopics = allChannels.filter((c) => (c.topic?.length ?? 0) > 1024)
assert(longTopics.length === 0, 'every channel topic is within 1024 characters', `too long: ${longTopics.map((c) => c.name)}`)
const voiceWithTopic = allChannels.filter((c) => c.type === 'voice' && c.topic)
assert(voiceWithTopic.length === 0, 'no voice channel carries a topic, which Discord would reject')

// A read-only channel that nobody can post in still needs someone who can.
const roChannels = allChannels.filter((c) => c.ro ?? TREE.find((g) => g.category === c.category)?.ro)
assert(roChannels.length > 0, `${roChannels.length} channels are read-only for @everyone`)

group('Forum channels')
const forums = allChannels.filter((c) => c.type === 'forum')
for (const f of forums) {
  assert((f.tags?.length ?? 0) <= 20, `#${f.name} has at most 20 tags`, `#${f.name} has ${f.tags?.length} tags, Discord allows 20`)
  const tooLong = (f.tags ?? []).filter((t) => t.length > 20)
  assert(tooLong.length === 0, `#${f.name} tag names are within 20 characters`, `#${f.name}: ${tooLong.join(', ')}`)
}
if (!forums.length) pass('no forum channels to check')

// ── AutoMod ──────────────────────────────────────────────────────────────────
group('AutoMod')
assert(SCAM_PHRASES.length <= 1000, `scam list has ${SCAM_PHRASES.length} entries, under the 1000 keyword limit`)
const longPhrases = SCAM_PHRASES.filter((p) => p.length > 60)
assert(longPhrases.length === 0, 'every scam phrase is within 60 characters', `too long: ${longPhrases.join(', ')}`)
assert(new Set(SCAM_PHRASES).size === SCAM_PHRASES.length, 'no duplicate scam phrases')
assert(SCAM_PHRASES.every((p) => p === p.toLowerCase()), 'scam phrases are lowercase (AutoMod matches case-insensitively; mixed case just reads as a mistake)')
const longPatterns = IMPERSONATION_PATTERNS.filter((p) => p.length > 60)
assert(longPatterns.length === 0, 'impersonation patterns are within 60 characters')
assert(
  IMPERSONATION_PATTERNS.every((p) => !p.includes('**')),
  'no impersonation pattern uses a double wildcard, which Discord rejects',
)
// A keyword rule with an alert action needs somewhere to alert.
assert(chNames.includes('mod-log'), 'a #mod-log channel exists for AutoMod alerts to land in')

// ── embeds ───────────────────────────────────────────────────────────────────
group('Pinned embeds')
const EMBEDS = { welcome: welcomeEmbed, announcement: announcementEmbed, roadmap: roadmapEmbed, general: generalEmbed }
for (const [key, e] of Object.entries(EMBEDS)) {
  let total = 0
  assert((e.title?.length ?? 0) <= 256, `${key}: title within 256`, `${key}: title is ${e.title?.length}`)
  total += e.title?.length ?? 0
  assert((e.description?.length ?? 0) <= 4096, `${key}: description within 4096`, `${key}: description is ${e.description?.length}`)
  total += e.description?.length ?? 0
  const fields = e.fields ?? []
  assert(fields.length <= 25, `${key}: at most 25 fields`)
  for (const f of fields) {
    if (f.name.length > 256) fail(`${key}: field name "${f.name.slice(0, 30)}…" is ${f.name.length}, limit 256`)
    if (f.value.length > 1024) fail(`${key}: field "${f.name}" value is ${f.value.length}, limit 1024`)
    total += f.name.length + f.value.length
  }
  total += e.footer?.text?.length ?? 0
  assert(total <= 6000, `${key}: total embed length ${total} within 6000`)
  assert(Boolean(e.footer?.text), `${key}: carries a footer marker so re-runs recognize their own pin`)
}
const markers = Object.values(EMBEDS).map((e) => e.footer?.text)
assert(new Set(markers).size === markers.length, 'every embed marker is distinct, so pins do not shadow each other')

// A `<#name>` mention does not resolve: Discord only links `<#123456789>`. Written as
// text it renders as literal broken markup, which looks worse than a plain name.
group('Embed channel references')
const embedText = JSON.stringify(EMBEDS)
const badMentions = [...embedText.matchAll(/<#([^0-9>][^>]*)>/g)].map((m) => m[0])
assert(badMentions.length === 0, 'no embed uses a <#name> mention, which Discord renders as literal text', `broken: ${badMentions.join(', ')}`)
// Any plain #channel-name we point people at should actually exist and be visible.
const referenced = [...embedText.matchAll(/#([a-z0-9][a-z0-9-]{2,})/g)].map((m) => m[1])
const privateNames = allChannels.filter((c) => c.private ?? TREE.find((g) => g.category === c.category)?.private).map((c) => c.name)
const missing = [...new Set(referenced)].filter((n) => chNames.includes(n) === false && n !== 'channels')
assert(missing.length === 0, 'every #channel named in the pins exists', `named but not created: ${missing.join(', ')}`)
const pointedAtPrivate = [...new Set(referenced)].filter((n) => privateNames.includes(n))
assert(
  pointedAtPrivate.length === 0,
  'no pin sends members to a staff-only channel',
  `members cannot see these: ${pointedAtPrivate.join(', ')}`,
)

// ── setup.mjs references ─────────────────────────────────────────────────────
// Same drift guard as the chain registry uses: the code and the data are two
// statements of one thing, so they are asserted equal rather than kept in step by hand.
group('setup.mjs matches the config')
const src = readFileSync(new URL('setup.mjs', import.meta.url), 'utf8')
const chanRefs = [...src.matchAll(/chan\['([^']+)'\]/g)].map((m) => m[1])
const chansMissing = [...new Set(chanRefs)].filter((n) => !chNames.includes(n))
assert(chansMissing.length === 0, `all ${new Set(chanRefs).size} channels setup.mjs reads exist in the tree`, `setup.mjs reads channels that are never created: ${chansMissing.join(', ')}`)

const roleRefs = [
  ...[...src.matchAll(/roles\(([^)]*)\)/g)].flatMap((m) => m[1].split(',')),
  ...[...src.matchAll(/real\('([^']+)'\)/g)].map((m) => `'${m[1]}'`),
  ...[...src.matchAll(/role\.([a-z_]+)/g)].map((m) => `'${m[1]}'`),
]
  .map((s) => s.trim().replace(/^'|'$/g, ''))
  .filter((s) => s && !s.includes('.') && s !== 'key')
const rolesMissing = [...new Set(roleRefs)].filter((k) => !roleKeys.includes(k))
assert(rolesMissing.length === 0, `all ${new Set(roleRefs).size} role keys setup.mjs reads exist in ROLES`, `setup.mjs reads role keys that are never created: ${rolesMissing.join(', ')}`)

// Discord allows at most 5 channels on the welcome screen.
const welcomeScreenCount = (src.match(/\{ channel: chan\[/g) ?? []).length
assert(welcomeScreenCount <= 5, `the welcome screen lists ${welcomeScreenCount} channels, within Discord's limit of 5`)

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
if (failures) {
  console.log(`\x1b[31m${failures} problem(s)\x1b[0m, ${checks} checks passed. Fix config.mjs before running setup.`)
  process.exit(1)
}
console.log(`\x1b[32m${checks} checks passed.\x1b[0m Safe to run setup.`)
