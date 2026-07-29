/**
 * A-Identity Discord — one-command server setup.
 *
 * Idempotent by design: every role, category, channel, pin, AutoMod rule and
 * onboarding prompt is looked up BY NAME and only created when missing, so you can
 * re-run this as often as you like without duplicating anything. That matters more
 * than it sounds: a half-configured server is the normal failure mode, and the fix
 * should always be "run it again".
 *
 * Usage:
 *   cp .env.sample .env      # fill DISCORD_BOT_TOKEN + GUILD_ID
 *   npm run setup:dry        # preview, writes nothing
 *   npm run setup
 *
 * The bot needs to be in the server already, with Administrator (or at minimum:
 * Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Manage Messages,
 * Manage Guild Expressions, Moderate Members, View Channels, Send Messages). See
 * README.md for the invite URL.
 *
 * What this script CANNOT do, because Discord does not expose it to bots. These are
 * in README.md as a short manual checklist, and the script reminds you at the end:
 *   - Raid protection and the ML "suspicious links" filter (Server Settings only)
 *   - Requiring 2FA for moderators (owner-only endpoint)
 *   - The server banner (needs Level 2 boosts)
 *   - Vanity invite
 */
import 'dotenv/config'
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  GuildVerificationLevel,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildOnboardingPromptType,
  GuildOnboardingMode,
  AutoModerationRuleTriggerType,
  AutoModerationRuleEventType,
  AutoModerationActionType,
  AutoModerationRuleKeywordPresetType,
  ForumLayoutType,
} from 'discord.js'
import {
  BRAND,
  LINKS,
  PITCH,
  ROLES,
  TREE,
  SCAM_PHRASES,
  IMPERSONATION_PATTERNS,
  welcomeEmbed,
  announcementEmbed,
  roadmapEmbed,
  generalEmbed,
} from './config.mjs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRY = process.env.DRY_RUN === '1'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = (...a) => console.log(...a)
const step = (m) => log(`\n\x1b[1m${m}\x1b[0m`)
const ok = (m) => log(`  \x1b[32m✓\x1b[0m ${m}`)
const skip = (m) => log(`  \x1b[90m•\x1b[0m ${m} (already there)`)
const warn = (m) => log(`  \x1b[33m!\x1b[0m ${m}`)

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`\x1b[31mMissing ${name}.\x1b[0m Copy .env.sample to .env and fill it in.`)
    process.exit(1)
  }
  return v
}

const TOKEN = requireEnv('DISCORD_BOT_TOKEN')
const GUILD_ID = requireEnv('GUILD_ID')
// Ledger and CommunityOne both recommend the highest level for finance-adjacent
// servers, which this is. It is not the default here because phone verification
// turns real people away, and an empty server protects nobody. Flip it when the
// server is big enough to be worth attacking: VERIFICATION=highest
const VERIFICATION = (process.env.VERIFICATION ?? 'high').toLowerCase()

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

