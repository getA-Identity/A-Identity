/**
 * Get the server's permanent invite link, creating it only if there is not one already.
 *
 *   npm run invite
 *
 * The link goes in the product and in docs, so it has to be one link that never changes:
 * unlimited uses, no expiry. Discord's default invite expires in 7 days, which is how a
 * landing page ends up with a dead Join button and nobody notices for a month.
 *
 * Idempotent like everything else here. It looks for an existing never-expiring invite
 * first and reuses it, so running this twice does not litter the server with codes.
 *
 * A vanity URL (discord.gg/a-identity) needs Level 3 boosts. Until then this is the link.
 */
import 'dotenv/config'
import { Client, GatewayIntentBits, ChannelType } from 'discord.js'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const GUILD_ID = process.env.GUILD_ID
if (!TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_BOT_TOKEN or GUILD_ID in .env. Run `npm run whoami` to check.')
  process.exit(1)
}
/** Where the invite lands people. #welcome first: rules and the security rule. */
const LANDING = process.env.INVITE_CHANNEL ?? 'welcome'

const client = new Client({ intents: [GatewayIntentBits.Guilds] })
await client.login(TOKEN)
const guild = await client.guilds.fetch(GUILD_ID)
await guild.channels.fetch()

const existing = await guild.invites.fetch().catch(() => null)
const permanent = existing?.find((i) => i.maxAge === 0 && i.maxUses === 0)

if (permanent) {
  console.log(`\nExisting permanent invite:\n  https://discord.gg/${permanent.code}`)
  console.log(`\n  channel: #${permanent.channel?.name}   uses: ${permanent.uses}   expires: never`)
} else {
  const channel =
    guild.channels.cache.find((c) => c.name === LANDING && c.type === ChannelType.GuildText) ??
    guild.channels.cache.find((c) => c.type === ChannelType.GuildText)
  if (!channel) {
    console.error('No text channel to create an invite on. Run `npm run setup` first.')
    await client.destroy()
    process.exit(1)
  }
  const invite = await guild.invites.create(channel.id, {
    maxAge: 0, // never expires
    maxUses: 0, // unlimited
    unique: false,
    reason: 'Permanent public invite for the site and docs',
  })
  console.log(`\nCreated permanent invite:\n  https://discord.gg/${invite.code}`)
  console.log(`\n  channel: #${channel.name}   expires: never   uses: unlimited`)
}

console.log('\nKeep this in sync wherever it is published:')
console.log('  src/lib/brand.ts → SOCIALS.discord')
console.log('  README.md')

await client.destroy()
