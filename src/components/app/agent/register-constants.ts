/**
 * The registration wizard's shared vocabulary: capability and category lists,
 * card-style presets, the wizard step order, and the self-serve register
 * commands. One module so RegisterForm and its extracted panes can never
 * drift apart on these values.
 */

export const CAPABILITIES = ['Payments', 'Purchases', 'Rentals', 'Batch actions'] as const

export const CATEGORIES = [
  'Trading',
  'Finance',
  'Research',
  'Data',
  'Content',
  'Translation',
  'DevOps',
  'Software Services',
  'Support',
  'Lifestyle',
  'Art Creation',
  'Other',
]

/** The six --cat-* accent presets an agent can pick for its profile hero. */
export const CARD_STYLES = [1, 2, 3, 4, 5, 6] as const

/** Wizard steps: one section at a time, validated before advancing. */
export const STEPS = ['identity', 'capabilities', 'permissions', 'wallet', 'review'] as const
export type Step = (typeof STEPS)[number]
export const STEP_META: { id: Step; label: string }[] = [
  { id: 'identity', label: 'Identity' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'review', label: 'Review' },
]

/** Same command texts the agent profile's Metadata tab publishes. */
export const MCP_ADD_CMD = 'claude mcp add a-identity --transport http https://a-identity.xyz/mcp'
export const REGISTER_CURL = `curl -X POST https://a-identity.xyz/api/agents/register \\
  -H 'Content-Type: application/json' \\
  -d '{"manifest":{"name":"My Agent","description":"What it does (20+ chars)","category":"Other","capabilities":["translation"]}}'`
