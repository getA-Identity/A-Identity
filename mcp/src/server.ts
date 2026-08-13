/**
 * Builds the A-Identity MCP server and registers its read-only tools.
 * Shared by the stdio entry (index.ts) and the HTTP entry (http.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listCapabilities, CHAIN_CONFIG } from './data.js'
import { CHAINS, identityChains } from './chains/index.js'
import {
  resolveAgentInput, getReputationInput, listAgentsInput, getChainStatusInput,
  getArcStatusInput, getCircleStatusInput, listCapabilitiesInput, merchantCheckInput,
  findAgentInput, getAgentManifestInput, hireAgentInput, deliverTaskInput,
  checkTaskStatusInput, releaseEscrowInput, registerAgentInput, policyGetInput,
  policySetInput, preActionCheckInput, auditLogInput, recordAuditOutcomeInput,
} from './mcp-tool-schemas.js'
import { createIdentityProvider } from './erc8004.js'
import { computeAgentReputation } from './reputation.js'
import { getArcStatus } from './arc.js'
import { getCircleStatus } from './circle.js'
import { merchantCheck } from './commerce.js'

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})

/**
 * Tool descriptions are INTERPOLATED from the registry rather than typed out, because
 * the typed-out ones went stale silently: `resolve_agent` still said "Circle Arc's
 * registry" and `get_chain_status` still said "Arc is the live chain today" long after
 * five more chains carried a live ERC-8004 registry. A description an MCP client reads
 * is a claim, so it has to come from the same place the behaviour does.
 */
const IDENTITY_CHAINS = identityChains()
const CHAIN_COUNT = (status: string) => CHAINS.filter((c) => c.status === status).length

/**
 * Real-data hooks the HTTP entry (http.ts) injects so the discovery tools return
 * live platform state instead of nothing. The stdio entry passes none - there,
 * `list_agents` is empty (ERC-8004 registries aren't enumerable) and `get_reputation`
 * says reputation lives on the platform. No mocks in either path.
 */
export type ServerData = {
  listAgents?: () => Array<{ agentId: string; name?: string; chain: string; kya?: string; onchain?: string; walletAddress?: string | null }>
  getReputation?: (agentId: string) => unknown | null
  /** Marketplace hooks the HTTP entry injects (with a per-request verified caller baked in),
   *  so an external agent can transact over MCP. Absent on the stdio entry (read-only). The
   *  mutating hooks are already ownership-gated in platform.ts: with no verified caller they
   *  return a Forbidden error, so exposing them over MCP never bypasses auth. */
  marketplace?: {
    catalog: () => unknown
    manifest: (agentId: string) => unknown
    hire: (input: { agentId: string; service: string; priceUsd: number; description?: string }) => unknown
    deliver: (taskId: string, deliverable: string) => unknown
    checkTask: (taskId: string) => unknown
    release: (taskId: string, opts: { rating?: number; review?: string }) => Promise<unknown>
  }
  /**
   * Policy Engine v2 hooks (Phase 1.7), injected by the HTTP entry with the per-request
   * verified caller baked in. Same security model as the marketplace hooks and no new
   * one: every hook is ownership-gated inside platform.ts, so without a verified caller
   * they return Forbidden and exposing them over MCP cannot bypass auth.
   *
   * These are the OWNER surface and they are free. The paid counterparty signal
   * (guardrail_check) lives on the ASP behind x402 instead, because payment proves
   * someone paid, not that they own the agent: see ./policy/README.md, "Why the owner
   * surface is free".
   */
  policy?: {
    getPolicy: (agentId: string) => unknown
    setPolicy: (agentId: string, policy: unknown) => unknown
    /** Two accepted shapes, resolved server-side: `{surface, intent, snapshot?}` or
     *  `{surface, callerId, action, account?}`. See mcp-tool-schemas.ts. */
    check: (
      agentId: string,
      input: {
        surface: string
        intent?: unknown
        snapshot?: unknown
        callerId?: string
        action?: unknown
        account?: unknown
      },
    ) => unknown
    auditLog: (agentId: string, opts: { since?: string; limit?: number }) => unknown
    recordOutcome: (agentId: string, auditId: string, outcome: string, evidenceRef?: string) => unknown
    register: (manifest: Record<string, unknown>) => unknown
  }
}

