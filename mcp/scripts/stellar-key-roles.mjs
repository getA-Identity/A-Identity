#!/usr/bin/env node
/**
 * Which key wears which hat on Stellar, and where one key wears two.
 *
 * A vault is only as bounded as the separation between the accounts around it. Three roles
 * exist per network and they are meant to be three different keys:
 *
 *   owner      can withdraw the whole balance, set the policy, freeze. No `set_owner`
 *              exists, so this one is permanent (A7-02).
 *   operator   can spend inside the policy, and only inside it.
 *   fee payer  signs and pays for the x402 broadcast. Touches no vault authority at all,
 *              and is the key most exposed: it is hot on Render, it signs on every sale,
 *              and its whole job is to hold a couple of XLM.
 *
 * Today the pubnet fee payer IS the pubnet vault operator, and the testnet fee payer IS the
 * testnet vault operator. That is one key doing two jobs, and the jobs have different threat
 * models: a leaked fee payer should cost a few XLM of gas, not a key that can move the
 * vault's budget. It is a WARN rather than a FAIL because the operator is already the
 * lower-privilege half of the vault and the blast radius is bounded by the daily cap, which
 * is exactly what the cap is for.
 *
 * Fee payer == vault OWNER would be a different matter and exits 1: the owner can withdraw
 * the entire balance, so putting that key on a server to pay gas would hand the vault away.
 * It is not the state today and this script exists partly to keep it that way.
 *
 * payTo == owner is INFO, not a problem. It is where the money is meant to land.
 *
 * Read-only, and public-only. Vault roles come off the ledger by simulation; the rail roles
 * come from the backend's own status endpoints, which publish ACCOUNT ids and env var NAMES
 * and never a secret. This script reads no key material and prints none.
 *
 *   node mcp/scripts/stellar-key-roles.mjs            # warns, exits 0
 *   node mcp/scripts/stellar-key-roles.mjs --strict   # a warning exits 1
 *   BASE=http://localhost:8787 node mcp/scripts/stellar-key-roles.mjs
 */
import { CHAINS, createStellarAdapter } from '../dist/chains/index.js'

const BASE = (process.env.BASE ?? 'https://a-identity-backend.onrender.com').replace(/\/+$/, '')
const STRICT = process.argv.includes('--strict')

/**
 * The dedicated pubnet fee payer that has been generated and never funded.
 *
 * Named here because the fix for the overlap below is not "generate a key", it is "fund the
 * key that already exists". It lives in the maintainer's local CLI keystore under the alias
 * `aid-pubnet-x402-fee`. This is a PUBLIC account id; the seed is not in this repo and is
 * not read by this script.
 */
const DEDICATED_PUBNET_FEE_PAYER = 'GAFVDEN6BC52WWPRPINOVENMXW3FU4LCSVVVA5C67RLPG4GAK6BE4SXY'

/**
 * Render's free tier sleeps, and a cold start is slower than a default fetch timeout. Four
 * attempts with 15 s between them is the difference between "the backend was asleep" and
 * "the backend is down", and reporting the first as the second would make this job cry wolf
 * every Monday morning.
 */
