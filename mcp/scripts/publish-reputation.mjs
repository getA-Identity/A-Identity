#!/usr/bin/env node
/**
 * A1 — publish an agent's reputation on-chain as an ERC-8004 feedback attestation, against
 * real Arc testnet. Writes `giveFeedback` on the Arc ReputationRegistry from a dedicated
 * A-Identity ORACLE VALIDATOR wallet (per ERC-8004 the validator must differ from the agent
 * owner), so the deterministic 0-1000 score is anchored on-chain and independently verifiable.
 *
 * The score is NOT invented here — pass the live value (from the deployed reputation_score /
 * the public resolver) via --score, so the anchor matches what the tools return.
 *
 * Run:
 *   node --env-file=.env scripts/publish-reputation.mjs --agent 849980 --score 541
 * Env:
 *   ARC_SIGNER_KEY     required — the funded owner wallet (funds the validator's gas)
 *   ARC_VALIDATOR_KEY  optional — the oracle validator. If unset, a fresh one is generated
 *                      and printed; SAVE it and set ARC_VALIDATOR_KEY to reuse the same
 *                      validator identity for every future attestation.
 *
 * After it prints the attestation record, paste that object into
 * `src/asp/attestations.ts` (ATTESTATIONS), rebuild, and deploy.
 */
import { createPublicClient, createWalletClient, http, fallback, defineChain, parseEther, keccak256, toHex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

// ── args ──────────────────────────────────────────────────────────────────────────
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const AGENT_ID = BigInt(arg('agent', '849980').replace(/^#/, ''))
const SCORE = Number(arg('score', ''))
if (!Number.isFinite(SCORE) || SCORE < 0 || SCORE > 1000) {
  console.error('error: pass the live 0-1000 score, e.g. --score 541')
  process.exit(1)
}
const TAG = arg('tag', 'a-identity:reputation:v1')
const EVIDENCE_URI = arg('evidence', 'https://a-identity-asp.onrender.com/methodology')

// ── chain + contracts (Arc testnet) ─────────────────────────────────────────────────
const ARC_RPCS = [
  'https://rpc.testnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
]
// Fallback across every Arc RPC so one rate-limited/flaky endpoint rolls to the next.
const arcTransport = fallback(ARC_RPCS.map((u) => http(u, { timeout: 8000, retryCount: 3, retryDelay: 500 })))
const ARC = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ARC_RPCS } },
})
const EXPLORER = 'https://explorer.testnet.arc.io'
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'
const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713'
const OWNER_OF_ABI = [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] }]
const GIVE_FEEDBACK_ABI = [{
  type: 'function', name: 'giveFeedback', stateMutability: 'nonpayable', inputs: [
    { name: 'agentId', type: 'uint256' }, { name: 'score', type: 'int128' }, { name: 'tag1', type: 'uint8' },
    { name: 'tag2', type: 'string' }, { name: 'endpointUri', type: 'string' }, { name: 'fileUri', type: 'string' },
    { name: 'fileType', type: 'string' }, { name: 'feedbackHash', type: 'bytes32' },
  ], outputs: [],
}]

const norm = (k) => (k?.startsWith('0x') ? k : `0x${k}`)
const ownerKey = process.env.ARC_SIGNER_KEY
if (!ownerKey) { console.error('error: ARC_SIGNER_KEY not set'); process.exit(1) }
const owner = privateKeyToAccount(norm(ownerKey))

// Validator: reuse ARC_VALIDATOR_KEY, or mint a fresh oracle-validator identity.
let validatorKey = process.env.ARC_VALIDATOR_KEY
let minted = false
if (!validatorKey) { validatorKey = generatePrivateKey(); minted = true }
const validator = privateKeyToAccount(norm(validatorKey))

const pub = createPublicClient({ chain: ARC, transport: arcTransport })
const ownerWallet = createWalletClient({ account: owner, chain: ARC, transport: arcTransport })
const validatorWallet = createWalletClient({ account: validator, chain: ARC, transport: arcTransport })

console.log('agent            :', `#${AGENT_ID}`)
console.log('score            :', `${SCORE}/1000`)
console.log('owner  (signer)  :', owner.address)
console.log('validator (oracle):', validator.address, minted ? '(NEWLY MINTED — save the key below!)' : '')
if (minted) console.log('ARC_VALIDATOR_KEY:', validatorKey, '\n')

// Guard: ERC-8004 forbids self-attestation.
const onchainOwner = await pub.readContract({ address: IDENTITY_REGISTRY, abi: OWNER_OF_ABI, functionName: 'ownerOf', args: [AGENT_ID] })
if (onchainOwner.toLowerCase() === validator.address.toLowerCase()) {
  console.error(`error: the validator ${validator.address} OWNS agent #${AGENT_ID}; ERC-8004 forbids self-attestation. Use a different ARC_VALIDATOR_KEY.`)
  process.exit(1)
}
console.log('owner(onchain)   :', onchainOwner, '(distinct from validator ✓)\n')

// Fund the validator's gas (Arc gas is native USDC) if it is short.
const bal = await pub.getBalance({ address: validator.address })
const MIN = parseEther('0.05')
if (bal < MIN) {
  const topUp = parseEther('0.1')
  console.log(`funding validator gas: sending ${Number(topUp) / 1e18} USDC (native) from owner...`)
  const fundTx = await ownerWallet.sendTransaction({ to: validator.address, value: topUp })
  await pub.waitForTransactionReceipt({ hash: fundTx })
  console.log('  funded:', `${EXPLORER}/tx/${fundTx}`, '\n')
} else {
  console.log('validator gas ok :', `${Number(bal) / 1e18} USDC\n`)
}

// Write the attestation. Score normalized to the ERC-8004 0-100 convention; the raw 0-1000
// value + tag are committed in the feedback hash.
const score100 = Math.max(0, Math.min(100, Math.round(SCORE / 10)))
const feedbackHash = keccak256(toHex(`a-identity:rep:${AGENT_ID}:${SCORE}:${TAG}`))
console.log(`writing giveFeedback(${AGENT_ID}, ${score100}/100, tag="${TAG}")...`)
const txHash = await validatorWallet.writeContract({
  address: REPUTATION_REGISTRY, abi: GIVE_FEEDBACK_ABI, functionName: 'giveFeedback',
  args: [AGENT_ID, BigInt(score100), 0, TAG, EVIDENCE_URI, '', '', feedbackHash],
})
await pub.waitForTransactionReceipt({ hash: txHash })
const txUrl = `${EXPLORER}/tx/${txHash}`
console.log('  attested:', txUrl, '\n')

// Print the record to paste into src/asp/attestations.ts (ATTESTATIONS).
const record = {
  tokenId: AGENT_ID.toString(),
  agentName: 'Meridian',
  score: SCORE,
  score100,
  tag: TAG,
  chain: 'arc-testnet',
  registry: REPUTATION_REGISTRY,
  validator: validator.address,
  txHash,
  txUrl,
  feedbackHash,
  attestedAt: new Date().toISOString(),
}
console.log('=== paste into src/asp/attestations.ts ATTESTATIONS[] ===')
console.log(JSON.stringify(record, null, 2) + ',')
