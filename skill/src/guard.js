/**
 * The guard: the only path between an agent's intent and the venue.
 *
 * Pure and injectable, exactly like the backend's decision engine. Every side effect the
 * guard needs (ask A-Identity for a verdict, read account state, ask the human, run the
 * command) arrives as a function, so the whole enforcement path is unit-testable with no
 * account, no network and no fabricated market data.
 *
 * The rules it exists to make unbreakable:
 *
 *   1. A write-class action is never executed without a verdict.
 *   2. DENY is final. No retry, no override, no "the agent confirmed".
 *   3. WARN needs a HUMAN. Auto-execute is off by default and never satisfies a DENY.
 *   4. Unknown tool means write-class. Default closed, so an upstream update that adds a
 *      tool cannot quietly add an unguarded path.
 *   5. The snapshot is gathered here, never accepted from the agent being checked.
 *   6. The live-write switch is never persisted; it is granted for one approved command.
 *
 * Rule 4 is the one that survives contact with reality: the tool lists in callers.js are
 * documentation, and this file treats anything not explicitly a read as a write.
 */
import { DISCLOSURE, INVARIANTS } from './defaults.js'

export class GuardConfigError extends Error {}

/**
 * Refuse to operate when the caller's live-write switch is already set in the ambient
 * environment (bypass 3). If it is, this process cannot withhold it, so the veto the user
 * thinks they have does not exist. Refusing loudly beats running while implying protection.
 */
export function assertNoAmbientLiveWrite(caller, env) {
  const key = caller.liveWriteEnvVar
  if (!key) return
  const value = env?.[key]
  if (value !== undefined && value !== '' && value !== '0') {
    throw new GuardConfigError(
      `${key} is already set in this environment, so this skill cannot withhold it and cannot enforce a denial. ` +
        `Unset it (remove it from your shell profile and any .env), then start again.`,
    )
  }
}

