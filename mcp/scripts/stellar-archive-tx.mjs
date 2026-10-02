#!/usr/bin/env node
/**
 * Archive Stellar transactions we claim, so the claim outlives the network's memory of it.
 *
 * Soroban RPC keeps about a week of transactions. Horizon keeps more, back to the network's
 * last reset, and testnet resets: when it does, every testnet hash on our proof pages stops
 * resolving anywhere. So every transaction we cite is fetched once, read-only, and written
 * to soroban/releases/tx-archive/<chainId>/<hash>.json with its raw envelope, result and
 * (where any source still has it) result meta, plus the decoded evidence: fee payer, the
 * call and its arguments, the result code and any typed contract error, and every
 * authorization entry down to the passkey's authenticator flags.
 *
 *   node mcp/scripts/stellar-archive-tx.mjs --chain stellar-testnet --hash <hex> [--caption "..."] [--deliverable D2]
 *   node mcp/scripts/stellar-archive-tx.mjs --all-provenance [--chain stellar]
 *   node mcp/scripts/stellar-archive-tx.mjs --all-receipts [--chain stellar]
 *
 * --all-provenance archives every Stellar transaction listed in mcp/src/chains/provenance.ts,
 * including funding hops recorded under another chain's entry, with that file's own label as
 * the caption. Needs `npm run build` first: it imports the decoder from mcp/dist.
 *
 * --all-receipts archives every Stellar transaction cited in a release record
 * (soroban/releases/*.json), a third-party receipt (soroban/third-party/<name>/receipt-*.json)
 * or a Stellar docs page (docs/chains/stellar*.mdx) that the archive does not hold yet. A hash
 * counts as a transaction when a receipt stores it under a transaction key (txHash, deployTx,
 * extendTx, ...) or a page links it as an explorer tx; those must archive or the run fails.
 * A bare 64-hex string in free text may be a wasm hash or a digest instead, so it is looked
 * up and, when no network knows it as a transaction, listed as skipped rather than failed.
 * The chain is the receipt's own CAIP-2 `network`, or the network the explorer link names.
 *
 * Idempotent. A re-run keeps the existing caption and deliverable unless new ones are given,
 * keeps the first archivedAt, never drops a meta an earlier run captured, and does not
 * rewrite a file whose content would not change. Read-only against the network: it signs and
 * submits nothing.
 *
 * Exit codes: 0 every requested transaction archived, 1 at least one could not be, 2 bad
 * arguments.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHAINS, txUrl } from '../dist/chains/index.js'
import { PROVENANCE } from '../dist/chains/provenance.js'
import { decodeTxEvidence, fetchTxEvidence } from '../dist/chains/stellar/tx-evidence.js'
import { networkPassphrase } from '../dist/chains/stellar/client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ARCHIVE = join(HERE, '..', '..', 'soroban', 'releases', 'tx-archive')
const REPO = join(HERE, '..', '..')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const usage = () => {
  console.error('usage: stellar-archive-tx.mjs --chain <registry id> --hash <hex> [--caption "..."] [--deliverable D2]')
  console.error('       stellar-archive-tx.mjs --all-provenance [--chain <registry id>]')
  console.error('       stellar-archive-tx.mjs --all-receipts [--chain <registry id>] [--list]')
  process.exit(2)
}

const stellarChains = CHAINS.filter((c) => c.ecosystem === 'stellar')
const chainArg = arg('chain')
const onlyChain = chainArg ? stellarChains.find((c) => c.id === chainArg || c.caip2 === chainArg) : undefined
if (chainArg && !onlyChain) {
  console.error(`--chain must name a Stellar chain: ${stellarChains.map((c) => c.id).join(' or ')}`)
  process.exit(2)
}

/** @type {{ chain: any, hash: string, caption?: string, deliverable?: string, provenance?: object }[]} */
const jobs = []
if (flag('all-provenance')) {
  const ids = new Set(stellarChains.map((c) => c.id))
  const seen = new Set()
  for (const entry of PROVENANCE) {
    for (const a of entry.artifacts) {
      const on = a.onChain ?? (a.externalChain ? undefined : entry.chain)
      if (!on || !ids.has(on)) continue
      if (onlyChain && on !== onlyChain.id) continue
      const key = `${on}:${a.txHash.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      jobs.push({
        chain: stellarChains.find((c) => c.id === on),
        hash: a.txHash.toLowerCase(),
        caption: a.label,
        captionIsDefault: true,
        deliverable: arg('deliverable'),
        provenance: { entry: entry.chain, kind: a.kind, label: a.label, ...(a.note ? { note: a.note } : {}) },
      })
    }
  }
} else if (flag('all-receipts')) {
  const archivedOn = (hash) => stellarChains.find((c) => existsSync(join(ARCHIVE, c.id, `${hash}.json`)))
  // A transaction key: txHash, tx, deployTx, extendTx, instanceExtendTx. Not wasmHash or salt.
  const TX_KEY = /(^tx|Tx)(Hash)?$/
  // Keys whose value is a code hash, a salt or a contract's code entry, never a transaction.
  const NOT_TX_KEY = /([wW]asm(Hash)?|^salt|CodeEntry|Instance|^sha256|Sha256)$/
  const HEX64 = /\b[0-9a-f]{64}\b/g
  /** @type {Map<string, any>} */
  const cited = new Map()
  const cite = (hash, { chain, tryChains, sure, caption, file }) => {
    const prior = cited.get(hash)
    if (prior) {
      if (!prior.citedIn.includes(file)) prior.citedIn.push(file)
      if (sure && !prior.sure) Object.assign(prior, { chain, tryChains: undefined, sure, caption: caption ?? prior.caption })
      return
    }
    cited.set(hash, { hash, chain, tryChains, sure, caption, citedIn: [file] })
  }
  // A bare hash in prose: an explorer tx link pins it and its chain; otherwise it is a maybe.
  const scanText = (text, file, hint) => {
    for (const h of new Set(text.match(HEX64) ?? [])) {
      const linked = stellarChains.find((c) => text.includes(txUrl(c, h)))
      if (linked) cite(h, { chain: linked, sure: true, caption: `cited in ${file}`, file })
      else cite(h, { tryChains: hint ? [hint, ...stellarChains.filter((c) => c !== hint)] : stellarChains, sure: false, caption: `cited in ${file}`, file })
    }
  }
  const walk = (node, file, hint, parent, key) => {
    if (typeof node === 'string') {
      if (/^[0-9a-f]{64}$/.test(node) && key && TX_KEY.test(key)) {
        if (!hint) throw new Error(`${file} cites ${node} as ${key} but names no Stellar network`)
        const label = parent && typeof parent.label === 'string' ? parent.label : `${key} in ${file}`
        cite(node, { chain: hint, sure: true, caption: label, file })
      } else if (/^[0-9a-f]{64}$/.test(node) && key && NOT_TX_KEY.test(key)) {
        // A value its own key says is not a transaction: nothing to look up.
      } else scanText(node, file, hint)
      return
    }
    if (Array.isArray(node)) node.forEach((v) => walk(v, file, hint, parent, key))
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, file, hint, node, k)
  }

  const releases = join(REPO, 'soroban', 'releases')
  const thirdParty = join(REPO, 'soroban', 'third-party')
  const receiptFiles = [
    ...readdirSync(releases).filter((f) => f.endsWith('.json')).map((f) => join(releases, f)),
    ...readdirSync(thirdParty, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(thirdParty, d.name)).filter((f) => /^receipt-.*\.json$/.test(f)).map((f) => join(thirdParty, d.name, f))),
  ]
  for (const path of receiptFiles) {
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const hint = stellarChains.find((c) => c.caip2 === doc.network || c.id === doc.network)
    walk(doc, relative(REPO, path), hint, null, null)
  }
  const docsDir = join(REPO, 'docs', 'chains')
  for (const f of readdirSync(docsDir).filter((n) => /^stellar.*\.mdx$/.test(n))) {
    scanText(readFileSync(join(docsDir, f), 'utf8'), relative(REPO, join(docsDir, f)), undefined)
  }

  let held = 0
  for (const c of cited.values()) {
    if (archivedOn(c.hash)) {
      held += 1
      continue
    }
    if (onlyChain && c.sure && c.chain !== onlyChain) continue
    jobs.push({
      chain: c.chain,
      tryChains: c.sure ? undefined : onlyChain ? [onlyChain] : c.tryChains,
      maybe: !c.sure,
      hash: c.hash,
      caption: c.caption,
      captionIsDefault: true,
      deliverable: arg('deliverable'),
      citedIn: c.citedIn,
    })
  }
  console.log(`${cited.size} distinct 64-hex strings cited; ${held} already archived; ${jobs.length} to look up.`)
  if (flag('list')) {
    for (const j of jobs) console.log(`${j.maybe ? 'maybe' : 'tx   '} ${(j.chain?.id ?? 'any').padEnd(15)} ${j.hash} ${j.citedIn.join(', ')}`)
    process.exit(0)
  }
} else {
  const hash = arg('hash')
  if (!onlyChain || !hash) usage()
  jobs.push({ chain: onlyChain, hash: hash.trim().toLowerCase(), caption: arg('caption'), deliverable: arg('deliverable') })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readExisting(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

let failed = 0
let skipped = 0
let noMeta = 0
const results = []
for (const [i, job] of jobs.entries()) {
  // Polite pacing: these are public services, and nothing here is urgent.
  if (i > 0) await sleep(400)
  // A maybe is tried on each candidate network in turn; the first that knows it decides.
  let r
  for (const c of job.tryChains ?? [job.chain]) {
    r = await fetchTxEvidence(c, job.hash)
    job.chain = c
    if (r.ok || r.code !== 'not_found') break
  }
  if (!r.ok && job.maybe && r.code === 'not_found') {
    skipped += 1
    console.log(`skipped   ${job.hash.slice(0, 12)}... no Stellar network knows it as a transaction (a wasm hash, salt or digest), cited in ${job.citedIn.join(', ')}`)
    continue
  }
  const dir = join(ARCHIVE, job.chain.id)
  const path = join(dir, `${job.hash}.json`)
  const existing = readExisting(path)

  if (!r.ok) {
    failed += 1
    results.push({ chain: job.chain.id, hash: job.hash, ok: false, code: r.code, reason: r.reason })
    console.error(`FAIL ${job.chain.id} ${job.hash} ${r.code}: ${r.reason}`)
    continue
  }

  let { record, evidence } = r
  let resultMetaXdr = record.resultMetaXdr
  let metaFrom = record.metaFrom
  let metaNote = record.metaNote
  // Never lose a meta an earlier run captured: RPC forgets, the file should not.
  if (!resultMetaXdr && existing?.resultMetaXdr && existing.envelopeXdr === record.envelopeXdr && existing.resultXdr === record.resultXdr) {
    resultMetaXdr = existing.resultMetaXdr
    metaFrom = existing.metaFrom ?? null
    metaNote = existing.metaNote ?? null
    evidence = decodeTxEvidence(record.envelopeXdr, record.resultXdr, resultMetaXdr, networkPassphrase(job.chain), { chain: job.chain })
    if (metaFrom === 'stellar-expert' && metaNote) evidence.caveats.push(metaNote)
  }

  const caption = job.captionIsDefault ? (existing?.caption ?? job.caption ?? null) : (job.caption ?? existing?.caption ?? null)
  const out = {
    hash: evidence.hash,
    chainId: job.chain.id,
    network: job.chain.caip2,
    ledger: record.ledger,
    createdAt: record.createdAt,
    status: evidence.status,
    resultCode: evidence.resultCode,
    sourceAccount: evidence.sourceAccount,
    feeAccount: evidence.feeAccount,
    feeChargedStroops: evidence.feeChargedStroops,
    envelopeXdr: record.envelopeXdr,
    resultXdr: record.resultXdr,
    resultMetaXdr: resultMetaXdr ?? null,
    metaFrom: metaFrom ?? null,
    metaNote: metaNote ?? null,
    fetchedFrom: existing?.fetchedFrom === 'rpc' && record.fetchedFrom === 'horizon' ? 'rpc' : record.fetchedFrom,
    explorer: txUrl(job.chain, evidence.hash),
    archivedAt: existing?.archivedAt ?? new Date().toISOString(),
    caption,
    deliverable: job.deliverable ?? existing?.deliverable ?? null,
    ...(job.provenance ? { provenance: job.provenance } : existing?.provenance ? { provenance: existing.provenance } : {}),
    ...(job.citedIn ? { citedIn: job.citedIn } : existing?.citedIn ? { citedIn: existing.citedIn } : {}),
    decoded: evidence,
  }
  const text = `${JSON.stringify(out, null, 2)}\n`
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : null
  mkdirSync(dir, { recursive: true })
  const state = prior === text ? 'unchanged' : prior ? 'updated' : 'written'
  if (state !== 'unchanged') writeFileSync(path, text)
  if (!out.resultMetaXdr) noMeta += 1
  results.push({ chain: job.chain.id, hash: job.hash, ok: true, state, fetchedFrom: out.fetchedFrom, meta: out.metaFrom ?? 'none' })
  console.log(
    `${state.padEnd(9)} ${job.chain.id.padEnd(15)} ${job.hash.slice(0, 12)}... ${evidence.status.padEnd(7)} from ${out.fetchedFrom.padEnd(7)} meta ${String(out.metaFrom ?? 'none').padEnd(14)} ${relative(REPO, path)}`,
  )
}

const ok = results.filter((x) => x.ok).length
console.log(`\n${ok} of ${jobs.length} archived; ${failed} failed; ${skipped} skipped as not a transaction; ${noMeta} archived without result meta.`)
process.exit(failed ? 1 : 0)
