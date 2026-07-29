/**
 * Post an announcement to #announcements, without touching Discord's UI or this code.
 *
 * Written for whoever handles comms rather than for a developer: the message lives in
 * a plain text file, the script does the embed, the pin and the publish.
 *
 *   node announce.mjs --file post.md
 *   node announce.mjs --file post.md --pin --publish --ping
 *   node announce.mjs --file post.md --dry
 *
 * The file format: first line is the title, the rest is the body. Blank line between
 * paragraphs. Discord markdown works (**bold**, `code`, [text](url), lists).
 *
 *   A-Identity now checks card spending
 *
 *   Merchant, category and per-card limits, on the same engine as trading.
 *   **ATM cash, crypto on the card and gambling are off by default.**
 *
 * Flags:
 *   --pin       pin it, and unpin the previous announcement pinned by this script
 *   --publish   push it to servers that follow the channel (announcement channels only)
 *   --ping      mention the self-assign "Announcements" role. Opt-in on purpose:
 *               a ping nobody asked for is how a server gets muted.
 *   --dry       print what would happen and exit
 *
 * One rule worth keeping, and the reason it is written here rather than in a doc: do
 * not put user counts, decision counts or protected-value figures in an announcement
 * unless you just read them from the live endpoint. The public numbers are currently
 * zero and the product says so; a number that cannot be reproduced is the one thing
 * that would cost us more trust than it buys.
 *   https://a-identity-backend.onrender.com/api/traction
 */
import 'dotenv/config'
import { Client, GatewayIntentBits, ChannelType } from 'discord.js'
import { readFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const FILE = valueOf('file')
const CHANNEL_NAME = valueOf('channel') ?? 'announcements'
const DRY = flag('dry')
const ACCENT = 0x7342e2

if (!FILE) {
  console.error('Usage: node announce.mjs --file post.md [--pin] [--publish] [--ping] [--dry]')
  process.exit(1)
}

const raw = await readFile(FILE, 'utf8')
const lines = raw.replace(/\r\n/g, '\n').split('\n')
const title = (lines.shift() ?? '').trim()
const body = lines.join('\n').trim()

if (!title) {
  console.error(`${FILE}: the first line must be the title.`)
  process.exit(1)
}
// Discord truncates silently, which is worse than refusing.
if (title.length > 256) {
  console.error(`Title is ${title.length} characters; Discord allows 256.`)
  process.exit(1)
}
if (body.length > 4096) {
  console.error(`Body is ${body.length} characters; Discord allows 4096. Split it into two posts.`)
  process.exit(1)
}

const embed = {
  color: ACCENT,
  title,
  description: body || undefined,
  timestamp: new Date().toISOString(),
  footer: { text: 'aid-announce' },
}

console.log(`\n\x1b[1m${title}\x1b[0m`)
console.log(body ? `${body}\n` : '')
console.log(
  `  → #${CHANNEL_NAME}   pin: ${flag('pin') ? 'yes' : 'no'}   publish: ${flag('publish') ? 'yes' : 'no'}   ping: ${flag('ping') ? 'yes' : 'no'}`,
)
// The env check sits after the preview on purpose: writing and proofreading a post
// should not require holding a bot token.
if (DRY) {
  console.log('\n  [dry] nothing was posted.')
  process.exit(0)
}

const TOKEN = process.env.DISCORD_BOT_TOKEN
const GUILD_ID = process.env.GUILD_ID
if (!TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_BOT_TOKEN or GUILD_ID. Copy .env.sample to .env and fill it in.')
  process.exit(1)
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] })
await client.login(TOKEN)
const guild = await client.guilds.fetch(GUILD_ID)
await guild.channels.fetch()
await guild.roles.fetch()

const channel = guild.channels.cache.find(
  (c) => c.name === CHANNEL_NAME && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement),
)
if (!channel) {
  console.error(`No text or announcement channel named #${CHANNEL_NAME}. Run setup.mjs first.`)
  await client.destroy()
  process.exit(1)
}

let content
if (flag('ping')) {
  const pingRole = guild.roles.cache.find((r) => r.name === 'Announcements')
  if (pingRole) content = `<@&${pingRole.id}>`
  else console.warn('  ! no "Announcements" role found, posting without a ping')
}

const msg = await channel.send({ content, embeds: [embed], allowedMentions: { roles: content ? [content.slice(4, -1)] : [] } })
console.log(`  ✓ posted: ${msg.url}`)

if (flag('pin')) {
  try {
    // Keep exactly one announcement pinned. A channel with fifteen pins has none.
    // fetchPinned is deprecated in v14 and gone in v15; fetchPins returns a different shape.
    const pins =
      typeof channel.messages.fetchPins === 'function'
        ? (await channel.messages.fetchPins()).items.map((i) => i.message)
        : [...(await channel.messages.fetchPinned()).values()]
    for (const old of pins) {
      if (old.id !== msg.id && old.embeds?.[0]?.footer?.text === 'aid-announce') {
        await old.unpin('superseded by a newer announcement')
      }
    }
    await msg.pin('announcement')
    console.log('  ✓ pinned (previous announcement unpinned)')
  } catch (e) {
    console.warn(`  ! pin failed: ${e.message}`)
  }
}

if (flag('publish')) {
  if (channel.type === ChannelType.GuildAnnouncement) {
    try {
      await msg.crosspost()
      console.log('  ✓ published to following servers')
    } catch (e) {
      console.warn(`  ! publish failed: ${e.message}`)
    }
  } else {
    console.warn('  ! --publish only works in an announcement channel')
  }
}

await client.destroy()
