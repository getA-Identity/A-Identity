#!/usr/bin/env node
/**
 * What TrionLabs Stellar 8004 actually says today, on both networks, read-only.
 *
 * This exists because three of the numbers this repo cites about that registry are somebody
 * else's live state and will move without telling us: its version, how many agents it holds,
 * who owns it, and whether an upgrade is sitting in its timelock. A comment claiming any of
 * them is a claim with no expiry date. This is the expiry date.
 *
 * It also answers the one question standing between us and a mainnet registration. On
 * 2026-09-09 a register_with_uri SIMULATION reported the pubnet Identity registry's instance
 * and code entries archived, with a 36.64 XLM restore in the footprint: the next writer pays
 * to bring Trion's contract back, and that writer was going to be us. So the script simulates
 * that exact call again and reports the fee. Under 1 XLM with nothing archived means the
 * registry has been restored and a human can finish this in a minute; it prints the command.
 *
 * Archived state is read from BOTH places it can show up. A restore preamble was the only one
 * before protocol 23. Since CAP-0066 the RPC sends no preamble and lists the archived
 * footprint entries in the transaction data instead, with the rent folded into the fee, so a
 * reader of the preamble alone calls a cold registry warm. The reads above the price use the
 * same check, through stellar8004Simulate, and print ARCHIVED when it fires.
 *
 * SIMULATES. Never signs, never submits, holds no key. A simulation costs nothing and
 * touches nothing, which is why this can be run by anyone, any time.
 *
 *   node mcp/scripts/stellar-8004-check.mjs
 *
 * Exits 0 whether the news is good or bad. It reports; it does not gate.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk'

import { addressUrl } from '../dist/chains/explorer.js'
import { networkPassphrase, simulationArchivedEntries, sorobanServer } from '../dist/chains/stellar/client.js'
import {
  A_IDENTITY_TESTNET_AGENT_ID,
  readStellar8004Agent,
  stellar8004Chains,
  stellar8004Simulate,
} from '../dist/chains/stellar/stellar8004.js'

/**
 * The key that made our TESTNET registration on 2026-09-08 (tx 6070127842948b6a...).
 * A PUBLIC key, asserted rather than read from anywhere, because the point of the check is
 * to catch the day find_owner stops agreeing with it.
 */
const TESTNET_OWNER = 'GBMF7MDHLF6E5GWNCUJZKDBID5LCU5U5K7J26MRUJCM2FK7J7VZXTZZ3'

/**
 * The dedicated mainnet identity key (CLI alias aid-8004-identity), funded with 3 XLM and
 * otherwise unused. Public key only: this script never holds the secret and never signs.
 */
const PUBNET_CALLER = 'GD6YPJKGJKRDS7JDY3EF7XTITIESVKFSSNNPBRO42FXC4ZOIVDML3XQQ'

/** Short and updatable, which is why the mainnet registration points at a URL and not a data: URI. */
const AGENT_URI = 'https://a-identity.xyz/.well-known/stellar-8004.json'

const XLM = (stroops) => Number(stroops) / 1e7
const fmt = (v) => (v === null || v === undefined ? '(none)' : typeof v === 'object' ? JSON.stringify(v) : String(v))

let exitNote = ''

for (const chain of stellar8004Chains()) {
  const registry = chain.contracts.stellar8004.identity
  console.log(`\n=== ${chain.name} (${chain.caip2}) ===`)
  console.log(`Identity registry  ${registry}`)
  console.log(`Explorer           ${addressUrl(chain, registry)}`)

  const simulate = stellar8004Simulate(chain, process.env)
  const one = async (method) => {
    const r = await simulate(registry, method, [])
    if (r.status === 'ok') return { ok: true, value: scValToNative(r.retval) }
    if (r.status === 'restore') return { ok: false, why: `ARCHIVED (${r.reason})` }
    return { ok: false, why: `unreadable (${r.error})` }
  }

  for (const method of ['version', 'total_agents', 'get_owner', 'pending_upgrade']) {
    const r = await one(method)
    console.log(`  ${method.padEnd(16)} ${r.ok ? fmt(r.value) : r.why}`)
  }

  // Our own registration, but only where we have one. On pubnet we deliberately have none,
  // and the simulation below is the reason.
  if (chain.testnet) {
    const read = await readStellar8004Agent(chain, A_IDENTITY_TESTNET_AGENT_ID, { env: process.env })
    if (!read.readable) {
      console.log(`  agent ${A_IDENTITY_TESTNET_AGENT_ID}: NOT READABLE (${read.reason}) ${read.detail}`)
      exitNote += `testnet agent ${A_IDENTITY_TESTNET_AGENT_ID} unreadable; `
    } else if (!read.found) {
      console.log(`  agent ${A_IDENTITY_TESTNET_AGENT_ID}: GONE. ${read.reason}`)
      exitNote += `testnet agent ${A_IDENTITY_TESTNET_AGENT_ID} is gone (testnet reset?); `
    } else {
      const match = read.agent.owner === TESTNET_OWNER
      console.log(`  agent ${A_IDENTITY_TESTNET_AGENT_ID} label   ${read.label}`)
      console.log(`  agent owner      ${fmt(read.agent.owner)} ${match ? 'MATCHES the key that registered it' : `DOES NOT MATCH ${TESTNET_OWNER}`}`)
      console.log(`  agent wallet     ${fmt(read.agent.wallet)}`)
      console.log(`  agent_uri        ${read.agent.agentUriKind} (${String(read.agent.agentUri).slice(0, 60)}...)`)
      console.log(`  registration     ${read.agent.registration ? fmt(read.agent.registration.name) : '(did not parse)'}`)
      if (!match) exitNote += 'testnet find_owner no longer matches our key; '
    }
  }
}

