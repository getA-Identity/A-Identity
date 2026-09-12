/**
 * Where the Algorand entry stands in the Global x402 Challenge, read live. Read-only: no
 * key, no payment, safe to run as often as you like.
 *
 * Usage (from mcp/):
 *   node scripts/algo-challenge-check.mjs
 *   BASE=http://localhost:3457 node scripts/algo-challenge-check.mjs   (checks the 402 shape only;
 *                                                                        the leaderboard still reads prod's payTo)
 *
 * Two halves, kept apart on purpose:
 *   1. What WE serve: status, payTo opt-in, and each tool's 402 (tag, header, resource origin,
 *      and the Bazaar declaration validated with Ajv exactly as the facilitator validates it).
 *   2. What THE FACILITATOR recorded: which leaderboard bucket our payTo sits in, whether the
 *      Bazaar catalog lists our resources, and whether a merchant record exists. Only this half
 *      says whether the entry counts; the first half only says whether it could.
 */

const BASE = (process.env.BASE ?? 'https://a-identity.xyz').replace(/\/$/, '')
const FACILITATOR = (process.env.X402_ALGORAND_FACILITATOR ?? 'https://facilitator.goplausible.xyz').replace(/\/$/, '')
const TAG = 'x402-global-challenge'
const TOOLS = ['verify_agent', 'reputation_score', 'risk_check', 'agent_passport']

let failures = 0
const check = (pass, label, detail = '') => {
  if (!pass) failures += 1
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const info = (line) => console.log(`INFO  ${line}`)

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(90_000) })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* a non-JSON body is reported by the caller's checks */
  }
  return { status: res.status, headers: res.headers, body }
}

async function loadAjv() {
  try {
    const mod = await import('ajv/dist/2020.js')
    const Ajv = mod.default?.default ?? mod.default ?? mod
    return new Ajv({ strict: false, allErrors: true })
  } catch (e) {
    info(`Ajv not loadable (${e.message}); the Bazaar declaration is checked for presence only`)
    return null
  }
}

// ── 1. what we serve ──────────────────────────────────────────────────────────────────
console.log(`Our side, read from ${BASE}\n`)
const status = await getJson(`${BASE}/api/x402/algorand/status`)
check(status.status === 200 && status.body?.configured === true, 'rail configured', status.body?.reason ?? '')
check(status.body?.payToOptIn?.optedIn === true, 'payTo opted in to the USDC ASA')
check(status.body?.tag === TAG, 'challenge tag configured', status.body?.tag ?? 'unset')
const payTo = status.body?.payTo ?? process.env.PAYTO ?? null

const ajv = await loadAjv()
const baseOrigin = new URL(BASE).origin
for (const tool of TOOLS) {
  const c = await getJson(`${BASE}/api/x402/algorand/tools/${tool}`)
  const accepts = c.body?.accepts?.[0]
  const bazaar = c.body?.extensions?.bazaar
  check(c.status === 402, `${tool}: answers 402 without payment`, String(c.status))
  check(accepts?.extra?.tag === TAG, `${tool}: tag in the accepts extra`)
  check(Boolean(c.headers.get('payment-required')), `${tool}: PAYMENT-REQUIRED header present`)
  const resourceUrl = c.body?.resource?.url ?? ''
  let resourceOrigin = ''
  try {
    resourceOrigin = new URL(resourceUrl).origin
  } catch {
    /* reported below */
  }
  check(resourceOrigin === baseOrigin || BASE.includes('localhost'), `${tool}: resource named under ${baseOrigin}`, resourceUrl)
  check((c.body?.resource?.description ?? '').length >= 80, `${tool}: concrete catalog description`)
  let valid = Boolean(bazaar?.info && bazaar?.schema)
  let why = valid ? '' : 'no extensions.bazaar in the 402'
  if (valid && ajv) {
    const validate = ajv.compile(bazaar.schema)
    valid = validate(bazaar.info)
    why = valid ? '' : JSON.stringify(validate.errors)
  }
  check(valid, `${tool}: Bazaar declaration validates against its schema`, why)
}

// ── 2. what the facilitator recorded ──────────────────────────────────────────────────
console.log(`\nThe facilitator's record, read from ${FACILITATOR}\n`)
if (!payTo) {
  check(false, 'payTo known', 'status gave none; set PAYTO=... to check the facilitator side anyway')
} else {
  info(`payTo ${payTo}`)
  for (const src of [TAG, 'direct', 'dev']) {
    const lb = await getJson(`${FACILITATOR}/data/leaderboards?cat=merchants&limit=500&range=all&env=mainnet&src=${encodeURIComponent(src)}`)
    const items = lb.body?.items ?? []
    const me = items.find((i) => i.address === payTo)
    info(
      `leaderboard src=${src}: ` +
        (me
          ? `rank ${me.rank} of ${items.length}, ${me.settles} settles, ${Number(me.volume).toFixed(4)} USD, bazaar=${me.bazaar}, domain=${me.sub}`
          : `not listed (${items.length} entries)`),
    )
    if (src === TAG) {
      check(Boolean(me), 'listed on the challenge leaderboard')
      for (const rank of [10, 20, 50]) {
        if (items[rank - 1]) info(`rank ${rank} currently sits at ${Number(items[rank - 1].volume).toFixed(2)} USD`)
      }
    }
  }

  const listed = []
  let offset = 0
  for (;;) {
    const page = await getJson(`${FACILITATOR}/discovery/resources?limit=1000&offset=${offset}`)
    const items = page.body?.items ?? []
    listed.push(...items.filter((i) => (i.accepts ?? []).some((a) => a.payTo === payTo)))
    offset += items.length
    if (items.length === 0 || offset >= (page.body?.pagination?.total ?? 0)) break
  }
  check(listed.length > 0, 'resources listed in the Bazaar catalog', listed.map((i) => `${i.method} ${i.resourceUrl} (${i.settleCount} settles)`).join('; ') || 'none')

  const merchants = await getJson(`${FACILITATOR}/discovery/merchants?limit=1000`)
  const merchant = (merchants.body?.items ?? []).find((m) => JSON.stringify(m.addresses ?? {}).includes(payTo))
  check(Boolean(merchant), 'merchant record exists', merchant ? `${merchant.resourceCount} resources, ${merchant.totalSettlements} settlements` : 'none')
}

console.log(failures ? `\n${failures} check(s) failing.` : '\nEvery check passes.')
process.exit(failures ? 1 : 0)
