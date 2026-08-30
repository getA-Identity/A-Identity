/**
 * The registration wizard's shared vocabulary: capability and category lists,
 * per-category copy, card-style presets, the wizard step order, and the self-serve
 * register commands. One module so RegisterForm, its extracted panes and the
 * marketplace surfaces that read a category can never drift apart on these values.
 */

export const CAPABILITIES = ['Payments', 'Purchases', 'Rentals', 'Batch actions'] as const

/**
 * What each category means, and one concrete brief a buyer might actually send it.
 *
 * `description` is one plain line: what an agent in this category does. `brief` is a REAL
 * example of the work it takes, and it is what the hire form's placeholder is generated
 * from. The form used to print the same French-translation example on every row, which
 * told a DevOps buyer nothing about what to type, so the example now comes from the
 * category the worker actually sells in.
 *
 * `brief` is optional on purpose: 'Other' is the category for work that fits nowhere
 * above, so there is no honest example to give, and its rows fall back to the plain
 * question rather than to an example borrowed from a different kind of job.
 */
export type CategoryCopy = { id: string; description: string; brief?: string }

export const CATEGORY_COPY: readonly CategoryCopy[] = [
  {
    id: 'Trading',
    description: 'Reads a market and places or sizes trades inside a spend policy.',
    brief: 'Rebalance this position to 60/40 and report every fill',
  },
  {
    id: 'Finance',
    description: 'Moves and reconciles money: invoices, payouts, treasury.',
    brief: 'Reconcile this month of USDC payouts against the invoice list',
  },
  {
    id: 'Research',
    description: 'Digs through sources and comes back with a sourced answer.',
    brief: 'Compare these three vendors on price and uptime, with sources',
  },
  {
    id: 'Data',
    description: 'Collects, cleans and reshapes datasets into something usable.',
    brief: 'Clean this CSV and return one row per customer',
  },
  {
    id: 'Content',
    description: 'Writes and edits copy: posts, docs, landing pages, newsletters.',
    brief: 'Write a 200 word launch post from these release notes',
  },
  {
    id: 'Translation',
    description: 'Moves text between languages and keeps the tone intact.',
    brief: 'Translate this paragraph to French',
  },
  {
    id: 'DevOps',
    description: 'Runs builds, deploys and infrastructure changes.',
    brief: 'Set up a staging deploy for this branch and hand back the URL',
  },
  {
    id: 'Software Services',
    description: 'Writes, reviews or fixes code against a clear spec.',
    brief: 'Fix the failing test in this repo and open a pull request',
  },
  {
    id: 'Support',
    description: 'Answers customer questions and works tickets to a close.',
    brief: 'Answer these five support tickets in our tone of voice',
  },
  {
    id: 'Lifestyle',
    description: 'Everyday errands: planning, booking, scheduling, reminders.',
    brief: 'Plan a two day trip to Lisbon under a 400 EUR budget',
  },
  {
    id: 'Art Creation',
    description: 'Makes images, illustration and other visual assets.',
    brief: 'Draw a square app icon of a blue owl on a cream ground',
  },
  {
    id: 'Other',
    description: 'Work that does not fit any category above.',
  },
]

/** The category picker's options, derived so the list and the copy can never drift. */
export const CATEGORIES = CATEGORY_COPY.map((c) => c.id)

const COPY_BY_ID = new Map(CATEGORY_COPY.map((c) => [c.id.toLowerCase(), c]))

/** The copy for a category, or undefined for one we have never described. Case-insensitive,
 *  because an agent's stored category is free text from a registration. */
export function categoryCopy(category: string | undefined): CategoryCopy | undefined {
  return category ? COPY_BY_ID.get(category.trim().toLowerCase()) : undefined
}

/** One line on what this category does, or null when we have no copy for it. Null means
 *  the surface shows nothing, never a guess at what an unknown category sells. */
export function categoryDescription(category: string | undefined): string | null {
  return categoryCopy(category)?.description ?? null
}

/**
 * The hire form's placeholder for one worker.
 *
 * With an example for the category the buyer sees the shape of a good brief; without one
 * they still get the question, and no example is borrowed from an unrelated category.
 */
export function hireBriefPlaceholder(agentName: string, category: string | undefined): string {
  const brief = categoryCopy(category)?.brief
  return brief ? `What should ${agentName} do? (e.g. "${brief}")` : `What should ${agentName} do?`
}

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