export function buildServer(data: ServerData = {}): McpServer {
  const server = new McpServer({ name: 'a-identity-mcp', version: '0.2.0' })
  const identity = createIdentityProvider()

  server.registerTool(
    'resolve_agent',
    {
      title: 'Resolve agent identity',
      description:
        `Resolve an agent's identity with a LIVE on-chain read of the ERC-8004 IdentityRegistry (ownerOf + tokenURI) on any of the ${IDENTITY_CHAINS.length} chains that carry one (${IDENTITY_CHAINS.map((c) => c.shortName).join(', ')}). Query by agent id (CAIP-10), token id, or owner address. Read-only, no mocks.`,
      inputSchema: resolveAgentInput,
    },
    async ({ query, chain }) => {
      const agent = await identity.resolve(query)
      if (!agent) return json({ found: false, query, reason: 'No matching registration' })
      if (chain && agent.chain !== chain) {
        return json({
          found: false,
          query,
          reason: `Agent resolved on "${agent.chain}", not the requested chain "${chain}"`,
        })
      }
      return json({ found: true, source: identity.kind, agent })
    },
  )

  server.registerTool(
    'get_reputation',
    {
      title: 'Get agent reputation',
      description:
        "An agent's deterministic reputation (0-1000) computed from REAL activity: on-chain USDC settlements, verified ERC-8004 identity, clean ratio, and tenure. Read-only.",
      inputSchema: getReputationInput,
    },
    async ({ agentId }) => {
      const rep = data.getReputation?.(agentId)
      if (rep && !(typeof rep === 'object' && 'error' in (rep as object))) {
        return json({ found: true, reputation: rep })
      }
      // No platform history: fall back to the SAME identity-only basis the paid
      // reputation_score uses, so the free surface and the paid tool never disagree
      // on the number. A live on-chain identity earns exactly the identity credit;
      // tenure is 0 because we cannot vouch for a self-reported registration date.
      const id = await identity.resolve(agentId).catch(() => null)
      if (id) {
        const r = computeAgentReputation({ settledCount: 0, rejected: 0, onchainRegistered: true, createdAt: new Date() })
        return json({
          found: true,
          reputation: {
            agentId,
            name: null,
            onchain: 'registered',
            score: r.score,
            breakdown: r.breakdown,
            settledOnchain: 0,
            settledEffective: 0,
            settledUsd: 0,
            basis: id.partial
              ? 'onchain-identity (existence proven; no platform settlement history)'
              : 'onchain-identity (no platform settlement history)',
            computedAt: new Date().toISOString(),
          },
        })
      }
      return json({ found: false, agentId, reason: 'Unknown agent or no activity yet' })
    },
  )

  server.registerTool(
    'list_agents',
    {
      title: 'List registered agents',
      description:
        'List the real agents registered on this A-Identity platform (name, chain, KYA + on-chain status). ERC-8004 registries are not enumerable, so this lists agents this instance knows - not every token ever minted.',
      inputSchema: listAgentsInput,
    },
    async () => {
      const agents = data.listAgents ? data.listAgents() : []
      return json({
        total: agents.length,
        source: data.listAgents ? 'platform' : 'none (registry not enumerable; connect to a platform instance)',
        agents,
      })
    },
  )

  server.registerTool(
    'get_chain_status',
    {
      title: 'Get supported chain status',
      description:
        `List every chain in the A-Identity chain registry, with its identity standard, x402 support, the ERC-8004 registries it carries and its lifecycle status: ${CHAIN_COUNT('live')} live, ${CHAIN_COUNT('beta')} beta, ${CHAIN_COUNT('planned')} planned.`,
      inputSchema: getChainStatusInput,
    },
    async () => {
      return json({ chains: CHAIN_CONFIG })
    },
  )

  server.registerTool(
    'get_arc_status',
    {
      title: 'Get live Circle Arc status',
      description:
        'Connect to the Circle Arc testnet over JSON-RPC and read live chain state (chainId, latest block). Arc pays gas in USDC with sub-second finality. Read-only, no keys.',
      inputSchema: getArcStatusInput,
    },
    async () => json(await getArcStatus()),
  )

  server.registerTool(
    'get_circle_status',
    {
      title: 'Get Circle platform status',
      description:
        'Report the Circle developer platform link: wallets (W3S), Gateway (unified balance), USDC. Performs a real authenticated ping when CIRCLE_API_KEY is set; otherwise explains what to configure. Read-only.',
      inputSchema: getCircleStatusInput,
    },
    async () => json(await getCircleStatus()),
  )

  server.registerTool(
    'list_capabilities',
    {
      title: 'List A-Identity capabilities',
      description:
        'Describe the full A-Identity protocol surface: identity, payments, connectivity, reputation, and supported chains.',
      inputSchema: listCapabilitiesInput,
    },
    async () => json(listCapabilities()),
  )

  server.registerTool(
    'merchant_check',
    {
      title: 'Verify a commerce merchant agent',
      description:
        "Verify a merchant-side agent BEFORE a checkout or payment authorization - the trust step agentic-commerce protocols (ACP/UCP) leave to user approval. Discovers the merchant's /.well-known agent card (SSRF-guarded), resolves its ERC-8004 identity with a live on-chain read, reads the platform's KYA / reputation / Sybil view, and returns ALLOW / WARN / DENY with every triggered reason. Free, read-only, creates no state.",
      inputSchema: merchantCheckInput,
    },
    async ({ url, agentId }) => json(await merchantCheck({ url, agentId })),
  )

  // ── marketplace tools (only when the HTTP entry injects the hooks) ───────────────
  // Let an external agent transact end-to-end over MCP: find a verified worker, read its
  // manifest, hire it, deliver, check status, release the escrow. The mutating tools require a
  // VERIFIED session on the /mcp request (Authorization: Bearer <token>); without one the
  // ownership gate in platform.ts returns a Forbidden error, so nothing bypasses auth.
  if (data.marketplace) {
    const mp = data.marketplace

    server.registerTool(
      'find_agent',
      {
        title: 'Find a verified worker agent',
        description:
          'Search the marketplace catalog of KYA-verified worker agents and their services (name, price in USDC, rating, completed jobs). Optionally filter by a keyword matched against the service, agent name, or category. Read-only.',
        inputSchema: findAgentInput,
      },
      async ({ query }) => {
        const cat = mp.catalog() as { services: Array<Record<string, unknown>>; total: number }
        const q = (query ?? '').trim().toLowerCase()
        const services = q
          ? cat.services.filter((s) =>
              [s.service, s.agentName, s.category].some((f) => String(f ?? '').toLowerCase().includes(q)),
            )
          : cat.services
        return json({ total: services.length, services })
      },
    )

    server.registerTool(
      'get_agent_manifest',
      {
        title: 'Get an agent manifest (AMP Discover)',
        description:
          "Read an agent's public manifest: its ERC-8004 identity, services, reputation, and how to hire it. Only a KYA-verified agent is hireable. Read-only.",
        inputSchema: getAgentManifestInput,
      },
      async ({ agentId }) => json(mp.manifest(agentId)),
    )

    server.registerTool(
      'hire_agent',
      {
        title: 'Hire a verified worker agent',
        description:
          'Hire a KYA-verified agent for a service; USDC is committed to an ERC-8183 escrow on Arc. Requires a VERIFIED session (send Authorization: Bearer <token> with the /mcp request; obtain one via SIWE). Returns the created task.',
        inputSchema: hireAgentInput,
      },
      async ({ agentId, service, priceUsd, description }) => json(await mp.hire({ agentId, service, priceUsd, description })),
    )

    server.registerTool(
      'deliver_task',
      {
        title: 'Deliver a task result',
        description:
          "Submit a deliverable for a task your agent was hired for (the hired agent's owner). Requires a verified session. Returns the updated task.",
        inputSchema: deliverTaskInput,
      },
      async ({ taskId, deliverable }) => json(mp.deliver(taskId, deliverable)),
    )

    server.registerTool(
      'check_task_status',
      {
        title: 'Check a task status',
        description:
          'Read a task you are a party to (the client or the hired agent owner): status, deliverable, escrow settlement, and on-chain tx. Requires a verified session.',
        inputSchema: checkTaskStatusInput,
      },
      async ({ taskId }) => json(mp.checkTask(taskId)),
    )

    server.registerTool(
      'release_escrow',
      {
        title: 'Release task escrow',
        description:
          'Approve and release a task (the hiring client): settles the ERC-8183 escrow to the worker in USDC on Arc, with an optional review. Requires a verified session. Returns the settled task.',
        inputSchema: releaseEscrowInput,
      },
      async ({ taskId, rating, review }) => json(await mp.release(taskId, { rating, review })),
    )
  }

  // ── policy tools (Phase 1.7; only when the HTTP entry injects the hooks) ─────────
  // The guardrail an agent's own actions clear before they reach a venue. Every tool is
  // ownership-gated in platform.ts, so a request without a verified session gets Forbidden.
  // Free: these are the owner's own rules on their own account.
  if (data.policy) {
    const p = data.policy

    server.registerTool(
      'register_agent',
      {
        title: 'Register an agent from a manifest',
        description:
          'Register an agent from a manifest and get back its id, its honest ERC-8004 status (queued until a registration tx is broadcast) and its guardrail badge set. Free. Requires a verified session.',
        inputSchema: registerAgentInput,
      },
      async (manifest) => json(p.register(manifest as Record<string, unknown>)),
    )

    server.registerTool(
      'policy_get',
      {
        title: 'Read the action policy',
        description:
          "Read this agent's action policy: per-action and daily caps, the human-approval line, symbol allow/deny lists, options and margin switches, trading hours and concentration limit, plus its version. Returns safe defaults with configured:false when the owner has not set one yet. Owner only.",
        inputSchema: policyGetInput,
      },
      async ({ agentId }) => json(p.getPolicy(agentId)),
    )

    server.registerTool(
      'policy_set',
      {
        title: 'Update the action policy',
        description:
          "Update this agent's action policy. The patch is sanitized (caps clamped, symbols normalized) and the version bumps by one. Margin cannot be enabled: it is off by construction. Owner only, and a mutating call, so it requires a verified session.",
        inputSchema: policySetInput,
      },
      async ({ agentId, policy }) => json(p.setPolicy(agentId, policy)),
    )

    server.registerTool(
      'pre_action_check',
      {
        title: 'Check an intended action against the policy',
        description:
          'Ask whether an action the agent intends to take is allowed: returns ALLOW, WARN or DENY with every reason, plus the audit id and where the numbers came from. It NEVER executes anything, so the caller acts on the verdict. Fails closed: a rule that cannot be evaluated for missing snapshot data returns DENY. Send either a pre-normalized {intent, snapshot} or a registered {callerId, action, account} pair (see GET /api/callers). The account state must be gathered by the caller, not authored by the agent being checked. Free. Owner only.',
        inputSchema: preActionCheckInput,
      },
      // Passed through as one object rather than field by field: the two accepted call
      // shapes are resolved in one place (platform/guardrail.ts), so the wire cannot
      // develop its own opinion about which one won.
      async (input) => json(p.check(input.agentId, input)),
    )

    server.registerTool(
      'audit_log',
      {
        title: 'Read the decision trail',
        description:
          "This agent's recorded decisions, newest first, with a summary including the USD value the policy actually refused. Each entry carries a HASH of the account snapshot rather than the snapshot itself. Free. Owner only.",
        inputSchema: auditLogInput,
      },
      async ({ agentId, since, limit }) => json(p.auditLog(agentId, { since, limit })),
    )

    server.registerTool(
      'record_audit_outcome',
      {
        title: 'Record what happened after a verdict',
        description:
          'Record the outcome of a decision: executed, blocked, awaiting_human or abandoned, with an optional evidence reference (e.g. a venue order id) so the entry can be reconciled rather than believed. A DENY can never be recorded as executed. Owner only.',
        inputSchema: recordAuditOutcomeInput,
      },
      async ({ agentId, auditId, outcome, evidenceRef }) => json(p.recordOutcome(agentId, auditId, outcome, evidenceRef)),
    )
  }

  return server
}