async function main() {
  await client.login(TOKEN)
  const guild = await client.guilds.fetch(GUILD_ID)
  await guild.channels.fetch()
  await guild.roles.fetch()

  const me = await guild.members.fetchMe()
  step(`A-Identity Discord setup — ${guild.name}`)
  log(
    `  bot: ${client.user.tag}   admin: ${me.permissions.has(PermissionFlagsBits.Administrator) ? 'yes' : 'no'}` +
      `   ${DRY ? '\x1b[33m[DRY RUN — nothing will be written]\x1b[0m' : ''}`,
  )
  for (const [flag, label] of [
    [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    [PermissionFlagsBits.ManageGuild, 'Manage Server'],
  ]) {
    if (!me.permissions.has(flag)) warn(`bot is missing ${label} — re-invite it with the URL in README.md`)
  }

  const everyone = guild.roles.everyone

  // 1) Identity ------------------------------------------------------------
  step('Server identity')
  try {
    if (!guild.icon) {
      const icon = await readFile(join(HERE, 'assets', 'icon.png'))
      if (!DRY) await guild.setIcon(icon, 'A-Identity brand')
      ok('set server icon from assets/icon.png')
    } else {
      skip('server icon')
    }
  } catch (e) {
    warn(`could not set icon: ${e.message}`)
  }

  // 2) Roles ---------------------------------------------------------------
  step('Roles')
  const role = {}
  for (const r of ROLES) {
    const existing = guild.roles.cache.find((x) => x.name === r.name)
    if (existing) {
      role[r.key] = existing
      skip(`role ${r.name}`)
      continue
    }
    if (DRY) {
      ok(`would create role ${r.name}${r.admin ? ' (admin)' : ''}`)
      role[r.key] = { id: `dry:${r.key}` }
      continue
    }
    role[r.key] = await guild.roles.create({
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.admin ? [PermissionFlagsBits.Administrator] : (r.permissions ?? []),
      reason: 'A-Identity setup',
    })
    ok(`created role ${r.name}${r.admin ? ' (admin)' : r.permissions ? ' (scoped moderation perms)' : ''}`)
  }
  const real = (key) => role[key]?.id && !String(role[key].id).startsWith('dry:')
  const staffIds = ['core', 'mod'].filter(real).map((k) => role[k].id)

  // 3) Categories + channels ----------------------------------------------
  // Forum and announcement channels need Community, which is enabled in step 4,
  // so those are created in a second pass afterwards. Everything else lands now.
  step('Channels')
  const chan = {}
  const deferred = []
  for (const group of TREE) {
    const groupPrivate = group.private ?? false
    let cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === group.category)
    const catOverwrites = groupPrivate
      ? [
          { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          ...staffIds.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
        ]
      : []
    if (!cat) {
      if (DRY) {
        ok(`would create category ${group.category}${groupPrivate ? ' (staff only)' : ''}`)
      } else {
        cat = await guild.channels.create({
          name: group.category,
          type: ChannelType.GuildCategory,
          permissionOverwrites: catOverwrites.length ? catOverwrites : undefined,
          reason: 'A-Identity setup',
        })
        ok(`created category ${group.category}${groupPrivate ? ' (staff only)' : ''}`)
      }
    } else {
      if (!DRY && catOverwrites.length) {
        try { await cat.edit({ permissionOverwrites: catOverwrites }) } catch { /* keep going */ }
      }
      skip(`category ${group.category}`)
    }

    for (const ch of group.channels) {
      const readOnly = ch.ro ?? group.ro ?? false
      const isPrivate = ch.private ?? groupPrivate
      if (ch.type === 'forum' || ch.type === 'news') {
        deferred.push({ ch, cat, readOnly, isPrivate })
        continue
      }
      await ensureChannel({ guild, everyone, staffIds, chan, ch, cat, readOnly, isPrivate })
    }
  }

  // 4) Community ----------------------------------------------------------
  step('Community features')
  let community = guild.features.includes('COMMUNITY')
  if (community) {
    skip('Community')
  } else if (DRY) {
    ok('would enable Community (required for the welcome screen, onboarding and the forum)')
  } else {
    try {
      await guild.edit({
        features: [...guild.features, 'COMMUNITY'],
        rulesChannel: chan['welcome']?.id,
        publicUpdatesChannel: chan['mod-log']?.id ?? chan['announcements']?.id,
        verificationLevel:
          VERIFICATION === 'highest' ? GuildVerificationLevel.VeryHigh : GuildVerificationLevel.High,
        defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
        explicitContentFilter: GuildExplicitContentFilter.AllMembers,
        description: `${PITCH} We never DM you first and we never ask for keys.`,
        reason: 'A-Identity setup',
      })
      community = true
      ok(`enabled Community (verification: ${VERIFICATION}, content filter: all members)`)
    } catch (e) {
      warn(`could not enable Community automatically: ${e.message}`)
      warn('Enable it once in Server Settings → Enable Community (rules = #welcome), then re-run.')
    }
  }

  // 4b) The channels that needed Community --------------------------------
  if (deferred.length) {
    for (const d of deferred) {
      if (!community && !DRY) {
        warn(`#${d.ch.name} needs Community — re-run once Community is on`)
        continue
      }
      await ensureChannel({ guild, everyone, staffIds, chan, ...d, community })
    }
  }

  // 5) Pinned content -----------------------------------------------------
  step('Pinned content')
  await postOnce(chan['welcome'], welcomeEmbed)
  await postOnce(chan['announcements'], announcementEmbed)
  await postOnce(chan['roadmap'], roadmapEmbed)
  await postOnce(chan['general'], generalEmbed)

  // 6) AutoMod ------------------------------------------------------------
  step('AutoMod')
  await setupAutoMod({ guild, chan, role, staffIds, real })

  // 7) Welcome screen + onboarding ----------------------------------------
  if (community || DRY) {
    step('Welcome screen and onboarding')
    try {
      if (!DRY) {
        await guild.editWelcomeScreen({
          enabled: true,
          description: 'Verified identity and bounded authority for AI agents.',
          welcomeChannels: [
            { channel: chan['welcome']?.id, description: 'Rules and the security rule', emoji: '🔒' },
            { channel: chan['general']?.id, description: 'Say hi and talk shop', emoji: '💬' },
            { channel: chan['guardrails']?.id, description: 'How bounded authority works', emoji: '🛡️' },
            { channel: chan['help']?.id, description: 'Get unstuck', emoji: '🆘' },
          ].filter((c) => c.channel),
        })
      }
      ok('welcome screen')
    } catch (e) {
      warn(`welcome screen: ${e.message}`)
    }

    try {
      if (!DRY) await setupOnboarding(guild, chan, role, real)
      ok('onboarding prompts (who you are / what you are into)')
    } catch (e) {
      warn(`onboarding: ${e.message}`)
      warn('If this failed, open Server Settings → Onboarding once, then re-run.')
    }
  }

  // 8) What a bot cannot do ----------------------------------------------
  step('Left for you, because Discord does not let a bot do it')
  log('  1. Server Settings → Safety Setup: turn on \x1b[1mRaid Protection\x1b[0m and the')
  log('     \x1b[1msuspicious links\x1b[0m filter. Neither is exposed to bots, and the link filter is')
  log('     the one control that catches drainer domains we have never seen before.')
  log('  2. Server Settings → Moderation: \x1b[1mrequire 2FA for moderators\x1b[0m (owner-only endpoint).')
  log('  3. Paste the printed webhook URLs where they belong (GitHub, CI). See README.md.')
  log('  4. Server banner needs Level 2 boosts — upload public/og-image.png by hand once boosted.')

  step('Done')
  log(`  ${DRY ? 'Dry run complete, nothing was written.' : 'Server configured.'}  ${LINKS.site}`)
  await client.destroy()
}

/**
 * Create or update one channel. Read-only means @everyone cannot send, but staff
 * can; private means @everyone cannot even see it.
 */
async function ensureChannel({ guild, everyone, staffIds, chan, ch, cat, readOnly, isPrivate, community }) {
  const type =
    ch.type === 'voice' ? ChannelType.GuildVoice
    : ch.type === 'forum' ? ChannelType.GuildForum
    : ChannelType.GuildText

  const overwrites = []
  if (isPrivate) {
    overwrites.push({ id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] })
    for (const id of staffIds) overwrites.push({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] })
  } else if (readOnly) {
    overwrites.push({
      id: everyone.id,
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        // A read-only channel that still accepts attachments is a place to post a
        // fake-announcement screenshot, which is the current dominant scam format.
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
      allow: [PermissionFlagsBits.AddReactions],
    })
    for (const id of staffIds) {
      overwrites.push({ id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] })
    }
  }

  const existing = guild.channels.cache.find((c) => c.name === ch.name && c.type !== ChannelType.GuildCategory)
  if (existing) {
    chan[ch.name] = existing
    if (!DRY) {
      try {
        await existing.edit({
          parent: cat?.id,
          ...(existing.type === ChannelType.GuildVoice ? {} : { topic: ch.topic }),
          ...(overwrites.length ? { permissionOverwrites: overwrites } : {}),
        })
      } catch { /* a permission we cannot set is not worth aborting the run for */ }
      // A text channel that should be an announcement channel gets converted once
      // Community is on. Discord allows text <-> announcement, nothing else.
      if (ch.type === 'news' && community && existing.type === ChannelType.GuildText) {
        try {
          await existing.edit({ type: ChannelType.GuildAnnouncement, reason: 'A-Identity setup' })
          ok(`#${ch.name} → announcement channel`)
        } catch (e) { warn(`convert #${ch.name}: ${e.message}`) }
      }
    }
    skip(`#${ch.name}`)
    if (!DRY && ch.webhook) await ensureWebhook(existing, ch.webhook)
    return
  }

  if (DRY) {
    ok(`would create #${ch.name}${isPrivate ? ' (staff only)' : readOnly ? ' (read-only)' : ''}`)
    return
  }

  const created = await guild.channels.create({
    name: ch.name,
    type: ch.type === 'news' ? ChannelType.GuildText : type,
    parent: cat?.id,
    ...(type === ChannelType.GuildVoice ? {} : { topic: ch.topic }),
    ...(type === ChannelType.GuildForum && ch.tags
      ? {
          availableTags: ch.tags.map((name) => ({ name, moderated: name === 'answered' })),
          defaultForumLayout: ForumLayoutType.ListView,
          defaultReactionEmoji: { name: '👀', id: null },
        }
      : {}),
    ...(overwrites.length ? { permissionOverwrites: overwrites } : {}),
    reason: 'A-Identity setup',
  })
  chan[ch.name] = created
  ok(`created #${ch.name}${isPrivate ? ' (staff only)' : readOnly ? ' (read-only)' : ''}`)

  if (ch.type === 'news' && community) {
    try {
      await created.edit({ type: ChannelType.GuildAnnouncement, reason: 'A-Identity setup' })
      ok(`#${ch.name} → announcement channel`)
    } catch (e) { warn(`convert #${ch.name}: ${e.message}`) }
  }

  if (ch.webhook) await ensureWebhook(created, ch.webhook)
}

