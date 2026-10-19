/**
 * Arc Acceleration Season route group: one public GET, the progress report Circle judges
 * Deliverable 2 on. A thin adapter: every counting rule lives in ../arc-season.ts, where it
 * is unit-tested with injected rows, and this file adds only the real loaders.
 *
 * Its own group rather than a line in arc-routes.ts because that file is the on-chain demo
 * surface (register, jobs, swaps, session keys), and this is evidence about the program,
 * read-only and unauthenticated, which should stay visibly apart from anything that spends.
 */
import { arcSeasonReport, liveArcSeasonDeps } from '../arc-season.js'
import { sendJson, type RouteCtx } from './shared.js'

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

  return false
}
