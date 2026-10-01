#!/usr/bin/env node
/**
 * Print the decoded authorization of one Stellar transaction, as JSON, for publishing beside
 * its hash.
 *
 * The authorization is the part of a Soroban transaction a reviewer most needs and can least
 * read: which address authorized the call, whether by being the transaction source or by a
 * signature of its own, and for an OpenZeppelin smart account, which signer through which
 * verifier, down to a passkey's authenticator flags, origin and the challenge it was shown.
 *
 *   node mcp/scripts/stellar-decode-auth.mjs --chain stellar-testnet --hash <hex>
 *   node mcp/scripts/stellar-decode-auth.mjs --chain stellar-testnet --hash <hex> --live
 *
 * Reads the archived copy under soroban/releases/tx-archive/ when there is one, so it works
 * offline and after a testnet reset; --live fetches from the network instead (read-only).
 * Needs `npm run build` first: it imports the decoder from mcp/dist.
 *
 * Exit codes: 0 printed, 1 the transaction could not be read, 2 bad arguments.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHAINS, txUrl } from '../dist/chains/index.js'
import { decodeTxEvidence, fetchTxEvidence } from '../dist/chains/stellar/tx-evidence.js'
import { networkPassphrase } from '../dist/chains/stellar/client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const chainArg = arg('chain')
const hash = arg('hash')?.trim().toLowerCase()
const chain = CHAINS.find((c) => c.ecosystem === 'stellar' && (c.id === chainArg || c.caip2 === chainArg))
if (!chain || !hash) {
  console.error('usage: stellar-decode-auth.mjs --chain <stellar | stellar-testnet> --hash <hex> [--live]')
  process.exit(2)
}

const archived = join(HERE, '..', '..', 'soroban', 'releases', 'tx-archive', chain.id, `${hash}.json`)
let evidence
let source
if (!argv.includes('--live') && existsSync(archived)) {
  const file = JSON.parse(readFileSync(archived, 'utf8'))
  // Decoded again from the stored XDR rather than trusting the stored decode, so a fix to the
  // decoder reaches archived transactions too.
  evidence = decodeTxEvidence(file.envelopeXdr, file.resultXdr, file.resultMetaXdr, networkPassphrase(chain), { chain })
  source = `archive (${file.fetchedFrom}, archived ${file.archivedAt})`
} else {
  const r = await fetchTxEvidence(chain, hash)
  if (!r.ok) {
    console.error(`${r.code}: ${r.reason}`)
    process.exit(1)
  }
  evidence = r.evidence
  source = `live (${r.record.fetchedFrom})`
}

console.log(
  JSON.stringify(
    {
      hash: evidence.hash,
      network: chain.caip2,
      explorer: txUrl(chain, evidence.hash),
      source,
      status: evidence.status,
      sourceAccount: evidence.sourceAccount,
      feeAccount: evidence.feeAccount,
      feeBump: evidence.feeBump,
      auth: evidence.auth,
      summary: evidence.summary,
      caveats: evidence.caveats,
    },
    null,
    2,
  ),
)