/**
 * Make sure a channel has its webhook, and print the URL whether it was just created or
 * already existed.
 *
 * The second half is the point. This used to run only when the channel was created, so a
 * re-run said nothing and there was no way to recover a URL you had scrolled past. A
 * webhook URL is not a secret you can look up later from here, it is a credential Discord
 * shows on creation, so a script that prints it once and never again is a script that
 * loses it. Discord does return the token to a bot with Manage Webhooks, so a re-run can
 * reprint it, and now does.
 */
async function ensureWebhook(channel, name) {
  try {
    const hooks = await channel.fetchWebhooks()
    const existing = hooks.find((h) => h.name === name)
    if (existing) {
      if (existing.url) ok(`webhook for #${channel.name} (existing):\n      ${existing.url}`)
      else skip(`webhook for #${channel.name} (exists, but Discord did not return its token)`)
      return
    }
    const wh = await channel.createWebhook({ name, reason: 'A-Identity setup' })
    ok(`webhook for #${channel.name} (a write credential, keep it somewhere safe):\n      ${wh.url}`)
  } catch (e) {
    warn(`webhook for #${channel.name}: ${e.message}`)
  }
}

/**
 * Pinned messages, across the discord.js versions that matter. `fetchPinned` is deprecated
 * in v14 and gone in v15; `fetchPins` returns `{ items: [{ message }] }` rather than a
 * collection. Normalizing here keeps the deprecation warning out of every run.
 */
