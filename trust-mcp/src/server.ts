/**
 * The A-Identity trust tools as an MCP server your agent runs itself.
 *
 * An agent that is about to pay or hire another agent asks one of these tools first. The paid
 * tools settle in USDC on Algorand from the agent's OWN account, through the same x402 rail
 * any other buyer uses; this server holds that key in the agent's process and nowhere else,
 * and refuses any single payment above its cap before anything is signed. Without a mnemonic
 * the paid tools answer with their price instead of paying, and say so.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PaymentRequiredError, TrustGuard, TrustOracleError, type FetchLike } from '@a-identity/trust-guard'
import { AlgorandPaymentError, algorandPayer, readAlgorandQuote, SpendCapError } from '@a-identity/trust-guard/algorand'

export const SERVER_NAME = 'a-identity-trust'
export const SERVER_VERSION = '0.1.0'
export const DEFAULT_BASE_URL = 'https://a-identity.xyz'
export const DEFAULT_MAX_USD_PER_CALL = 0.25

export interface TrustMcpConfig {
  /** The paying Algorand account (25 words). Unset: paid tools return their price. */
  mnemonic?: string
  /** The most any single call may cost, in USD. Default 0.25. */
  maxUsdPerCall?: number
  /** The oracle origin. Default https://a-identity.xyz. */
  baseUrl?: string
  /** algod endpoint override. */
  algodUrl?: string
  /** Injected for tests. */
  fetch?: FetchLike
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TrustMcpConfig {
  const cap = Number(env.A_IDENTITY_MAX_USD_PER_CALL)
  return {
    mnemonic: env.A_IDENTITY_ALGORAND_MNEMONIC?.trim() || undefined,
    maxUsdPerCall: Number.isFinite(cap) && cap > 0 ? cap : undefined,
    baseUrl: env.A_IDENTITY_BASE_URL?.trim() || undefined,
    algodUrl: env.A_IDENTITY_ALGOD_URL?.trim() || undefined,
  }
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const refused = (error: string, extra: Record<string, unknown> = {}): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error, ...extra }, null, 2) }],
})

const PAID_TOOLS = ['verify_agent', 'reputation_score', 'risk_check', 'agent_passport', 'agent_batch_audit'] as const

const agentId = z.string().min(1).describe('The agent to check: an ERC-8004 token id ("#849980"), a CAIP id, or an owner address.')
const amountUsd = z.number().min(0).optional().describe('What the payment you are about to make is worth, in USD. Sizes the verdict to the deal.')

export function buildTrustMcpServer(config: TrustMcpConfig = {}): McpServer {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init))
  const cap = config.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL
  const oracle = new TrustGuard({
    rail: 'algorand',
    baseUrl,
    fetch: doFetch,
    onPaymentRequired: config.mnemonic
      ? algorandPayer({ mnemonic: config.mnemonic, maxUsdPerCall: cap, algodUrl: config.algodUrl, fetch: doFetch })
      : undefined,
  })
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  /** A paid call, with every way it can stop turned into an answer the agent can act on. */
  const paid = async (run: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return ok(await run())
    } catch (e) {
      if (e instanceof PaymentRequiredError) {
        let price: unknown = null
        try {
          const q = readAlgorandQuote(e.challenge)
          price = { usd: q.amountUsd, network: q.label, payTo: q.accept.payTo }
        } catch {
          /* the quote is a courtesy; the refusal stands without it */
        }
        return refused(
          'This tool is paid per call in USDC on Algorand. Set A_IDENTITY_ALGORAND_MNEMONIC to an account holding USDC to let this server pay.',
          { price },
        )
      }
      if (e instanceof SpendCapError) {
        return refused(`The price ${e.amountUsd} USDC is above this server's per-call cap of ${e.capUsd} USDC. Nothing was signed. Raise A_IDENTITY_MAX_USD_PER_CALL to allow it.`)
      }
      if (e instanceof AlgorandPaymentError) return refused(`Payment refused before signing: ${e.message}`)
      if (e instanceof TrustOracleError) return refused(e.message, { status: e.status, detail: e.data })
      return refused(e instanceof Error ? e.message : String(e))
    }
  }

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

  server.registerTool(
    'risk_check',
    {
      title: 'Should I pay this agent?',
      description:
        'Paid ($0.05 USDC on Algorand). Call BEFORE paying or hiring another agent: an ALLOW / WARN / DENY verdict on the counterparty with the reasons and signals behind it. Do not pay on DENY.',
      inputSchema: { agentId, amountUsd },
    },
    async ({ agentId, amountUsd }) => paid(() => oracle.riskCheck(agentId, amountUsd === undefined ? undefined : { amountUsd })),
  )

  server.registerTool(
    'verify_agent',
    {
      title: 'Verify an agent',
      description: 'Paid ($0.01 USDC on Algorand). Whether the agent has an on-chain ERC-8004 identity, its KYA (Know Your Agent) status, and whether it has been revoked.',
      inputSchema: { agentId },
    },
    async ({ agentId }) => paid(() => oracle.verify(agentId)),
  )

  server.registerTool(
    'reputation_score',
    {
      title: 'Agent reputation',
      description: 'Paid ($0.02 USDC on Algorand). A deterministic 0-1000 reputation with its breakdown, a Sybil signal, and the latest on-chain attestation of the score.',
      inputSchema: { agentId },
    },
    async ({ agentId }) => paid(() => oracle.reputation(agentId)),
  )

  server.registerTool(
    'agent_passport',
    {
      title: 'Agent passport',
      description: 'Paid ($0.10 USDC on Algorand). Identity, KYA, reputation and the risk verdict for one agent in a single document.',
      inputSchema: { agentId },
    },
    async ({ agentId }) => paid(() => oracle.passport(agentId)),
  )

  server.registerTool(
    'agent_batch_audit',
    {
      title: 'Audit a shortlist of agents',
      description:
        'Paid ($0.04 USDC per agent on Algorand, up to 50). Every verdict for a shortlist in one call, with a summary count. The whole audit is produced before the payment is submitted, so an audit that cannot finish costs nothing. Check the total with price_quote against your cap first.',
      inputSchema: {
        agentIds: z.array(z.string().min(1)).min(1).max(50).describe('The agents to audit.'),
        amountUsd,
      },
    },
    async ({ agentIds, amountUsd }) => paid(() => oracle.batchAudit(agentIds, amountUsd === undefined ? undefined : { amountUsd })),
  )

  return server
}
