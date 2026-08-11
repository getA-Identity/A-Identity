/**
 * The A-Identity Discord server, as data.
 *
 * Split out from setup.mjs on purpose, and for the same reason the chain registry is
 * split from the code that uses it: a description of the server should be readable and
 * checkable without running anything. `validate.mjs` asserts this file against Discord's
 * documented limits and against setup.mjs's own channel references, so a typo fails
 * locally instead of halfway through a live run.
 *
 * Change the server by changing this file, then re-run setup.
 */
import { PermissionFlagsBits } from 'discord.js'

// ---------------------------------------------------------------------------
// Brand. Taken from src/lib/brand.ts and src/index.css so the server matches the
// product rather than approximating it.
// ---------------------------------------------------------------------------
export const BRAND = {
  accent: 0x7342e2, // --color-accent, also the ERC-8004 protocol color
  x402: 0x2775ca,
  mcp: 0x1aab7a,
  ink: 0x192837,
  muted: 0x8a93a0,
  amber: 0xd97706,
  green: 0x1aab7a,
}

export const LINKS = {
  site: 'https://a-identity.xyz',
  app: 'https://a-identity.xyz/app',
  explorer: 'https://a-identity.xyz/explorer',
  docs: 'https://a-identity.mintlify.site',
  repo: 'https://github.com/getA-Identity/A-Identity',
  skills: 'https://github.com/getA-Identity/a-identity-skills',
  status: 'https://a-identity-backend.onrender.com/api/guardrail-status',
  proof: 'https://a-identity-asp.onrender.com/proof',
}

export const PITCH =
  'Verified identity and bounded authority for AI agents. An agent asks before it ' +
  'acts, and gets allow, ask-a-human, or no, with a reason and a record.'

// ---------------------------------------------------------------------------
// Roles, created top-first so the hierarchy reads the way it should.
//
// Two deliberate choices:
//
// 1. Moderator is NOT an admin. It gets exactly the permissions moderation needs.
//    Administrator on a moderation role means one compromised moderator account is
//    a compromised server, which is the single most common way project Discords are
//    taken over.
// 2. No role is called "Verified". A-Identity's product has KYA verification, and a
//    Discord role with that name would read as a product-level claim about an agent.
//    "Builder" and "Agent Owner" say what they mean and claim nothing.
// ---------------------------------------------------------------------------
export const MOD_PERMISSIONS = [
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.ViewAuditLog,
]

export const ROLES = [
  { key: 'core', name: 'Core Team', color: BRAND.accent, hoist: true, mentionable: false, admin: true },
  { key: 'mod', name: 'Moderator', color: BRAND.amber, hoist: true, mentionable: true, permissions: MOD_PERMISSIONS },
  { key: 'partner', name: 'Partner', color: BRAND.x402, hoist: true, mentionable: false },
  { key: 'contributor', name: 'Contributor', color: BRAND.mcp, hoist: true, mentionable: true },
  { key: 'builder', name: 'Builder', color: BRAND.green, hoist: true, mentionable: true },
  { key: 'owner_seg', name: 'Agent Owner', color: 0x6f7bd6, hoist: true, mentionable: true },
  // Self-assign topic roles, picked during onboarding. Not hoisted: they are
  // interests, not standing, and a sidebar full of groups reads as noise.
  { key: 't_guardrails', name: 'Guardrails', color: BRAND.muted, hoist: false, mentionable: true },
  { key: 't_arc', name: 'Arc / Circle', color: BRAND.muted, hoist: false, mentionable: true },
  { key: 't_okx', name: 'OKX / X Layer', color: BRAND.muted, hoist: false, mentionable: true },
  { key: 't_mcp', name: 'MCP / x402', color: BRAND.muted, hoist: false, mentionable: true },
  { key: 't_stellar', name: 'Stellar', color: BRAND.muted, hoist: false, mentionable: true },
  { key: 't_news', name: 'Announcements', color: BRAND.muted, hoist: false, mentionable: true },
]

