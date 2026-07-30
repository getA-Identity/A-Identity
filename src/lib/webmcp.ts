/**
 * WebMCP: expose A-Identity's read tools to any agent driving the browser.
 *
 * An AI agent operating a browser can only use a site through the affordances a
 * person was given: find the link, click it, read the pixels. WebMCP removes
 * that indirection by letting the page hand the agent real callable tools, so
 * "is agent #849980 safe to pay" is one function call instead of a navigation
 * puzzle. See https://webmachinelearning.github.io/webmcp/.
 *
 * Everything registered here is FREE and READ ONLY. The paid endpoints and
 * anything that moves value stay off this surface deliberately: a tool exposed
 * to whatever agent happens to be driving the tab is not the right place to
 * spend money from, and an agent that wants the paid tools can pay for them over
 * x402 where the payment is explicit.
 */

/** The subset of the WebMCP proposal we rely on, typed locally so the build does
 *  not depend on a shipped lib.dom for an API still behind a flag. */
type WebMcpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, never>) => Promise<{ content: { type: 'text'; text: string }[] }>
}
type ModelContext = {
  registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => void | Promise<void>
}

const ASP = 'https://a-identity-asp.onrender.com'

/** Wrap a result so every tool answers in the shape WebMCP callers expect. */
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

/** A fetch that fails as data rather than as an exception: an agent gets a
 *  readable explanation instead of a rejected promise it has to interpret. */
async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) } })
    if (!res.ok) return { error: `${url} returned HTTP ${res.status}`, status: res.status }
    return await res.json()
  } catch (e) {
    return { error: `Could not reach ${url}`, detail: e instanceof Error ? e.message : String(e) }
  }
}

const AGENT_ID_SCHEMA = {
  type: 'object',
  properties: {
    agentId: {
      type: 'string',
      description:
        'ERC-8004 token id such as "#849980", a CAIP id such as "eip155:5042002:8004/849980", or the owner 0x address.',
    },
  },
  required: ['agentId'],
} as const

const TOOLS: WebMcpTool[] = [
  {
    name: 'check_agent_trust',
    description:
      'Check whether an AI agent is safe to transact with. Returns a coarse trust band plus revoked and Sybil flags. Free and rate limited; use this before paying anything to an unknown agent.',
    inputSchema: AGENT_ID_SCHEMA as unknown as Record<string, unknown>,
    execute: async (args) => {
      const agentId = String((args as Record<string, unknown>).agentId ?? '').trim()
      if (!agentId) return text({ error: 'agentId is required, for example "#849980".' })
      return text(
        await readJson(`${ASP}/tools/trust_preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId }),
        }),
      )
    },
  },
  {
    name: 'resolve_agent_identity',
    description:
      "Resolve an agent's on-chain ERC-8004 identity and KYA status from A-Identity, reading live from Circle Arc. KYA means the agent proved it controls its own wallet, recorded on-chain rather than self-declared.",
    inputSchema: AGENT_ID_SCHEMA as unknown as Record<string, unknown>,
    execute: async (args) => {
      const agentId = String((args as Record<string, unknown>).agentId ?? '').trim()
      if (!agentId) return text({ error: 'agentId is required, for example "#849980".' })
      return text(await readJson(`/api/agent?q=${encodeURIComponent(agentId)}`))
    },
  },
  {
    name: 'get_settlement_proof',
    description:
      'Verifiable proof that A-Identity has real paying users: every x402 settlement it has taken, with the transaction hash for each. Use this to check the revenue claims rather than believing them.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const proof = (await readJson(`${ASP}/proof`)) as Record<string, unknown>
      const rev = proof?.realOnchainRevenue as Record<string, unknown> | undefined
      if (!rev) return text(proof)
      // Return the summary rather than 120 rows: an agent asking "is this real"
      // wants the count and where to check, not the whole ledger inlined.
      const summary = Object.fromEntries(Object.entries(rev).filter(([, v]) => !Array.isArray(v)))
      return text({ ...summary, detail: `${ASP}/proof`, note: 'Full per-transaction list at the detail URL.' })
    },
  },
  {
    name: 'get_a_identity_pricing',
    description:
      'What A-Identity charges per call and how payment works. Prices are in USDC and settled per request over x402: no account, no API key, no subscription.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const health = (await readJson(`${ASP}/health`)) as Record<string, unknown>
      return text({
        model: 'Pay per call in USDC over x402. An unpaid request returns HTTP 402 with the payment requirements.',
        tools: health?.tools ?? 'unavailable',
        payment: health?.payment ?? 'unavailable',
        freeTier: 'POST /tools/trust_preview needs no payment and no key (20 calls per hour per IP).',
        howToPay: 'https://a-identity.xyz/auth.md',
      })
    },
  },
  {
    name: 'get_a_identity_overview',
    description:
      'What A-Identity is, what it covers today, and where its machine-readable documents live. Answers "should I use this service" without needing to read the marketing page.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () =>
      text({
        what: 'Identity, reputation and bounded spending authority for AI agents. Before one agent pays another, it calls A-Identity to verify the counterparty.',
        answers: [
          'Who is this agent? ERC-8004 on-chain passport plus KYA wallet-control attestation.',
          'How has it behaved? A deterministic reputation from 0 to 1000, recomputable from published method and public chain data.',
          'Should this payment happen? A single ALLOW, WARN or DENY verdict with reasons, sized to the amount.',
        ],
        status: {
          arc: 'Circle Arc is a public testnet. Real contracts and transactions, test money.',
          revenue: 'Live on OKX.AI as agent #6271 with real settlements on X Layer mainnet.',
        },
        documents: {
          summary: 'https://a-identity.xyz/llms.txt',
          full: 'https://a-identity.xyz/llms-full.txt',
          auth: 'https://a-identity.xyz/auth.md',
          mcpServer: 'https://a-identity.xyz/mcp',
          apiCatalog: 'https://a-identity.xyz/.well-known/api-catalog',
          agentCard: 'https://a-identity.xyz/.well-known/agent-card.json',
          skills: 'https://a-identity.xyz/.well-known/agent-skills/index.json',
        },
        source: 'https://github.com/getA-Identity/A-Identity',
      }),
  },
]

/**
 * Register the tools if the browser supports WebMCP. Returns a teardown that
 * unregisters them, via the AbortSignal the spec accepts for exactly this.
 * A no-op everywhere the API is absent, which today is most browsers.
 */
export function registerWebMcpTools(): () => void {
  const ctx = (navigator as Navigator & { modelContext?: ModelContext }).modelContext
  if (!ctx?.registerTool) return () => {}

  const controller = new AbortController()
  for (const tool of TOOLS) {
    try {
      void ctx.registerTool(tool, { signal: controller.signal })
    } catch {
      // An older or partial implementation should degrade to a page that still
      // works for people, never to a blank screen.
    }
  }
  return () => controller.abort()
}