async function pinnedMessages(channel) {
  if (typeof channel.messages.fetchPins === 'function') {
    const { items } = await channel.messages.fetchPins()
    return items.map((i) => i.message)
  }
  return [...(await channel.messages.fetchPinned()).values()]
}

/** Post and pin one embed, unless a pin with the same footer marker already exists. */
async function postOnce(channel, embed) {
  if (!channel) { warn(`skipped a pin, channel missing`); return }
  if (DRY) { ok(`would post and pin "${embed.title}" in #${channel.name}`); return }
  try {
    const pins = await pinnedMessages(channel)
    if (pins.some((m) => m.embeds?.[0]?.footer?.text === embed.footer?.text)) {
      skip(`"${embed.title}" in #${channel.name}`)
      return
    }
    const msg = await channel.send({ embeds: [embed] })
    await msg.pin('A-Identity setup')
    ok(`posted and pinned "${embed.title}" in #${channel.name}`)
  } catch (e) { warn(`pin "${embed.title}": ${e.message}`) }
}

/**
 * Five AutoMod rules. Discord allows one each of Spam, KeywordPreset, MentionSpam
 * and MemberProfile, plus several Keyword rules, so this is close to the ceiling of
 * what the API offers.
 */
async function setupAutoMod({ guild, chan, role, staffIds, real }) {
  let existing
  try {
    existing = await guild.autoModerationRules.fetch()
  } catch (e) {
    warn(`cannot read AutoMod rules: ${e.message}`)
    return
  }
  const alertChannel = chan['mod-log']?.id
  const exemptRoles = staffIds
  const block = (customMessage) => ({
    type: AutoModerationActionType.BlockMessage,
    metadata: { customMessage },
  })
  const alert = alertChannel ? [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: alertChannel } }] : []

  const rules = [
    {
      name: 'A-Identity · scam and drainer phrases',
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { keywordFilter: SCAM_PHRASES },
      actions: [
        block('Blocked: that phrase matches a known scam pattern. Nobody here will ever DM you or ask for keys.'),
        ...alert,
      ],
    },
    {
      name: 'A-Identity · mention spam',
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: 5, mentionRaidProtectionEnabled: true },
      actions: [block('Too many mentions in one message.'), ...alert],
    },
    {
      name: 'A-Identity · spam',
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Spam,
      triggerMetadata: {},
      actions: [block('Blocked as spam.')],
    },
    {
      name: 'A-Identity · commonly flagged words',
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.KeywordPreset,
      triggerMetadata: {
        presets: [
          AutoModerationRuleKeywordPresetType.Profanity,
          AutoModerationRuleKeywordPresetType.SexualContent,
          AutoModerationRuleKeywordPresetType.Slurs,
        ],
        allowList: [],
      },
      actions: [block('Blocked by the server word filter.')],
    },
    {
      // MemberProfile rules only accept BlockMemberInteraction, and they run on
      // MemberUpdate rather than MessageSend. An impersonator is stopped at the
      // profile, before they can talk to anyone.
      name: 'A-Identity · impersonation in names',
      eventType: AutoModerationRuleEventType.MemberUpdate,
      triggerType: AutoModerationRuleTriggerType.MemberProfile,
      triggerMetadata: { keywordFilter: IMPERSONATION_PATTERNS },
      actions: [{ type: AutoModerationActionType.BlockMemberInteraction }],
    },
  ]

  for (const r of rules) {
    if (existing.find((x) => x.name === r.name)) { skip(`AutoMod "${r.name}"`); continue }
    if (DRY) { ok(`would create AutoMod "${r.name}"`); continue }
    try {
      await guild.autoModerationRules.create({ ...r, enabled: true, exemptRoles, reason: 'A-Identity setup' })
      ok(`AutoMod "${r.name}"`)
    } catch (e) {
      warn(`AutoMod "${r.name}": ${e.message}`)
    }
  }
  if (!alertChannel) warn('no #mod-log channel, so AutoMod alerts have nowhere to go')
}

