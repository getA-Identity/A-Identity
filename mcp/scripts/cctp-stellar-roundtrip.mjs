#!/usr/bin/env node
/**
 * Drive one CCTP leg between an EVM chain and Stellar from an operator machine, through
 * the same module the backend serves (mcp/src/cctp-stellar.ts).
 *
 *   node --env-file=.env scripts/cctp-stellar-roundtrip.mjs --from arc --to stellar-testnet --amount 0.2 [--recipient G...] [--execute] [--resume <burn tx>]
 *   node --env-file=.env scripts/cctp-stellar-roundtrip.mjs --from stellar-testnet --to arc --amount 0.15 --execute
 *
 * Without --execute every step is printed prepared and nothing is broadcast. Mainnet is
 * refused unless CCTP_STELLAR_ALLOW_MAINNET=true is in the environment, and the module
 * caps the amount either way. Keys: CCTP_STELLAR_TESTNET_SECRET / CCTP_STELLAR_PUBNET_SECRET
 * for the Stellar side, CCTP_EVM_SIGNER_KEY or the chain's own signer for the EVM side.
 */
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const from = arg('from', '')
const to = arg('to', '')
const amountUsd = Number(arg('amount', '0'))
const recipient = arg('recipient', undefined)
const resumeBurnTx = arg('resume', undefined)
const execute = process.argv.includes('--execute')
if (!from || !to || !amountUsd) {
  console.error('usage: --from <chain> --to <chain> --amount <usd> [--recipient <addr>] [--execute] [--resume <burn tx>]')
  process.exit(1)
}
let bridgeCctp
try {
  ;({ bridgeCctp } = await import('../dist/cctp-stellar.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const started = Date.now()
const r = await bridgeCctp({ from, to, amountUsd, recipient, execute, resumeBurnTx, finality: 2000 })
console.log(JSON.stringify(r, null, 2))
console.log(`elapsed ${Math.round((Date.now() - started) / 1000)} s`)
process.exit('error' in r || r.reason ? 1 : 0)