// ---------------------------------------------------------------------------
// Channel tree.
//   ro: true       read-only for @everyone (Core Team and Moderator can post)
//   private: true  hidden from @everyone entirely (staff only)
//   type           'voice' | 'forum' | 'news' (news and forum need Community, which
//                  this script enables first, so both work on the first run)
//   webhook        creates a webhook and prints its URL once
// ---------------------------------------------------------------------------
export const TREE = [
  {
    category: 'START HERE',
    ro: true,
    channels: [
      { name: 'welcome', topic: 'What A-Identity is, the rules, and the one security rule that matters: we never DM you first.', ro: true },
      { name: 'announcements', topic: 'Official updates. Ships, releases, milestones.', ro: true, type: 'news' },
      { name: 'roadmap', topic: 'What is shipped and what is next. Updated each phase.', ro: true },
    ],
  },
  {
    category: 'COMMUNITY',
    channels: [
      { name: 'general', topic: 'Main channel. Agentic finance, verified identity, bounded authority.' },
      { name: 'introductions', topic: 'New here? Say hi. Who you are and what you build or run.' },
      { name: 'showcase', topic: 'Built something with A-Identity, or on x402 / MCP / ERC-8004? Show it.' },
      { name: 'off-topic', topic: 'Everything that is not A-Identity.' },
    ],
  },
  {
    category: 'BUILD',
    channels: [
      { name: 'dev', topic: 'Integrating A-Identity. SDK, MCP server, REST, the console.' },
      { name: 'guardrails', topic: 'The policy engine: caps, approval thresholds, surfaces, the audit trail. Bounded authority talk lives here.' },
      { name: 'mcp-and-x402', topic: 'Model Context Protocol tools and x402 pay-per-call. Pricing, settlement, agent-to-agent.' },
      { name: 'arc-and-circle', topic: 'Circle Arc, USDC, CCTP, Gateway, Nanopayments, Paymaster.' },
      { name: 'okx-x-layer', topic: 'OKX.AI agent services and X Layer. Registration, paid tools, settlements.' },
      { name: 'feedback', topic: 'Ideas and rough edges. For tracked work, open a GitHub issue.' },
    ],
  },
  {
    category: 'SUPPORT',
    channels: [
      {
        name: 'help',
        type: 'forum',
        topic: 'Ask here. One thread per question, with what you ran, what you expected, and what happened. Nobody from the team will ever DM you.',
        tags: ['guardrails', 'setup', 'mcp / x402', 'arc / circle', 'okx', 'bug', 'answered'],
      },
    ],
  },
  {
    category: 'FEEDS',
    ro: true,
    channels: [
      { name: 'git-feed', topic: 'Commits, pull requests and releases.', ro: true, webhook: 'A-Identity · GitHub' },
      { name: 'status', topic: 'Hourly guardrail self-check, posted by CI. Real output, not a badge.', ro: true, webhook: 'A-Identity · Canary' },
    ],
  },
  {
    category: 'STAFF',
    private: true,
    channels: [
      { name: 'mod-log', topic: 'AutoMod alerts and moderation notes. Staff only.', private: true },
      { name: 'staff-chat', topic: 'Team coordination. Staff only.', private: true },
    ],
  },
  {
    category: 'VOICE',
    channels: [
      { name: 'Community', type: 'voice' },
      { name: 'Office Hours', type: 'voice' },
    ],
  },
]

// ---------------------------------------------------------------------------
// AutoMod.
//
// The scam-phrase list below is the part worth reading. Every entry is a phrase
// that appears in wallet-drainer and impersonation attempts and essentially never
// in a real conversation about this product. The team is exempt so nobody gets
// blocked while explaining an attack in #guardrails.
//
// Known limit, stated rather than papered over: AutoMod reads TEXT. The dominant
// Discord scam vector is now an IMAGE, a screenshot of a fake announcement or a QR
// code, and none of these rules see it. The controls that actually help there are
// the pinned "we never DM you first" rule, the verification level, and Discord's
// own raid protection, which is a dashboard toggle this script cannot set.
// ---------------------------------------------------------------------------
export const SCAM_PHRASES = [
  'seed phrase', 'seedphrase', 'recovery phrase', 'private key', 'secret key',
  'connect your wallet', 'validate your wallet', 'verify your wallet', 'sync your wallet',
  'wallet validation', 'revoke and reconnect',
  'claim your airdrop', 'claim airdrop', 'free mint', 'exclusive mint', 'whitelist spot',
  'dm me', 'dm for help', 'message me privately', 'open a ticket with me',
  'first 100 users', 'double your', 'guaranteed returns',
  'metamask support', 'wallet support agent',
]

/** Usernames that pretend to be us or to be staff. Blocked from interacting at all. */
export const IMPERSONATION_PATTERNS = [
  '*a-identity*', '*aidentity*', '*a identity*',
  '*admin*', '*moderator*', '*support*', '*helpdesk*', '*official*', '*team*',
]

