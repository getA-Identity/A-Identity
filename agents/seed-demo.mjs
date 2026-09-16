/**
 * Seed the marketplace with real activity for a demo: one verified worker takes many jobs and
 * gets paid, so the catalog shows real ratings/completions and (with a funded signer on the
 * backend) each release is a real ERC-8183 escrow settlement on Arc with an arcscan link.
 *
 * Run it against the LIVE backend (which holds ARC_SIGNER_KEY) so releases settle on-chain:
 *   BASE=https://a-identity-backend.onrender.com SEED_CYCLES=20 node agents/seed-demo.mjs
 * Or against a local server started with the key (node --env-file=.env dist/http.js).
 *
 * Each cycle spends a small escrow budget from the backend's shared testnet signer. It prints a
 * table of created tasks + any on-chain job/tx so you can drop the arcscan links into the deck.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { MarketplaceClient } from '../sdk/dist/index.js'
import { registerWorker, processFundedTasks } from './translator.mjs'

const base = process.env.BASE ?? 'https://a-identity-backend.onrender.com'
const cycles = Math.min(Math.max(Number(process.env.SEED_CYCLES ?? 20), 1), 100)
const EXPLORER = 'https://explorer.testnet.arc.io'

const PROMPTS = [
  'Translate "The agent economy is here" to French',
  'Translate "Verify first, hire at machine speed" to Spanish',
  'Translate "Settle in USDC on Arc" to German',
  'Translate "Bounded authority, no human in the loop" to Turkish',
  'Translate "Every payment is auditable on-chain" to Italian',
]

async function main() {
  console.log(`\nSeeding the marketplace: ${cycles} job cycles against ${base}\n`)

  // One verified worker takes every job (builds real reputation + completed count).
  const worker = privateKeyToAccount(generatePrivateKey())
  const mpWorker = await MarketplaceClient.withWallet({ baseUrl: base, address: worker.address, signMessage: (m) => worker.signMessage({ message: m }) })
  const reg = await registerWorker(mpWorker, worker)
  const workerId = reg.agent.id
  console.log(`worker: ${workerId}  (KYA ${reg.kya?.kya})  wallet ${worker.address}\n`)

  const rows = []
  for (let i = 0; i < cycles; i++) {
    try {
      const client = privateKeyToAccount(generatePrivateKey())
      const mpClient = await MarketplaceClient.withWallet({ baseUrl: base, address: client.address, signMessage: (m) => client.signMessage({ message: m }) })
      const task = await mpClient.hire({ agentId: workerId, service: 'translation', priceUsd: 2, description: PROMPTS[i % PROMPTS.length] })
      await processFundedTasks(mpWorker, workerId) // worker delivers
      const rating = 4 + (i % 2) // 4 or 5 stars
      const released = await mpClient.release(task.id, { rating, review: 'delivered on time' })
      rows.push({ i: i + 1, taskId: released.id, status: released.status, settlement: released.settlement ?? '-', jobId: released.jobId ?? '-', releaseTx: released.releaseTx ?? '' })
      process.stdout.write(`  cycle ${i + 1}/${cycles}: ${released.status} (${released.settlement ?? '-'})${released.releaseTx ? ` tx ${released.releaseTx.slice(0, 12)}...` : ''}\n`)
    } catch (e) {
      process.stdout.write(`  cycle ${i + 1}/${cycles}: error ${e?.message ?? e}\n`)
    }
  }

  const onchain = rows.filter((r) => r.settlement === 'onchain')
  console.log(`\nDone. ${rows.length} jobs, ${onchain.length} settled on-chain.\n`)
  if (onchain.length) {
    console.log('On-chain proof (arcscan):')
    for (const r of onchain.slice(0, 8)) {
      if (r.releaseTx) console.log(`  job ${r.jobId}: ${EXPLORER}/tx/${r.releaseTx}`)
    }
  } else {
    console.log('No on-chain settlements: the backend has no funded ARC_SIGNER_KEY, so releases were simulated (honest, no fake tx). Run against the live backend or a local server started with the key for real arcscan links.')
  }
  console.log(`\nCatalog now shows this worker with ${rows.filter((r) => r.status === 'released').length} completed jobs. See it at ${base}/api/marketplace/catalog\n`)
}

main().catch((e) => {
  console.error('seed failed:', e)
  process.exit(1)
})