// -- the pubnet registration, simulated and never sent ------------------------------

const pubnet = stellar8004Chains().find((c) => !c.testnet)
if (!pubnet) {
  console.log('\nNo pubnet Stellar 8004 descriptor, so there is nothing to simulate.')
  process.exit(0)
}

const registry = pubnet.contracts.stellar8004.identity
console.log(`\n=== pubnet register_with_uri, SIMULATED (nothing is signed or sent) ===`)
console.log(`caller     ${PUBNET_CALLER}`)
console.log(`agent_uri  ${AGENT_URI}`)

try {
  const server = sorobanServer(pubnet, process.env)
  // The real account, because the task is to price a real submission from it. A simulation
  // does not check the sequence, but using the account that would actually send keeps the
  // footprint honest.
  let source
  try {
    source = await server.getAccount(PUBNET_CALLER)
  } catch (e) {
    console.log(`account lookup failed (${e instanceof Error ? e.message : String(e)}); simulating with sequence 0`)
    source = new Account(PUBNET_CALLER, '0')
  }
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: networkPassphrase(pubnet) })
    .addOperation(
      new Contract(registry).call(
        'register_with_uri',
        new Address(PUBNET_CALLER).toScVal(),
        nativeToScVal(AGENT_URI, { type: 'string' }),
      ),
    )
    .setTimeout(60)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    console.log(`SIMULATION REFUSED: ${sim.error}`)
    console.log('Nothing to price: the contract said no before cost entered into it.')
    process.exit(0)
  }

  const callFee = Number(sim.minResourceFee ?? 0)
  const restore = rpc.Api.isSimulationRestore(sim) ? sim.restorePreamble : null
  const restoreFee = restore ? Number(restore.minResourceFee ?? 0) : 0
  const total = callFee + restoreFee
  // The field that actually says whether the registry is cold since CAP-0066: the archived
  // footprint indexes, listed in the transaction data rather than sent as a preamble.
  const archived = simulationArchivedEntries(sim)

  console.log(`separate restore preamble   ${restore ? 'YES, the registry instance or code is ARCHIVED' : 'no'}`)
  console.log(
    `archived footprint entries  ${archived.length ? `${archived.join(', ')}, restored inside the call with the rent folded into the fee` : 'none'}`,
  )
  console.log(`call minResourceFee         ${XLM(callFee).toFixed(7)} XLM (${callFee} stroops)`)
  if (restore) console.log(`restore minResourceFee      ${XLM(restoreFee).toFixed(7)} XLM (${restoreFee} stroops)`)
  console.log(`total to submit             ${XLM(total).toFixed(7)} XLM`)

  if (XLM(total) < 1 && archived.length === 0 && !restore) {
    console.log('\nUNDER 1 XLM AND NOTHING ARCHIVED. The registry is live and the registration is a one-command job.')
    console.log('Run this by hand, with the secret for the aid-8004-identity alias in the CLI:\n')
    console.log(
      `  stellar contract invoke --network mainnet --source aid-8004-identity --inclusion-fee 100000 \\\n` +
        `    --id ${registry} -- register_with_uri \\\n` +
        `    --caller ${PUBNET_CALLER} --agent_uri ${AGENT_URI}`,
    )
  } else {
    console.log(
      `\nStill blocked, and no registration is claimed anywhere. ` +
        `Submitting would pay ${XLM(total).toFixed(2)} XLM, most of it rent to restore somebody else's contract. ` +
        `Restoring is permissionless, so waiting is a choice rather than a lock: the clean fix is Trion's, ` +
        `their registry owner extending its TTL or restoring it once.`,
    )
  }
} catch (e) {
  console.log(`could not simulate: ${e instanceof Error ? e.message : String(e)}`)
  exitNote += 'pubnet simulation did not run; '
}

if (exitNote) console.log(`\nNote: ${exitNote}`)
console.log('\nRead-only run. Nothing was signed and nothing was submitted.')
process.exit(0)
