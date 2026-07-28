/**
 * The caller registry: one descriptor per client the skill can guard.
 *
 * Same shape as the chain registry and the surface registry in the backend, for the same
 * reason: config is DATA, the guard is generic, and adding a client is a descriptor rather
 * than a branch inside the enforcement path.
 *
 * The field that matters most is `enforcement`, and it is honest per caller rather than
 * one comfortable claim for all of them:
 *
 *   process   the client gates every write behind an environment switch, so the skill can
 *             hold a real veto: withhold the switch and the write degrades to a preview.
 *   wrapper   there is no such switch. The guardrail rests on the skill being the only
 *             route the agent is given to the account. That is weaker, and saying so is
 *             the difference between a guarantee and a marketing line.
 */

/** @typedef {'process' | 'wrapper'} Enforcement */

export const CALLERS = [
  {
    id: 'robinhood-official-mcp',
    name: 'Robinhood official MCP',
    /** The default: sanctioned by the venue, so installing it breaks no terms. */
    default: true,
    status: 'supported',
    transport: 'http',
    endpoint: 'https://agent.robinhood.com/mcp/trading',
    enforcement: 'wrapper',
    /** No environment switch exists on a hosted OAuth rail. */
    liveWriteEnvVar: null,
    /** Tools that may move money, change risk, or export data. Anything NOT on the read
     *  allowlist is treated as write-class anyway; this list is for clarity, not for
     *  security (see guard.js classifyTool). */
    writeTools: [
      'place_equity_order',
      'place_option_order',
      'place_crypto_order',
      'cancel_order',
    ],
    readTools: [
      'get_accounts',
      'get_portfolio',
      'get_equity_positions',
      'get_equity_quotes',
      'get_equity_orders',
      'get_options',
      'get_option_positions',
      'get_order_status',
      'review_equity_order',
      'search',
    ],
    /** How the skill obtains a preview of the exact order before checking it. */
    previewTool: 'review_equity_order',
    notes:
      'Official and sanctioned. Requires the venue rollout on the user account. Enforcement is wrapper-level: A-Identity checks every intent the skill sees, and the skill is the only route it asks the user to grant.',
  },
  {
    id: 'robinhood-community-cli',
    name: 'Robinhood community CLI/MCP (unofficial)',
    default: false,
    /** Opt-in: the USER points the skill at it. We do not bundle, vendor or install it. */
    status: 'opt-in',
    transport: 'stdio',
    endpoint: null,
    enforcement: 'process',
    liveWriteEnvVar: 'ROBINHOOD_ALLOW_LIVE_WRITE',
    writeTools: [
      'robinhood_buy',
      'robinhood_sell',
      'robinhood_cancel',
      'robinhood_recurring_create',
      'robinhood_recurring_edit',
      'robinhood_recurring_resume',
      'robinhood_settings',
      'robinhood_transfer',
      'robinhood_documents_download',
    ],
    readTools: [
      'robinhood_portfolio',
      'robinhood_positions',
      'robinhood_quote',
      'robinhood_buying_power',
      'robinhood_options_chain',
      'robinhood_options_strategy_quote',
      'robinhood_order_status',
      'robinhood_wheel',
    ],
    previewTool: null, // its own writes dry-run by default, which IS the preview
    notes:
      'NOT affiliated with or endorsed by Robinhood. It reaches Robinhood via a browser session token, and its own documentation states the venue terms may prohibit automated access. You install it yourself, from upstream, and accept that. In exchange the skill gains a process-level veto through its live-write switch.',
  },
]

const BY_ID = new Map(CALLERS.map((c) => [c.id, c]))

/** Look up a caller descriptor. */
export function getCaller(id) {
  return BY_ID.get(id)
}

/** The caller used when the user names none. */
export function defaultCaller() {
  const d = CALLERS.find((c) => c.default)
  if (!d) throw new Error('caller registry has no default')
  return d
}

/** Callers the skill will drive without extra opt-in. */
export function supportedCallers() {
  return CALLERS.filter((c) => c.status === 'supported')
}

// Fail fast on a malformed registry, the same way the backend registries do.
for (const c of CALLERS) {
  if (!c.id || !c.name) throw new Error('caller descriptor missing id/name')
  if (c.enforcement !== 'process' && c.enforcement !== 'wrapper') {
    throw new Error(`caller ${c.id} has an unknown enforcement level: ${c.enforcement}`)
  }
  if (c.enforcement === 'process' && !c.liveWriteEnvVar) {
    throw new Error(`caller ${c.id} claims process enforcement without a live-write switch`)
  }
  const overlap = c.readTools.filter((t) => c.writeTools.includes(t))
  if (overlap.length) throw new Error(`caller ${c.id} lists ${overlap.join(', ')} as both read and write`)
}

if (CALLERS.filter((c) => c.default).length !== 1) {
  throw new Error('exactly one caller must be the default')
}