// ---------------------------------------------------------------------------
// Pinned content. Each embed carries a footer marker so a re-run recognizes its
// own pin and does not post a second copy.
// ---------------------------------------------------------------------------
export const welcomeEmbed = {
  color: BRAND.accent,
  title: 'Welcome to A-Identity',
  description:
    `${PITCH}\n\n` +
    'AI agents can now place real trades and spend real money on their owner\'s behalf. ' +
    'We build the part that was missing: **an agent whose identity is verified and whose ' +
    'authority is bounded.**',
  fields: [
    {
      name: '🔒 Read this first, it is the only rule that can cost you money',
      value:
        '**Nobody from this team will ever DM you first.**\n' +
        'We will never ask for a seed phrase, a private key or a password. We will never ask you to ' +
        'connect, validate or sync a wallet through a link. There is no airdrop, no mint and no giveaway.\n' +
        'A-Identity itself never holds your keys. Anyone claiming otherwise is not us.\n' +
        '**Saw one?** Mention a **@Moderator** in any public channel, or right-click the message → Report. ' +
        'Do not engage and do not click.',
    },
    {
      name: 'Guidelines',
      value:
        '**1.** Be decent. No harassment, hate or spam.\n' +
        '**2.** Stay on topic per channel. Tangents go to #off-topic.\n' +
        '**3.** No shilling, no unsolicited DMs, no price talk.\n' +
        '**4.** Ask in the #help forum, not in DMs, and include what you ran and what happened.\n' +
        '**5.** English in shared channels so everyone can follow.',
    },
    {
      name: 'Start here',
      value:
        '• Pick your interests in **Channels & Roles**\n' +
        '• Say hi in #introductions\n' +
        `• [Docs](${LINKS.docs}) · [Live app](${LINKS.app}) · [GitHub](${LINKS.repo})`,
    },
  ],
  footer: { text: 'aid-setup:welcome' },
}

export const announcementEmbed = {
  color: BRAND.accent,
  title: 'A-Identity is live',
  description:
    `${PITCH}\n\n` +
    'An agent that can move money needs two things nobody had shipped together: a verifiable ' +
    'identity, and limits it cannot talk its way past.',
  fields: [
    {
      name: 'What is live',
      value:
        '• **Guardrails** on trading and card spending. Per-action and daily caps, human-approval ' +
        'thresholds, symbol rules, merchant and category rules, per-card ceilings.\n' +
        '• **No margin, ever.** Not a default, not a setting. Borrowed money means an agent can lose ' +
        'more than the account holds.\n' +
        '• **A decision trail.** Every verdict recorded with its reason. A refusal cannot be overwritten, ' +
        'and attempts to overwrite one are counted.\n' +
        '• **Verified identity** on ERC-8004, and **pay-per-call** tools over x402.',
    },
    {
      name: 'See it yourself',
      value:
        `• [Live engine self-check](${LINKS.status}) — runs the real engine on request and reports whether it is enforcing\n` +
        `• [Explorer](${LINKS.explorer}) · [Docs](${LINKS.docs}) · [Open guardrail package](${LINKS.skills})`,
    },
  ],
  footer: { text: 'aid-setup:announcement' },
}

export const roadmapEmbed = {
  color: BRAND.accent,
  title: 'Roadmap',
  description:
    'What is actually shipped, and what is next. Nothing here is aspirational: if it is under ' +
    'Shipped, you can open it and check it.',
  fields: [
    {
      name: '✅ Shipped',
      value:
        '**Identity** ERC-8004 registration and KYA verification, read live on-chain.\n' +
        '**Guardrails** the policy engine on two live surfaces (brokerage trading and card spending), ' +
        'with a decision trail, an opt-in badge, and an hourly self-check.\n' +
        '**Payments** x402 pay-per-call tools, live and settling on X Layer via OKX.AI.\n' +
        '**Open package** the guardrail checks published for any agent to install.',
    },
    {
      name: '🛠 In progress',
      value:
        '**First real users.** The public counters read zero and say so, because no real decision has ' +
        'been recorded yet. That is the honest state, and the next milestone is making it stop being true.\n' +
        '**Arc mainnet.** Everything is written against a chain registry, so mainnet is configuration ' +
        'rather than a rewrite. Ready for launch day.',
    },
    {
      name: '📡 Next',
      value:
        '**More surfaces.** The engine is caller-agnostic on purpose: crypto trading is written and ' +
        'unit-tested ahead of the venue, and new callers plug in without touching the core.\n' +
        '**More chains.** Base, Arbitrum, Avalanche, X Layer and Stellar are declared in the ' +
        'registry with honest status flags. Nothing claims to be live before it is.',
    },
    {
      name: '🧭 Deliberately not built',
      value:
        '**Prediction markets: schema only, no code.** A separate CFTC-regulated venue with no agent ' +
        'surface yet. Writing rules against a payload nobody has published would mean inventing it. ' +
        'The surface stays inert and cannot authorize anything.',
    },
  ],
  footer: { text: 'aid-setup:roadmap' },
}

export const generalEmbed = {
  color: BRAND.mcp,
  title: 'gm, and welcome',
  description:
    `${PITCH}\n\n` +
    'Say hi in #introductions, ask anything in the #help forum, and show your work in #showcase.\n\n' +
    `[Site](${LINKS.site}) · [Docs](${LINKS.docs}) · [GitHub](${LINKS.repo})`,
  footer: { text: 'aid-setup:general-pin' },
}

