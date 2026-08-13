/**
 * The wire input schemas the MCP server registers, as data.
 *
 * These used to be typed inline in `server.ts`, which made them impossible to check
 * anything else against. That mattered: every published `pre_action_check` example on
 * this site was invalid against the schema it claimed to call, and nothing failed,
 * because the schema and the documentation had no common definition to disagree with.
 *
 * So there is exactly ONE definition now. `server.ts` registers these shapes, and
 * `published-examples.test.ts` validates every JSON example in the public surface
 * (agent skills, llms.txt, llms-full.txt) against the same objects. A docs example that
 * would fail on the wire fails the build instead.
 *
 * Nothing here decides anything. It is shapes and field descriptions only, and the
 * strictness question is deliberately one-sided: the WIRE stays permissive (see
 * `preActionCheckInput`), and the docs test is where strictness lives.
 */
import { z } from 'zod'
import { ARC_CHAIN, CHAIN_IDS } from './chains/index.js'
import { SURFACE_IDS } from './policy/index.js'

/** An example agent id, derived rather than typed out so it cannot name a stale chain. */
const EXAMPLE_CAIP10 = `${ARC_CHAIN.caip2}:8004/849980`

export const resolveAgentInput = {
  query: z
    .string()
    .describe(`Agent id (e.g. "${EXAMPLE_CAIP10}"), token id ("#849980"), or owner address (0x...)`),
  chain: z
    .enum(CHAIN_IDS)
    .optional()
    .describe(
      `Optional filter by registry chain slug (${CHAIN_IDS.join(', ')}). Omit to search every chain that carries an identity registry.`,
    ),
}

export const getReputationInput = {
  agentId: z.string().describe('The platform agent id (e.g. "agent_...") or an on-chain agent id'),
}

export const listAgentsInput = {}
export const getChainStatusInput = {}
export const getArcStatusInput = {}
export const getCircleStatusInput = {}
export const listCapabilitiesInput = {}

export const merchantCheckInput = {
  url: z
    .string()
    .optional()
    .describe("The merchant's site or agent-card URL (its /.well-known/agent.json and agent-card.json are probed)"),
  agentId: z
    .string()
    .optional()
    .describe(
      'The merchant agent id: CAIP-10, bare token id, owner address, or a platform agent id. At least one of url / agentId is required.',
    ),
}

// ── marketplace ────────────────────────────────────────────────────────────────────

export const findAgentInput = {
  query: z.string().optional().describe('Optional keyword to match against service / agent name / category'),
}

export const getAgentManifestInput = { agentId: z.string().describe('The platform agent id (agent_...)') }

export const hireAgentInput = {
  agentId: z.string(),
  service: z.string(),
  /** `priceUsd`, not `amountUsd`. The published skill said `amountUsd` for weeks and every
   *  copy of it was a call that could not succeed. */
  priceUsd: z.number().positive().max(1000),
  description: z.string().optional(),
}

export const deliverTaskInput = { taskId: z.string(), deliverable: z.string() }

export const checkTaskStatusInput = { taskId: z.string() }

export const releaseEscrowInput = {
  taskId: z.string(),
  rating: z.number().min(1).max(5).optional(),
  review: z.string().optional(),
}

// ── policy engine ──────────────────────────────────────────────────────────────────

export const registerAgentInput = {
  name: z.string().describe('Agent name'),
  description: z.string().optional(),
  category: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  endpoint: z.string().optional().describe('Where the agent is reachable'),
  walletAddress: z.string().optional(),
}

export const policyGetInput = { agentId: z.string() }

export const policySetInput = {
  agentId: z.string(),
  policy: z
    .record(z.unknown())
    .describe(
      'Partial policy: perActionCapUsd, dailyCapUsd, humanApprovalAboveUsd, frozen, trade{allowSymbols,denySymbols,allowOptions,tradingHoursUtc,maxConcentrationPct}',
    ),
}

