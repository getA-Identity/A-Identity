/**
 * Instruction route group (split from http.ts): create/list payment instructions,
 * approve, reject, execute. Handlers return true when the request was handled;
 * order within this file mirrors the original http.ts order.
 */
import {
  createInstruction, listInstructions, listInstructionsForOwner,
  approveInstruction, rejectInstruction, executeInstruction, type InstructionType,
} from '../platform.js'
import { denyRead, errStatus, readBody, sendJson, validAmount, type RouteCtx } from './shared.js'

export async function handleInstructionRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, callerId } = ctx

  // ── Platform: instructions (pay / purchase / rental / batch) ─────────────────
  if (req.method === 'POST' && url.pathname === '/api/instructions') {
    const body = (await readBody(req).catch(() => null)) as {
      agentId?: string; type?: InstructionType; amountUsd?: number
      count?: number; payee?: string; memo?: string
    } | null
    if (!body?.agentId || !body?.type || !body?.payee) {
      sendJson(res, 400, { error: 'agentId, type, amountUsd, payee required' }); return true
    }
    if (!validAmount(body.amountUsd)) {
      // Reject negative/NaN/Infinity here: a negative amount would otherwise subtract from
      // the agent's daily spend, letting an owner rewind their own safety cap.
      sendJson(res, 400, { error: 'amountUsd must be a finite number between 0 and 1000000' }); return true
    }
    if (body.count !== undefined && !(Number.isFinite(body.count) && body.count! >= 1 && body.count! <= 1000)) {
      sendJson(res, 400, { error: 'count must be an integer between 1 and 1000' }); return true
    }
    const ix = createInstruction({ ...body, caller: callerId } as never)
    sendJson(res, 'error' in ix ? errStatus(ix.error) : 201, ix)
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/instructions') {
    // Owner-scoped: a specific agentId is gated to its owner; without one, return only
    // the caller's own agents' payment history (never everyone's).
    const agentId = url.searchParams.get('agentId') ?? undefined
    if (agentId) {
      if (denyRead(res, agentId, callerId)) return true
      sendJson(res, 200, { instructions: listInstructions(agentId) })
    } else {
      sendJson(res, 200, { instructions: listInstructionsForOwner(callerId) })
    }
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/instructions/approve') {
    const body = (await readBody(req).catch(() => null)) as { id?: string } | null
    if (!body?.id) { sendJson(res, 400, { error: 'id required' }); return true }
    const ix = approveInstruction(body.id, callerId)
    sendJson(res, 'error' in ix ? errStatus(ix.error) : 200, ix)
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/instructions/reject') {
    const body = (await readBody(req).catch(() => null)) as { id?: string; reason?: string } | null
    if (!body?.id) { sendJson(res, 400, { error: 'id required' }); return true }
    const ix = rejectInstruction(body.id, callerId, body.reason)
    sendJson(res, 'error' in ix ? errStatus(ix.error) : 200, ix)
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/instructions/execute') {
    const body = (await readBody(req).catch(() => null)) as { id?: string } | null
    if (!body?.id) { sendJson(res, 400, { error: 'id required' }); return true }
    const ix = await executeInstruction(body.id, callerId)
    sendJson(res, 'error' in ix ? errStatus(ix.error) : 200, ix)
    return true
  }

  return false
}
