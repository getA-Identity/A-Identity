#!/usr/bin/env node
/**
 * Where Celo agent #9759 stands with Aigora, read-only.
 *
 * Aigora (aigora.org) lists a Celo agent when the document its tokenURI points at says
 * "onAigora": true. Ours is public/.well-known/celo-8004.json. This reads, live:
 *
 *   1. ownerOf(9759) and tokenURI(9759) on Celo's IdentityRegistry,
 *   2. the document served at CELO_8004_URI, checked against Aigora's blocking rules,
 *
 * and, while the tokenURI still points elsewhere, prints the one setAgentURI call the owner
 * wallet has to sign: its target, its calldata and a cast line. It holds no key, signs nothing
 * and sends nothing. The owner runs the printed line in their own terminal, from their own
 * keystore. Afterwards the provenance ledger's tokenUri for Celo is updated to match the chain.
 *
 *   cd mcp && npm run build && node scripts/celo-8004-aigora.mjs
 *
 * Exits 1 only when the served document would not list, so it can gate a deploy; otherwise 0.
 */
import { createPublicClient, http } from 'viem'

import {
  CELO_8004_URI,
  aigoraRegistrationIssues,
  celoAgentId,
  celoChain,
  setAgentUriCall,
} from '../dist/chains/celo-8004.js'
import { provenanceFor } from '../dist/chains/provenance.js'
import { isRetired } from '../dist/chains/retired.js'

const READ_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] },
]

const chain = celoChain()
const agentId = celoAgentId()
const registry = chain.contracts.identityRegistry
const client = createPublicClient({ transport: http(process.env[chain.rpcEnvVar] || chain.rpcUrls[0]) })

console.log(`${chain.name} (${chain.caip2}) agent #${agentId}`)
console.log(`IdentityRegistry  ${registry}`)

const read = (functionName) =>
  client.readContract({ address: registry, abi: READ_ABI, functionName, args: [BigInt(agentId)] }).then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, v: e instanceof Error ? e.message.split('\n')[0] : String(e) }),
  )
const [owner, tokenUri] = await Promise.all([read('ownerOf'), read('tokenURI')])

const ledgerOwner = provenanceFor('celo')?.agent?.owner
console.log(`owner (live)      ${owner.v}`)
if (owner.ok) {
  if (isRetired(owner.v)) console.log('                  RETIRED: never sign from or fund this wallet')
  else if (ledgerOwner && owner.v.toLowerCase() !== ledgerOwner.toLowerCase()) {
    console.log(`                  differs from the ledger (${ledgerOwner}); find out why before signing anything`)
  }
}
console.log(`tokenURI (live)   ${tokenUri.v}`)

// The SPA rewrite answers a path with no file behind it with index.html and a 200, so a 200 is
// not proof the document is deployed. It has to parse.
let doc = null
try {
  const res = await fetch(CELO_8004_URI, { headers: { accept: 'application/json' } })
  const body = await res.text()
  let note = ''
  if (res.ok) {
    try {
      doc = JSON.parse(body)
    } catch {
      note = ' but not JSON (the SPA shell answered: not deployed yet?)'
    }
  }
  console.log(`\n${CELO_8004_URI} -> HTTP ${res.status}${note}`)
} catch (e) {
  console.log(`\n${CELO_8004_URI} -> unreachable (${e instanceof Error ? e.message : e})`)
}

const issues = doc === null ? ['not_served'] : aigoraRegistrationIssues(doc)
console.log(issues.length ? `Aigora rules      FAIL: ${issues.join(', ')}` : 'Aigora rules      pass')

if (tokenUri.ok && tokenUri.v === CELO_8004_URI) {
  console.log('\nDone on chain: the tokenURI already points at the registration. Aigora lists it after its next scan:')
  console.log(`https://aigora.org/services/${chain.evmChainId}_${registry.toLowerCase()}_${agentId}`)
} else if (issues.length) {
  console.log('\nNot ready: deploy a registration that passes before anyone signs setAgentURI.')
} else {
  const call = setAgentUriCall(agentId)
  console.log('\nPREPARED, not sent. The owner wallet above signs this one call (needs a little CELO for gas):')
  console.log(`to       ${call.to}`)
  console.log(`chainId  ${call.chainId}`)
  console.log(`data     ${call.data}`)
  console.log(`\n${call.cast}`)
}

process.exitCode = issues.length ? 1 : 0
