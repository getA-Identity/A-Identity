/**
 * Arc Acceleration Season route group: the progress report Circle judges Deliverable 2 on, and
 * the owner-held vault list it counts. A thin adapter: every counting rule lives in
 * ../arc-season.ts and every admission rule in ../arc-owner-vault.ts and
 * ../arc-owner-vault-live.ts, where they are unit-tested, and this file adds only the real
 * loaders.
 *
 * Its own group rather than a line in arc-routes.ts because that file is the on-chain demo
 * surface (register, jobs, swaps, session keys), and this is evidence about the program,
 * unauthenticated, which should stay visibly apart from anything that spends. Its one POST
 * signs and sends nothing: it reads a deploy from the chain and records it if every check holds.
 */
import { admitVaultDeploy, listAdmittedVaults, liveVaultAdmissionDeps } from '../arc-owner-vault-live.js'
import { arcSeasonReport, labelOwners, liveArcSeasonDeps } from '../arc-season.js'
import { vaultSweepStatus } from '../arc-vault-sweep.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

export async function handleArcSeasonRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx

  // ── GET /api/arc/season: progress against each success metric, counted on every read ──
  if (req.method === 'GET' && url.pathname === '/api/arc/season') {
    // Counted fresh per request and meant to be linked from a deliverable, so a cache in
    // front of it would serve a number the logs no longer agree with.
    res.setHeader('Cache-Control', 'no-store')
    sendJson(res, 200, await arcSeasonReport(liveArcSeasonDeps()))
    return true
  }

  // ── POST /api/arc/vaults: admit one vault by its deploy transaction, or refuse with reasons ──
  // Public on purpose: the wallet that deployed is the proof, and the server reads it from the
  // chain itself. Bounded by the arc-vault-admit bucket in rate-budget.ts.
  if (req.method === 'POST' && url.pathname === '/api/arc/vaults') {
    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      sendJson(res, 400, { status: 'invalid', reason: 'the body is not JSON' })
      return true
    }
    res.setHeader('Cache-Control', 'no-store')
    const { httpStatus, answer } = await admitVaultDeploy(body, liveVaultAdmissionDeps())
    sendJson(res, httpStatus, answer)
    return true
  }

  // ── GET /api/arc/vaults: the vaults admitted, whether it can admit right now, and what the sweep last did ──
  if (req.method === 'GET' && url.pathname === '/api/arc/vaults') {
    res.setHeader('Cache-Control', 'no-store')
    const { httpStatus, body } = await listAdmittedVaults(process.env, {}, labelOwners)
    sendJson(res, httpStatus, { ...body, sweep: vaultSweepStatus() })
    return true
  }

  return false
}
