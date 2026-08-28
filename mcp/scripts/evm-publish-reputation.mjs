#!/usr/bin/env node
/**
 * A1 on MAINNET - publish an agent's reputation as an ERC-8004 `giveFeedback`
 * attestation on any EVM mainnet in the registry that carries the canonical
 * ReputationRegistry (Robinhood Chain, Arbitrum One, Base, Celo).
 *
 * Chain-generic sibling of publish-reputation.mjs (which stays Arc-testnet-scoped, with
 * its Arc-only gas quirks). Registry addresses come from the chain descriptor, never
 * typed here. The mainnet registry family is a different deployment from Arc's, so the
 * call shape was not assumed: the `giveFeedback` selector (0x3c036a7e) was located in the
 * mainnet implementation bytecode (EIP-1967 impl, byte-identical on Base and Arbitrum
 * One) on 2026-08-28 before this script existed.
 *
 * The validator is the SAME oracle identity used on Arc (ARC_VALIDATOR_KEY: one key, one
 * address, every EVM chain), so every attestation we ever publish traces to one
 * validator. Per ERC-8004 the validator must differ from the agent owner, and the script
 * refuses self-attestation after a live ownerOf read. Gas for the validator is fronted
 * by the chain's signer when short.
 *
 * The score is NOT invented here - pass the live value from the deployed
 * reputation_score / get_reputation surface via --score, and the basis via --tag, so the
 * anchor matches what the tools return and SAYS what it is (an identity-basis score is
 * not a settlement-history score).
 *
 * Run:
 *   node --env-file=.env scripts/evm-publish-reputation.mjs --chain rhchain --agent 0 --score 60
 *
 * After it prints the attestation record, paste that object into
 * `src/asp/attestations.ts` (ATTESTATIONS), rebuild, and deploy.
 */
import { createPublicClient, createWalletClient, http, defineChain, keccak256, toHex, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CHAIN_ID = arg('chain', '')
const AGENT_ID = BigInt(arg('agent', '-1'))
const SCORE = Number(arg('score', 'NaN'))
const TAG = arg('tag', 'a-identity:reputation:v1')
const EVIDENCE_URI = arg('evidence', 'https://a-identity.xyz/.well-known/agent-card.json')
if (AGENT_ID < 0n || !Number.isFinite(SCORE)) {
  console.error('error: --agent <tokenId> and --score <0-1000> are required')
  process.exit(1)
}

let getChainById, resolveRpcUrls
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const chain = getChainById(CHAIN_ID)
if (!chain) { console.error(`error: unknown chain '${CHAIN_ID}'`); process.exit(1) }
if (chain.ecosystem !== 'evm' || chain.testnet) { console.error(`error: ${CHAIN_ID} is not an EVM mainnet`); process.exit(1) }
const IDENTITY = chain.contracts.identityRegistry
const REPUTATION = chain.contracts.reputationRegistry
if (!IDENTITY || !REPUTATION) { console.error(`error: ${CHAIN_ID} carries no identity+reputation registry pair in the descriptor`); process.exit(1) }

const RPC = resolveRpcUrls(chain, process.env)[0]
const viemChain = defineChain({ id: chain.evmChainId, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })

const OWNER_OF_ABI = [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] }]
const GIVE_FEEDBACK_ABI = [{
  type: 'function', name: 'giveFeedback', stateMutability: 'nonpayable', inputs: [
    { name: 'agentId', type: 'uint256' }, { name: 'score', type: 'int128' }, { name: 'tag1', type: 'uint8' },
    { name: 'tag2', type: 'string' }, { name: 'endpointUri', type: 'string' }, { name: 'fileUri', type: 'string' },
    { name: 'fileType', type: 'string' }, { name: 'feedbackHash', type: 'bytes32' },
  ], outputs: [],
}]

const norm = (k) => (k?.startsWith('0x') ? k : `0x${k}`)
const ownerKey = chain.signerEnvVar ? process.env[chain.signerEnvVar] : undefined
if (!ownerKey) { console.error(`error: ${chain.signerEnvVar} not set (funds the validator's gas)`); process.exit(1) }
const funder = privateKeyToAccount(norm(ownerKey))
const validatorKey = process.env.ARC_VALIDATOR_KEY
if (!validatorKey) { console.error('error: ARC_VALIDATOR_KEY not set; the oracle identity must stay ONE identity across chains, so this script never mints a fresh one') ; process.exit(1) }
const validator = privateKeyToAccount(norm(validatorKey))
const funderWallet = createWalletClient({ account: funder, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })
const validatorWallet = createWalletClient({ account: validator, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })

console.log('chain             :', `${chain.name} (${chain.caip2})`)
console.log('agent             :', `#${AGENT_ID}`)
console.log('score             :', `${SCORE}/1000`)
console.log('validator (oracle):', validator.address)

// Guard: ERC-8004 forbids self-attestation.
const onchainOwner = await pub.readContract({ address: IDENTITY, abi: OWNER_OF_ABI, functionName: 'ownerOf', args: [AGENT_ID] })
if (onchainOwner.toLowerCase() === validator.address.toLowerCase()) {
  console.error(`error: the validator OWNS agent #${AGENT_ID}; ERC-8004 forbids self-attestation.`)
  process.exit(1)
}
console.log('owner (onchain)   :', onchainOwner, '(distinct from validator)')

// Front the validator's gas from the chain signer if it is short. Dust: these L2 writes
// cost well under a cent; the floor is sized to one attestation, not a balance.
const bal = await pub.getBalance({ address: validator.address })
const MIN = parseEther('0.00002')
if (bal < MIN) {
  const topUp = parseEther('0.00005')
  const fundTx = await funderWallet.sendTransaction({ to: validator.address, value: topUp })
  await pub.waitForTransactionReceipt({ hash: fundTx, timeout: 180_000 })
  console.log('validator funded  :', `${chain.explorer}/tx/${fundTx}`)
} else {
  console.log('validator gas ok  :', bal.toString(), 'wei')
}

// Write the attestation. Score normalized to the ERC-8004 0-100 convention; the raw
// 0-1000 value + tag are committed in the feedback hash.
const score100 = Math.max(0, Math.min(100, Math.round(SCORE / 10)))
const feedbackHash = keccak256(toHex(`a-identity:rep:${AGENT_ID}:${SCORE}:${TAG}`))
console.log(`writing giveFeedback(${AGENT_ID}, ${score100}/100, tag="${TAG}")...`)
const txHash = await validatorWallet.writeContract({
  address: REPUTATION, abi: GIVE_FEEDBACK_ABI, functionName: 'giveFeedback',
  args: [AGENT_ID, BigInt(score100), 0, TAG, EVIDENCE_URI, '', '', feedbackHash],
})
const rec = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 })
if (rec.status !== 'success') { console.error(`error: giveFeedback reverted (${chain.explorer}/tx/${txHash})`); process.exit(1) }
const txUrl = `${chain.explorer}/tx/${txHash}`
console.log('attested          :', txUrl, `(block ${rec.blockNumber}, ${rec.gasUsed} gas)`)

const record = {
  tokenId: AGENT_ID.toString(),
  score: SCORE,
  score100,
  tag: TAG,
  chain: chain.id,
  registry: REPUTATION,
  validator: validator.address,
  txHash,
  txUrl,
  feedbackHash,
  attestedAt: new Date().toISOString(),
}
console.log('=== paste into src/asp/attestations.ts ATTESTATIONS[] ===')
console.log(JSON.stringify(record, null, 2) + ',')