/**
 * Two accepted call shapes, and the reason the loose one is not a mistake.
 *
 * DIRECT: `{ agentId, surface, intent, snapshot? }`. The caller already speaks the
 * engine's neutral vocabulary. This is the original shape and it is unchanged.
 *
 * VIA A CALLER: `{ agentId, surface, callerId, action, account? }`. The caller hands over
 * the venue's own payload and a registered adapter translates it (see callers/). The audit
 * row then records WHERE the numbers came from instead of implying we saw the venue.
 *
 * `intent` is deliberately `z.record(z.unknown())` and NOT a typed object. A malformed
 * intent must reach the engine and come back as a recorded DENY with a reason; a zod
 * rejection would return a protocol error and write no audit row at all, which would lose
 * exactly the property this product sells. Strictness belongs in the docs test.
 */
export const preActionCheckInput = {
  agentId: z.string(),
  surface: z.enum(SURFACE_IDS).describe(`Which action surface (${SURFACE_IDS.join(', ')}); a planned surface can never ALLOW`),
  intent: z
    .record(z.unknown())
    .optional()
    .describe(
      '{ kind: order|purchase|cancel|recurring|settings|transfer|document, notionalUsd, side?, symbol?, assetClass?, protective?, settingKey?, settingValue?, cadence?, merchant?, mcc?, cardId? }. Omit only when sending callerId + action instead.',
    ),
  snapshot: z
    .record(z.unknown())
    .optional()
    .describe(
      '{ todayNotionalUsd, positions[], portfolioValueUsd?, cashAvailableUsd?, marginUsedUsd?, accountType? } gathered by the caller, never authored by the agent being checked',
    ),
  callerId: z
    .string()
    .optional()
    .describe('A registered caller id (see GET /api/callers). Send with `action` instead of a pre-normalized `intent`.'),
  action: z
    .record(z.unknown())
    .optional()
    .describe("The venue's own action payload, in the shape that caller documents. Requires callerId."),
  account: z
    .record(z.unknown())
    .optional()
    .describe("The venue's own account payload, in the shape that caller documents. Requires callerId."),
}

export const auditLogInput = {
  agentId: z.string(),
  since: z.string().optional().describe('ISO timestamp; ignored if unparseable'),
  limit: z.number().optional().describe('1-500, default 100'),
}

export const recordAuditOutcomeInput = {
  agentId: z.string(),
  auditId: z.string(),
  outcome: z.enum(['executed', 'blocked', 'awaiting_human', 'abandoned']),
  evidenceRef: z.string().optional(),
}

/**
 * Every tool name the MCP server can register, mapped to its input shape. The marketplace
 * and policy groups are only registered when the HTTP entry injects their hooks, but they
 * are listed unconditionally: this is the description of the wire, not of one process.
 */
export const MCP_TOOL_SCHEMAS = {
  resolve_agent: resolveAgentInput,
  get_reputation: getReputationInput,
  list_agents: listAgentsInput,
  get_chain_status: getChainStatusInput,
  get_arc_status: getArcStatusInput,
  get_circle_status: getCircleStatusInput,
  list_capabilities: listCapabilitiesInput,
  merchant_check: merchantCheckInput,
  find_agent: findAgentInput,
  get_agent_manifest: getAgentManifestInput,
  hire_agent: hireAgentInput,
  deliver_task: deliverTaskInput,
  check_task_status: checkTaskStatusInput,
  release_escrow: releaseEscrowInput,
  register_agent: registerAgentInput,
  policy_get: policyGetInput,
  policy_set: policySetInput,
  pre_action_check: preActionCheckInput,
  audit_log: auditLogInput,
  record_audit_outcome: recordAuditOutcomeInput,
} satisfies Record<string, z.ZodRawShape>

export type McpToolName = keyof typeof MCP_TOOL_SCHEMAS

/**
 * The schema for one tool as a STRICT object, for validating documentation.
 *
 * Strict here and permissive on the wire is the deliberate asymmetry: an unknown argument
 * in a published example is a reader being told to send something that does nothing, which
 * is worth failing a build over. The same unknown argument arriving on a live call is just
 * noise the server ignores.
 */
export function toolInputSchema(name: string): z.ZodObject<z.ZodRawShape> | null {
  const shape = (MCP_TOOL_SCHEMAS as Record<string, z.ZodRawShape>)[name]
  return shape ? z.object(shape).strict() : null
}

/** Tool names an MCP client can call. Sorted, so a diff of it reads as a real change. */
export const MCP_TOOL_NAMES: string[] = Object.keys(MCP_TOOL_SCHEMAS).sort()
