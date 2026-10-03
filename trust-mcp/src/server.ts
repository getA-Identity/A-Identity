/**
 * The A-Identity trust tools as an MCP server your agent runs itself.
 *
 * An agent that is about to pay calls check_before_pay first (check_batch for several targets):
 * it picks the checks the amount calls for and pays only for the ones the agent does not already
 * have, since every answer is kept for 24 hours and the same check of the same target is never
 * paid for twice (checks.ts). The paid tools settle in USDC on Algorand from the agent's OWN
 * account, through the same x402 rail any other buyer uses; this server holds that key in the
 * agent's process and nowhere else, and refuses any single payment above its cap before anything
 * is signed. Without a mnemonic, saved answers are still served and anything new answers with
 * its price instead of paying, and says so.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FetchLike } from '@a-identity/trust-guard'
import { readAlgorandQuote } from '@a-identity/trust-guard/algorand'
import { askOne, BATCH_MAX, CACHE_HOURS, checkBatch, checkBeforePay, checksLedgerPath, explain, LARGE_PAYMENT_USD, type Gate, type Tool } from './checks.js'
import { VERSION } from './version.js'

export const SERVER_NAME = 'a-identity-trust'
export const SERVER_VERSION = VERSION
export const DEFAULT_BASE_URL = 'https://a-identity.xyz'
export const DEFAULT_MAX_USD_PER_CALL = 10

export interface TrustMcpConfig {
  /** The paying Algorand account (25 words). Unset: paid tools return their price. */
  mnemonic?: string
  /** The most any single call may cost, in USD. Default 10, which covers every single-agent
   *  tool at Algorand's prices (1 to 10 USDC); a batch audit needs it raised. */
  maxUsdPerCall?: number
  /** The oracle origin. Default https://a-identity.xyz. */
  baseUrl?: string
  /** algod endpoint override. */
  algodUrl?: string
  /** Where answers are kept. Default ~/.a-identity/checks.json. */
  ledgerPath?: string
  /** Hours an answer is kept and served instead of paying again: 24 or more (less reads as 24). */
  cacheHours?: number
  /** Injected for tests. */
  fetch?: FetchLike
  now?: () => number
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TrustMcpConfig {
  const cap = Number(env.A_IDENTITY_MAX_USD_PER_CALL)
  const hours = Number(env.A_IDENTITY_CACHE_HOURS)
  return {
    mnemonic: env.A_IDENTITY_ALGORAND_MNEMONIC?.trim() || undefined,
    maxUsdPerCall: Number.isFinite(cap) && cap > 0 ? cap : undefined,
    baseUrl: env.A_IDENTITY_BASE_URL?.trim() || undefined,
    algodUrl: env.A_IDENTITY_ALGOD_URL?.trim() || undefined,
    ledgerPath: env.A_IDENTITY_CHECKS_LEDGER?.trim() || undefined,
    cacheHours: Number.isFinite(hours) && hours > 0 ? hours : undefined,
  }
}

/** What an MCP client puts in front of the agent, in its own words. */
export const INSTRUCTIONS =
  'A-Identity trust checks, paid in USDC from the wallet this server holds; that USDC is the budget the user gave you for checks. ' +
  'Before every payment you make (to an Algorand address, an x402 seller or another agent), call check_before_pay with the target and the amount; use check_batch for several targets. ' +
  'If the decision is DENY, do not make that payment. ' +
  `Do not check the same target again: each answer is kept for ${CACHE_HOURS} hours and a repeat returns the saved answer for free, so it tells you nothing new. ` +
  'Decide on your own which targets to check; do not ask the user.'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const refused = (error: string, extra: Record<string, unknown> = {}): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error, ...extra }, null, 2) }],
})

const PAID_TOOLS = ['pay_check', 'verify_agent', 'reputation_score', 'risk_check', 'agent_passport', 'agent_batch_audit'] as const

const agentId = z.string().min(1).describe('The agent to check: an ERC-8004 token id ("#849980"), a CAIP id, or an owner address.')
const amountUsd = z.number().min(0).optional().describe('What the payment you are about to make is worth, in USD. Sizes the verdict to the deal.')
const target = z.string().min(1).describe('Who you are about to pay: an Algorand address, the link of an x402 seller, or an agent id (an ERC-8004 token id like "#849980", a CAIP id, or an owner address).')
const amount = z.number().min(0).describe('What you are about to pay, in USD.')
const SAVED = `Saved for ${CACHE_HOURS} hours: asking again returns the saved answer and pays nothing.`

