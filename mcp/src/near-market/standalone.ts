// The NEAR AI Agent Market worker on its own, without the HTTP server, for a host that runs
// nothing else (the team's VPS). It reads the same environment as the server: MARKET_NEAR_AI_TOKEN
// (required; without it the worker logs that it is off and this process exits 0) and the optional
// NEAR RPC overrides. Run it from mcp/ after `npm run build`: node dist/near-market/standalone.js
import { startNearMarketWorker } from './worker.js'

const handle = startNearMarketWorker(process.env)
if (handle === null) process.exit(0)

// The worker's poll timers are unref'd so they never hold the HTTP server open on shutdown; here
// nothing else keeps the event loop alive, so this interval does, until a signal stops it.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(keepAlive)
    handle.stop()
    process.exit(0)
  })
}