/** read | write. Anything not explicitly a read is a write. */
export function classifyTool(caller, tool) {
  return caller.readTools.includes(tool) ? 'read' : 'write'
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Turn a caller's preview of an action into the neutral intent the backend checks.
 *
 * The preview is the venue's own rendering of what it is about to do, which is why it is
 * the input rather than the agent's prose: an agent that says "buy a little AAPL" and means
 * 400 shares cannot mislead the check. A preview we cannot read is a DENY, not a guess.
 */
export function intentFromPreview(tool, preview) {
  if (!preview || typeof preview !== 'object') return null
  const kind = preview.kind ?? inferKind(tool)
  if (!kind) return null

  const notional = num(preview.notionalUsd) ?? computeNotional(preview)
  if (notional === null || notional < 0) return null

  const intent = { kind, notionalUsd: notional }
  if (preview.side) intent.side = String(preview.side).toLowerCase()
  if (preview.symbol) intent.symbol = String(preview.symbol).toUpperCase()
  if (preview.assetClass) intent.assetClass = String(preview.assetClass).toLowerCase()
  if (preview.protective === true) intent.protective = true
  if (preview.settingKey) intent.settingKey = String(preview.settingKey).toLowerCase()
  if (preview.settingValue !== undefined) intent.settingValue = preview.settingValue
  if (preview.cadence) intent.cadence = String(preview.cadence)
  return intent
}

function inferKind(tool) {
  const t = tool.toLowerCase()
  if (t.includes('recurring')) return 'recurring'
  if (t.includes('settings')) return 'settings'
  if (t.includes('transfer')) return 'transfer'
  if (t.includes('document')) return 'document'
  if (t.includes('cancel')) return 'cancel'
  if (t.includes('buy') || t.includes('sell') || t.includes('order')) return 'order'
  return null
}

function computeNotional(preview) {
  const qty = num(preview.quantity) ?? num(preview.shares)
  const price = num(preview.limitPrice) ?? num(preview.price)
  if (qty !== null && price !== null) return Math.abs(qty * price)
  // A settings toggle or a document pull moves no money but is still an action.
  if (preview.kind === 'settings' || preview.kind === 'document') return 0
  return null
}

/**
 * Build a guard.
 *
 * @param {object} deps
 * @param {object} deps.caller       descriptor from callers.js
 * @param {(input: {intent: object, snapshot: object|undefined}) => Promise<object>} deps.check
 *        asks A-Identity for a verdict (pre_action_check)
 * @param {() => Promise<object>} deps.readSnapshot  gathers account state from READ tools
 * @param {(req: {tool: string, args: object, env?: object}) => Promise<unknown>} deps.execute
 *        runs the command; the guard decides whether it is ever called
 * @param {(req: {tool: string, args: object}) => Promise<object|null>} [deps.preview]
 *        renders the action without performing it
 * @param {(decision: object) => Promise<boolean>} [deps.confirmHuman]
 * @param {(auditId: string, outcome: string, evidenceRef?: string) => Promise<unknown>} [deps.recordOutcome]
 * @param {object} [deps.env]
 * @param {object} [deps.options]  { autoExecuteOnWarn?: boolean }
 */
export function createGuard(deps) {
  const { caller, check, readSnapshot, execute } = deps
  if (!caller) throw new GuardConfigError('caller required')
  for (const [name, fn] of Object.entries({ check, readSnapshot, execute })) {
    if (typeof fn !== 'function') throw new GuardConfigError(`${name} must be a function`)
  }

  const env = deps.env ?? {}
  const preview = deps.preview
  const recordOutcome = deps.recordOutcome ?? (async () => undefined)
  // Auto-execute defaults OFF. An explicit true is the user's own decision, and it still
  // only ever applies to a WARN.
  const autoExecuteOnWarn = deps.options?.autoExecuteOnWarn === true
  const confirmHuman = deps.confirmHuman ?? (async () => false)

  assertNoAmbientLiveWrite(caller, env)

  /** The env handed to a single approved command. Never persisted, never exported. */
  function grantEnvOnce() {
    if (!caller.liveWriteEnvVar) return { ...env }
    return { ...env, [caller.liveWriteEnvVar]: '1' }
  }

  async function run(request) {
    const { tool, args = {} } = request ?? {}
    if (!tool) throw new GuardConfigError('tool required')

    // Reads pass through untouched: they are free, and blocking them would break the very
    // snapshot the check depends on.
    if (classifyTool(caller, tool) === 'read') {
      return { guarded: false, kind: 'read', result: await execute({ tool, args, env }) }
    }

    // A caller-supplied snapshot is ignored on purpose. If the agent could author it, it
    // could buy an ALLOW by understating its exposure.
    if (args.snapshot !== undefined) {
      delete args.snapshot
    }

    const rendered = preview ? await preview({ tool, args }) : (request.preview ?? null)
    const intent = intentFromPreview(tool, rendered)
    if (!intent) {
      const decision = {
        verdict: 'DENY',
        reasons: [
          `Could not render "${tool}" into a checkable action, so it was refused rather than guessed at.`,
        ],
        codes: ['PREVIEW_UNREADABLE'],
      }
      return { guarded: true, executed: false, decision, disclosure: DISCLOSURE }
    }

    const snapshot = await readSnapshot()
    const decision = await check({ intent, snapshot })
    const verdict = decision?.verdict

    if (verdict === 'DENY') {
      // Final. Recorded as blocked, and there is no branch below this that can execute.
      await recordOutcome(decision.auditId, 'blocked')
      return { guarded: true, executed: false, decision, intent, disclosure: DISCLOSURE }
    }

    if (verdict === 'WARN') {
      const approved = autoExecuteOnWarn ? true : await confirmHuman(decision)
      if (!approved) {
        await recordOutcome(decision.auditId, 'awaiting_human')
        return {
          guarded: true,
          executed: false,
          awaitingHuman: true,
          decision,
          intent,
          disclosure: DISCLOSURE,
        }
      }
      const result = await execute({ tool, args, env: grantEnvOnce() })
      await recordOutcome(decision.auditId, 'executed', evidenceOf(result))
      return { guarded: true, executed: true, decision, intent, result, disclosure: DISCLOSURE }
    }

    if (verdict === 'ALLOW') {
      const result = await execute({ tool, args, env: grantEnvOnce() })
      await recordOutcome(decision.auditId, 'executed', evidenceOf(result))
      return { guarded: true, executed: true, decision, intent, result, disclosure: DISCLOSURE }
    }

    // An unrecognizable verdict is a failure, and a failure is a refusal.
    const failed = {
      verdict: 'DENY',
      reasons: [`The policy service returned no usable verdict (${JSON.stringify(verdict)}), so the action was refused.`],
      codes: ['VERDICT_UNREADABLE'],
    }
    return { guarded: true, executed: false, decision: failed, intent, disclosure: DISCLOSURE }
  }

  return { run, caller, invariants: INVARIANTS }
}

/** Post-action proof, when the caller gives one. Order history is the only real evidence. */
function evidenceOf(result) {
  if (result && typeof result === 'object') {
    const ref = result.orderId ?? result.order_id ?? result.id ?? result.ref_id
    if (ref) return String(ref).slice(0, 200)
  }
  return undefined
}