async function getJson(path) {
  let last
  for (let i = 1; i <= 4; i += 1) {
    try {
      const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(45_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
      if (i < 4) {
        console.log(`  ${path}: attempt ${i} failed (${last}), retrying in 15s (free-tier cold start)`)
        await new Promise((r) => setTimeout(r, 15_000))
      }
    }
  }
  throw new Error(`${path} unreachable after 4 attempts: ${last}`)
}

/** Whether an account exists on this network, read from Horizon. 404 means unfunded. */
async function horizonAccount(horizonUrl, account) {
  try {
    const res = await fetch(`${horizonUrl.replace(/\/+$/, '')}/accounts/${account}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 404) return { exists: false }
    if (!res.ok) return { unknown: `HTTP ${res.status}` }
    const j = await res.json()
    const xlm = (j.balances ?? []).find((b) => b.asset_type === 'native')?.balance
    return { exists: true, xlm }
  } catch (e) {
    return { unknown: e instanceof Error ? e.message : String(e) }
  }
}

const targets = CHAINS.filter((c) => c.ecosystem === 'stellar' && c.contracts?.spendVault)
if (targets.length === 0) {
  console.error('No Stellar chain in the registry declares contracts.spendVault.')
  process.exit(2)
}

console.log(`Stellar key roles, read live from the chain and from ${BASE}`)
console.log('')

// ── The live rail status ─────────────────────────────────────────────────────────────
let x402
try {
  x402 = await getJson('/api/x402/stellar/status')
} catch (e) {
  console.error(`Could not read the x402 Stellar status: ${e instanceof Error ? e.message : e}`)
  console.error('Nothing is concluded about the rail roles. This is not an all-clear.')
  process.exit(2)
}

// payTo is a per-network answer and the unqualified endpoint returns only the primary one,
// so it is asked for by network rather than inferred from the headline.
const payToByNetwork = new Map()
for (const n of x402.networks ?? []) {
  if (!n.network) continue
  try {
    const s = await getJson(`/api/x402/stellar/status?network=${encodeURIComponent(n.network)}`)
    if (s.payTo) payToByNetwork.set(n.network, s.payTo)
  } catch (e) {
    console.log(`  payTo for ${n.network} unreadable: ${e instanceof Error ? e.message : e}`)
  }
}

// CCTP publishes a Stellar signer ADDRESS only when that side's secret is set; the EVM sides
// publish the env var name and never an address. An absent address is reported as absent.
let cctp = null
try {
  cctp = await getJson('/api/cctp/stellar/status')
} catch (e) {
  console.log(`  CCTP status unreadable (${e instanceof Error ? e.message : e}); its signers are not checked below.`)
}

const findings = []
const productionKeys = new Map()
const claim = (account, role) => {
  if (!account) return
  productionKeys.set(account, [...(productionKeys.get(account) ?? []), role])
}

for (const chain of targets) {
  const vault = chain.contracts.spendVault
  console.log(`${chain.id}  ${chain.caip2}`)
  console.log(`  vault ${vault}`)

  let state
  try {
    state = await createStellarAdapter(chain).readVault(vault, {})
  } catch (e) {
    console.log(`  could not read the vault: ${e instanceof Error ? e.message : e}`)
    console.log('')
    findings.push({ level: 'FAIL', text: `${chain.id}: the vault could not be read, so its roles are unknown.` })
    continue
  }

  const railNetwork = (x402.networks ?? []).find((n) => n.network === chain.caip2)
  const feePayer = railNetwork?.broadcast?.account ?? null
  const feePayerVar = railNetwork?.broadcast?.from ?? null
  const payTo = payToByNetwork.get(chain.caip2) ?? null
  const cctpSide = (cctp?.sides ?? []).find((s) => s.network === chain.caip2) ?? null
  const cctpSigner = cctpSide?.signer?.address ?? null

  claim(state.owner, `${chain.id} vault owner`)
  claim(state.operator, `${chain.id} vault operator`)
  claim(feePayer, `${chain.id} x402 fee payer`)
  claim(payTo, `${chain.id} x402 payTo`)

  const row = (role, account, source) =>
    console.log(`    ${role.padEnd(16)} ${(account ?? '(none)').padEnd(57)} ${source}`)
  console.log(`    ${'role'.padEnd(16)} ${'account'.padEnd(57)} source`)
  row('vault owner', state.owner, 'on-chain, vault.owner()')
  row('vault operator', state.operator, 'on-chain, vault.operator()')
  row('x402 fee payer', feePayer, feePayerVar ? `live, ${feePayerVar}` : 'live, not configured')
  row('x402 payTo', payTo, 'live, /api/x402/stellar/status')
  row(
    'cctp signer',
    cctpSigner,
    cctpSide
      ? cctpSide.signer?.configured
        ? `live, ${cctpSide.signer.from}`
        : `not configured, ${cctpSide.signer?.from ?? '(no env var named)'}`
      : 'no CCTP side on this network',
  )

  // ── The overlaps ──────────────────────────────────────────────────────────────────
  if (feePayer && feePayer === state.owner) {
    findings.push({
      level: 'FAIL',
      text:
        `${chain.id}: the x402 fee payer IS the vault owner (${feePayer}). The owner can withdraw ` +
        'the whole balance and there is no set_owner, so a hot server key must never be it.',
    })
  } else if (feePayer && feePayer === state.operator) {
    findings.push({
      level: 'WARN',
      text: `${chain.id}: the x402 fee payer IS the vault operator (${feePayer}). One key, two jobs.`,
      fix: chain.caip2 === 'stellar:pubnet',
      feePayerVar,
      chain,
    })
  } else if (feePayer) {
    console.log('    OK: the fee payer holds no vault role on this network.')
  }

  if (payTo && payTo === state.owner) {
    findings.push({
      level: 'INFO',
      text: `${chain.id}: payTo is the vault owner (${payTo}). Expected, that is where sales are meant to land.`,
    })
  }

  if (cctpSigner) {
    const roles = (productionKeys.get(cctpSigner) ?? []).filter((r) => !r.includes('cctp'))
    if (roles.length) {
      findings.push({
        level: 'FAIL',
        text: `${chain.id}: the CCTP bridge signer ${cctpSigner} is also ${roles.join(' and ')}.`,
      })
    }
    claim(cctpSigner, `${chain.id} cctp signer`)
  } else if (cctpSide && !cctpSide.signer?.configured) {
    console.log('    CCTP has no signer on this network, so there is no bridge key to collide.')
  }
  console.log('')
}

// A CCTP signer on a chain we do not run a vault on can still collide with a Stellar
// production key, so every side is checked against the full key set, not only the two above.
for (const side of cctp?.sides ?? []) {
  const addr = side.signer?.address
  if (!addr) continue
  const roles = (productionKeys.get(addr) ?? []).filter((r) => !r.includes('cctp'))
  if (roles.length) {
    findings.push({ level: 'FAIL', text: `CCTP ${side.chain} signer ${addr} is also ${roles.join(' and ')}.` })
  }
}
if (cctp && !(cctp.sides ?? []).some((s) => s.signer?.address)) {
  console.log('No CCTP side publishes a signer address today: the Stellar sides are unconfigured and')
  console.log('the EVM sides publish only their env var name. The bridge-key overlap check therefore')
  console.log('had nothing to compare, which is "not checked", not "clean".')
  console.log('')
}

// ── Report ───────────────────────────────────────────────────────────────────────────
const fails = findings.filter((f) => f.level === 'FAIL')
const warns = findings.filter((f) => f.level === 'WARN')
const infos = findings.filter((f) => f.level === 'INFO')

console.log('Findings')
if (!findings.length) console.log('  none: every role on every network is held by its own key.')
for (const f of [...fails, ...warns, ...infos]) console.log(`  ${f.level}: ${f.text}`)

// The pubnet overlap has a specific, already half-done fix, so it is spelled out rather than
// left as "separate the keys". The key exists; what is missing is 2 XLM and one env var.
const pubnetOverlap = warns.find((w) => w.fix)
if (pubnetOverlap) {
  const horizon = pubnetOverlap.chain.horizonUrls?.[0]
  console.log('')
  console.log('  How to close the pubnet overlap (the key already exists, it is unfunded):')
  if (horizon) {
    const dedicated = await horizonAccount(horizon, DEDICATED_PUBNET_FEE_PAYER)
    const state = dedicated.exists
      ? `funded, ${dedicated.xlm} XLM`
      : dedicated.unknown
        ? `state unknown (${dedicated.unknown})`
        : 'does not exist on pubnet yet, so it is unfunded'
    console.log(`    ${DEDICATED_PUBNET_FEE_PAYER}  ${state}`)
  } else {
    console.log(`    ${DEDICATED_PUBNET_FEE_PAYER}  (no Horizon url in the registry to check it with)`)
  }
  console.log('    1. fund it with about 2 XLM')
  console.log(`    2. set ${pubnetOverlap.feePayerVar ?? 'the pubnet fee payer env var'} on Render to that key's seed,`)
  console.log("       held locally under the CLI alias `aid-pubnet-x402-fee`")
  console.log('    3. redeploy, and confirm ONE settlement lands with the new broadcaster')
  console.log('    4. only then does the operator key stop paying fees')
}

console.log('')
if (fails.length) {
  console.error(`${fails.length} FAIL finding(s). A key is doing a job it must not do.`)
  process.exit(1)
}
if (warns.length && STRICT) {
  console.error(`${warns.length} WARN finding(s), and --strict was given.`)
  process.exit(1)
}
console.log(
  warns.length
    ? `${warns.length} warning(s), exiting 0 on purpose so the weekly job stays green until the maintainer acts. Use --strict to make them fail.`
    : 'No warnings.',
)