export function buildTrustMcpServer(config: TrustMcpConfig = {}): McpServer {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init))
  const cap = config.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL
  const gate: Gate = {
    ledgerPath: config.ledgerPath ?? checksLedgerPath(),
    baseUrl,
    fetchImpl: doFetch,
    mnemonic: config.mnemonic,
    algod: config.algodUrl,
    maxUsdPerCall: cap,
    cacheHours: config.cacheHours,
    now: config.now,
  }
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS })

  /** A check, with every way it can stop turned into an answer the agent can act on. */
  const paid = async (run: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return ok(await run())
    } catch (e) {
      const { error, extra } = explain(e, Boolean(config.mnemonic))
      return refused(error, extra)
    }
  }

  server.registerTool(
    'check_before_pay',
    {
      title: 'Check before you pay',
      description:
        'Call this BEFORE every payment you make. Give the target and the amount; it picks the checks that amount calls for and returns a decision: ALLOW, WARN or DENY. ' +
        `An Algorand address or x402 seller gets "is it safe to pay" ($5). An agent gets a payment decision sized to the amount ($5), and above $${LARGE_PAYMENT_USD} its passport too ($10). ` +
        'If the decision is DENY, do not pay. Do not check the same target again: every check is ' +
        `saved for ${CACHE_HOURS} hours and a repeat returns the saved answer for free, so it brings nothing new. Paid from the wallet\'s USDC, the budget the user gave you; decide on your own, do not ask the user.`,
      inputSchema: { target, amount },
    },
    async ({ target, amount }) => paid(() => checkBeforePay(gate, target, amount)),
  )

  server.registerTool(
    'check_batch',
    {
      title: 'Check several targets before paying',
      description:
        `check_before_pay for up to ${BATCH_MAX} targets at once, each with the amount you would pay it. A target named twice is checked once, at the larger amount, ` +
        'and targets already checked answer from their saved result for free. Do not pay a target whose decision is DENY, and do not check the same targets again.',
      inputSchema: { targets: z.array(z.object({ target, amount })).min(1).max(BATCH_MAX).describe('The targets, each with what you are about to pay it in USD.') },
    },
    async ({ targets }) => paid(() => checkBatch(gate, targets)),
  )

  server.registerTool(
    'price_quote',
    {
      title: 'Quote a trust tool',
      description:
        'Free. The live price of one A-Identity trust tool in USDC on Algorand, read from its x402 challenge. For agent_batch_audit, pass count to price a shortlist.',
      inputSchema: {
        tool: z.enum(PAID_TOOLS).describe('Which tool to price.'),
        count: z.number().int().min(1).max(50).optional().describe('agent_batch_audit only: how many agents.'),
      },
    },
    async ({ tool, count }) => {
      try {
        const url = `${baseUrl}/api/x402/algorand/tools/${tool}${count ? `?count=${count}` : ''}`
        const res = await doFetch(url, { headers: { accept: 'application/json' } })
        if (res.status !== 402) return refused(`expected a 402 price challenge from ${url}, got HTTP ${res.status}`)
        const quote = readAlgorandQuote(await res.json())
        return ok({ tool, ...(count ? { count } : {}), priceUsd: quote.amountUsd, network: quote.label, payTo: quote.accept.payTo, capUsd: cap, withinCap: quote.amountUsd <= cap, payerConfigured: Boolean(config.mnemonic) })
      } catch (e) {
        return refused(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // The single tools, for an agent that wants one answer by name. They go through the same
  // gate: a check already saved answers for free, and nothing is paid for twice.
  const one = (tool: Tool) => (subject: string | string[], deal?: number) => paid(() => askOne(gate, tool, subject, deal))

  server.registerTool(
    'pay_check',
    {
      title: 'Is it safe to pay this Algorand address?',
      description:
        `Paid ($5 USDC on Algorand). Before paying an Algorand address: Looks safe, Be careful or Don't pay, with the reasons, its biggest payers (and whether they are linked to it), its last payments, and the wallet that created it. Takes an Algorand address or the link of an x402 seller. Prefer check_before_pay. ${SAVED}`,
      inputSchema: { address: z.string().min(1).describe('The Algorand address you are about to pay, or the link of an x402 seller.') },
    },
    async ({ address }) => one('pay_check')(address),
  )

  server.registerTool(
    'risk_check',
    {
      title: 'Should I pay this agent?',
      description:
        `Paid ($5 USDC on Algorand). Call BEFORE paying or hiring another agent: an ALLOW / WARN / DENY verdict on the counterparty with the reasons and signals behind it. Do not pay on DENY. Prefer check_before_pay. ${SAVED}`,
      inputSchema: { agentId, amountUsd },
    },
    async ({ agentId, amountUsd }) => one('risk_check')(agentId, amountUsd),
  )

  server.registerTool(
    'verify_agent',
    {
      title: 'Verify an agent',
      description: `Paid ($1 USDC on Algorand). Whether the agent has an on-chain ERC-8004 identity, its KYA (Know Your Agent) status, and whether it has been revoked. ${SAVED}`,
      inputSchema: { agentId },
    },
    async ({ agentId }) => one('verify_agent')(agentId),
  )

  server.registerTool(
    'reputation_score',
    {
      title: 'Agent reputation',
      description: `Paid ($2 USDC on Algorand). A deterministic 0-1000 reputation with its breakdown, a Sybil signal, and the latest on-chain attestation of the score. ${SAVED}`,
      inputSchema: { agentId },
    },
    async ({ agentId }) => one('reputation_score')(agentId),
  )

  server.registerTool(
    'agent_passport',
    {
      title: 'Agent passport',
      description: `Paid ($10 USDC on Algorand). Identity, KYA, reputation and the risk verdict for one agent in a single document. ${SAVED}`,
      inputSchema: { agentId },
    },
    async ({ agentId }) => one('agent_passport')(agentId),
  )

  server.registerTool(
    'agent_batch_audit',
    {
      title: 'Audit a shortlist of agents',
      description:
        'Paid ($4 USDC per agent on Algorand, up to 50). Every verdict for a shortlist in one call, with a summary count. The whole audit is produced before the payment is submitted, so an audit that cannot finish costs nothing. ' +
        `Check the total with price_quote against your cap first. ${SAVED}`,
      inputSchema: {
        agentIds: z.array(z.string().min(1)).min(1).max(50).describe('The agents to audit.'),
        amountUsd,
      },
    },
    async ({ agentIds, amountUsd }) => one('agent_batch_audit')(agentIds, amountUsd),
  )

  return server
}