/**
 * Two onboarding prompts. The first is required and sorts people into a segment,
 * which is what makes the server useful later: an update for agent owners is not
 * the same as an update for integrators.
 */
async function setupOnboarding(guild, chan, role, real) {
  const roles = (...keys) => keys.filter(real).map((k) => role[k].id)
  const chans = (...names) => names.map((n) => chan[n]?.id).filter(Boolean)

  await guild.editOnboarding({
    enabled: true,
    mode: GuildOnboardingMode.OnboardingDefault,
    defaultChannels: chans('welcome', 'announcements', 'roadmap', 'general', 'introductions', 'help'),
    prompts: [
      {
        title: 'What brings you here?',
        singleSelect: true,
        required: true,
        inOnboarding: true,
        type: GuildOnboardingPromptType.MultipleChoice,
        options: [
          {
            title: 'Integrating A-Identity',
            description: 'You are wiring the guardrails or the MCP tools into something',
            emoji: { name: '🛠️' },
            roles: roles('builder'),
            channels: chans('dev', 'guardrails', 'mcp-and-x402'),
          },
          {
            title: 'I run an agent',
            description: 'You want limits on an agent that touches your money',
            emoji: { name: '🛡️' },
            roles: roles('owner_seg'),
            channels: chans('guardrails', 'help', 'general'),
          },
          {
            title: 'Contributing',
            description: 'Pull requests, issues, the spec',
            emoji: { name: '⚡' },
            roles: roles('contributor'),
            channels: chans('dev', 'feedback', 'git-feed'),
          },
          {
            title: 'Just looking',
            description: 'Here to follow along',
            emoji: { name: '🌱' },
            roles: [],
            channels: chans('general', 'roadmap', 'showcase'),
          },
        ],
      },
      {
        title: 'What are you into?',
        singleSelect: false,
        required: false,
        inOnboarding: true,
        type: GuildOnboardingPromptType.MultipleChoice,
        options: [
          { title: 'Guardrails', description: 'Bounded authority, policy, audit', emoji: { name: '🛡️' }, roles: roles('t_guardrails'), channels: chans('guardrails') },
          { title: 'Arc / Circle', description: 'USDC, CCTP, Gateway, Nanopayments', emoji: { name: '⭕' }, roles: roles('t_arc'), channels: chans('arc-and-circle') },
          { title: 'OKX / X Layer', description: 'Agent services and settlements', emoji: { name: '🅾️' }, roles: roles('t_okx'), channels: chans('okx-x-layer') },
          { title: 'MCP / x402', description: 'Tools and pay-per-call', emoji: { name: '🔌' }, roles: roles('t_mcp'), channels: chans('mcp-and-x402') },
          { title: 'Stellar', description: 'The multichain roadmap', emoji: { name: '✳️' }, roles: roles('t_stellar'), channels: chans('general') },
          { title: 'Ping me for announcements', description: 'Get mentioned on releases', emoji: { name: '📣' }, roles: roles('t_news'), channels: chans('announcements') },
        ],
      },
    ],
    reason: 'A-Identity setup',
  })
}

main().catch((e) => {
  // "Unknown Guild" is the first error nearly everyone hits, and the API text explains
  // nothing. There are only three causes, so name them instead of printing a stack.
  if (e?.code === 10004) {
    console.error('\n\x1b[31mDiscord does not recognize GUILD_ID.\x1b[0m One of three things:')
    console.error('  1. GUILD_ID holds the APPLICATION id by mistake. Both are 18-19 digit')
    console.error('     snowflakes and look identical, so this is the usual one.')
    console.error('  2. The bot was never invited to the server.')
    console.error('  3. The token belongs to a different application than the invite did.')
    console.error('\nRun \x1b[1mnpm run whoami\x1b[0m — it prints the bot, every server it is in, and the')
    console.error('GUILD_ID line to paste.\n')
    process.exit(1)
  }
  if (e?.code === 50001 || e?.code === 50013) {
    console.error('\n\x1b[31mMissing access or permissions.\x1b[0m Re-invite the bot with permissions=8,')
    console.error('or check `npm run whoami` for which permission it lacks.\n')
    process.exit(1)
  }
  console.error('\x1b[31mSetup failed:\x1b[0m', e)
  process.exit(1)
})
