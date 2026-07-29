/**
 * Answer three questions without opening Discord:
 *
 *   1. Is the token valid, and which bot is it?
 *   2. Which servers is the bot actually in?
 *   3. What is the GUILD_ID, ready to paste?
 *
 *   npm run whoami
 *
 * This exists because the first failure everyone hits is `DiscordAPIError[10004]:
 * Unknown Guild`, and the API says nothing useful about why. There are only three real
 * causes and this tells them apart: GUILD_ID holds the Application ID by mistake (they
 * look identical, both 18-19 digit snowflakes), the bot was never invited, or the token
 * belongs to a different application.
 *
 * It prints the bot tag and guild ids. It never prints the token.
 */
import 'dotenv/config'
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const GUILD_ID = process.env.GUILD_ID

if (!TOKEN) {
  console.error('No DISCORD_BOT_TOKEN in .env. Developer Portal → Bot → Reset Token.')
  process.exit(1)
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

try {
  await client.login(TOKEN)
} catch (e) {
  console.error(`\nThe token was rejected: ${e.message}`)
  console.error('Reset it in the Developer Portal → Bot → Reset Token and paste the new one into .env.')
  process.exit(1)
}

console.log(`\nbot:   ${client.user.tag}`)
console.log(`app id: ${client.user.id}`)

const guilds = await client.guilds.fetch()

if (!guilds.size) {
  console.log('\nThe bot is in NO server yet, which is why setup cannot find one.')
  console.log('\nInvite it, then run this again:')
  console.log(`  https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=8`)
  console.log('\n(If the invite page says the application is not public: Developer Portal →')
  console.log(' Installation → Installation Contexts must have "Guild Install" checked, and')
  console.log(' Install Link set to None for a private app.)')
  await client.destroy()
  process.exit(1)
}

console.log(`\nin ${guilds.size} server${guilds.size === 1 ? '' : 's'}:`)
for (const [id, g] of guilds) {
  const full = await client.guilds.fetch(id)
  const me = await full.members.fetchMe()
  const admin = me.permissions.has(PermissionFlagsBits.Administrator)
  const missing = [
    [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    [PermissionFlagsBits.ManageWebhooks, 'Manage Webhooks'],
  ].filter(([f]) => !me.permissions.has(f)).map(([, l]) => l)

  console.log(`\n  GUILD_ID=${id}`)
  console.log(`    name:        ${g.name}`)
  console.log(`    owner:       ${full.ownerId === client.user.id ? 'the bot (?)' : full.ownerId}`)
  console.log(`    admin:       ${admin ? 'yes' : 'no'}`)
  console.log(`    community:   ${full.features.includes('COMMUNITY') ? 'enabled' : 'not enabled (setup will enable it)'}`)
  if (missing.length) console.log(`    MISSING:     ${missing.join(', ')} — re-invite with permissions=8`)
}

// The mistake this script was written for.
if (GUILD_ID === client.user.id) {
  console.log('\n\x1b[33m!\x1b[0m GUILD_ID in .env is the APPLICATION id, not a server id.')
  console.log('  They look the same (both are snowflakes). Copy one of the GUILD_ID lines above.')
} else if (GUILD_ID && !guilds.has(GUILD_ID)) {
  console.log(`\n\x1b[33m!\x1b[0m GUILD_ID in .env (${GUILD_ID}) is not a server this bot is in.`)
  console.log('  Copy one of the GUILD_ID lines above.')
} else if (GUILD_ID) {
  console.log(`\n\x1b[32m✓\x1b[0m GUILD_ID in .env matches "${guilds.get(GUILD_ID).name}". Ready for npm run setup.`)
} else {
  console.log('\n\x1b[33m!\x1b[0m No GUILD_ID in .env yet. Copy one of the lines above.')
}

await client.destroy()
