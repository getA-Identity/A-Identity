/**
 * The Markdown a hire is delivered as, and the decline detail when no verdict could be made.
 *
 * The marketplace's first hard rule: "The Markdown you submit is the work." So the deliverable
 * is the whole answer, readable without anything else: the verdict and its 0-1000 score, every
 * reason the engine returned with its detail and source, the network, the block (height, hash,
 * time), both digests, the exact command that recomputes it, the snapshot itself so it replays
 * with no network at all, what the check does not cover, and the one line on where A-Identity's
 * NEAR contracts exist. Nothing in it is decided here: every value is the engine's, as the CLI
 * prints it, and the text around them only says what they are.
 *
 * Plain ASCII throughout (the repository's punctuation rule, and the listing's promise). Text
 * that came from the chain or another team's registry is put inside fenced text blocks with any
 * fence marker in it broken, so it is shown and never rendered as a link or heading of ours; the
 * snapshot is JSON with every character outside ASCII written as a \u escape, which JSON reads
 * back as the same text, so the replay digests still match.
 */
import type { MarketVerdict, VerdictFailure } from './verdict.js'
import type { BriefTarget } from './brief.js'

/** The repository the recompute commands run from (also quoted by asp/proof.ts). */
export const REPO_URL = 'https://github.com/getA-Identity/A-Identity'

/** The marketplace takes 1 byte to 256 KiB; stay clear of the edge. */
export const MAX_DELIVERABLE_BYTES = 250_000

const TAG: Record<string, string> = { deny: 'DENY', warn: 'WARN', positive: 'PLUS', info: 'INFO' }
const NETWORK_NAME = { testnet: 'NEAR testnet', mainnet: 'NEAR mainnet' } as const

/** Typographic punctuation to its ASCII twin, written as escapes so this file keeps the rule it enforces. */
const TWINS: Record<string, string> = {
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2026': '...', '\u00A0': ' ', '\u2192': '->', '\u2190': '<-', '\u21D2': '=>',
}

/** Plain ASCII text: typographic punctuation mapped, any other character outside ASCII shown as `?`. */
export function ascii(s: string): string {
  return s
    .replace(/[^\x00-\x7e]/g, (c) => TWINS[c] ?? '?')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/** JSON in plain ASCII: every character outside it as a \u escape, which parses back to the same value. */
export function asciiJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** A fenced block whose content cannot close it early or open another one. */
function fence(lang: string, body: string): string {
  const safe = ascii(body).replace(/(`{3,}|~{3,})/g, (m) => "'".repeat(m.length))
  return `~~~${lang}\n${safe}\n~~~`
}

const isoOfNs = (ns: string): string => {
  if (!/^\d+$/.test(ns)) return 'unknown time'
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString()
}

/** The command that re-collects the same block and prints the same verdict and chain_sha256. */
export function recomputeCommand(v: Pick<MarketVerdict, 'account' | 'network'> & { height: number }): string {
  return `cd near && npm run verdict -- ${v.account}${v.network === 'mainnet' ? ' --network mainnet' : ''} --at-block ${v.height} --json`
}

/** The command that replays the inlined snapshot with no network. */
export const OFFLINE_COMMAND = 'cd near && npm run verdict -- --offline snapshot.json --json'

/** The one line the listing promises on where A-Identity's NEAR contracts are. */
export const CONTRACTS_LINE =
  'A-Identity\'s NEAR spend vault and verdict registry contracts exist on NEAR testnet only. This check is read only on both networks: it signs nothing and moves no funds.'

/** The engine's reasons, as the CLI prints them (sdk/src/cli/verdict.ts renderText). */
function reasonsText(v: MarketVerdict): string {
  const d = v.decision
  if (d.reasons.length === 0) return '(none)'
  return d.reasons
    .map((r) => {
      const cleared = r.cleared_by ? `  (cleared by ${r.cleared_by})` : ''
      return `${TAG[r.severity] ?? r.severity.toUpperCase()}  ${r.code}${cleared}\n      ${r.detail}\n      source: ${r.source}`
    })
    .join('\n')
}

/** What A-Identity's own registry said in the same snapshot. */
function registryText(v: MarketVerdict): string {
  const r = v.registry
  const at = `block #${v.decision.block.height}`
  if (r.state === 'not_configured') {
    return v.network === 'mainnet'
      ? 'There is no A-Identity registry on NEAR mainnet, so none was read: the registry signals (registry_allow, registry_deny, registry_warn, open_reports) cannot fire on a mainnet account.'
      : 'No A-Identity registry was configured for this read, so the registry signals could not fire.'
  }
  if (r.state === 'not_deployed') return `A-Identity's registry ${r.id} has no contract at ${at}, so it holds no verdict on this account.`
  if (r.state === 'unavailable') return `A-Identity's registry ${r.id} could not be read (${r.why}), and the engine counted that as unreadable, never as clean.`
  const reports = `${r.open_reports} open report(s) not yet reviewed`
  if (!r.verdict) return `A-Identity's registry ${r.id} holds no verdict on this account at ${at}; ${reports}.`
  const why = r.verdict.reasons.length ? ` (${r.verdict.reasons.join(', ')})` : ''
  const by = r.verdict.updated_by ? `, written by ${r.verdict.updated_by}` : ''
  return `A-Identity's registry ${r.id} says ${r.verdict.verdict}${why}${by}, as read at ${at}; ${reports}.`
}

function warnKind(v: MarketVerdict): string {
  if (v.decision.warn_kind === 'soft') return ', a soft warning: nobody has history with this payee yet'
  if (v.decision.warn_kind === 'hard') return ', a hard warning: at least one concern is about the payee itself or about data that could not be read'
  return ''
}

function limits(v: MarketVerdict, height: number): string[] {
  const mainnet = v.network === 'mainnet'
  const registry = v.registry.state !== 'not_configured'
  return [
    `It reports what the chain and the indexers showed at one block (#${height}). It does not predict what the account does next: keys, code and balances can change after that block.`,
    'It does not audit or simulate contract code. For a contract account it notes the contract, a code change in the last 72 hours and a global contract that can change without a deploy; it does not say the contract is safe to call.',
    'It does not identify the person or business behind the account (no KYC). ERC-8004 identity and reputation on NEAR are permissionless, so they move the score only.',
    `It traces no funds and screens no sanctions list. The lists it reads are Circle's USDC blocklist on ${NETWORK_NAME[v.network]}, ${registry ? 'A-Identity\'s registry and' : 'and'} the other teams' registries named in the reasons, which mostly hold demo data and never refuse on their own.`,
    registry
      ? 'Lookalike detection compares the account only with the accounts A-Identity\'s registry marks ALLOW, because the brief named no payees of yours. Add --known <your payees> to the command above to compare with your own.'
      : `Lookalike detection had nothing to compare with: the brief named no payees of yours and no A-Identity registry was read${mainnet ? ' (there is none on mainnet)' : ''}. Add --known <your payees> to the command above to compare with your own.`,
    'No vault was read, so your own history with this payee (prior payments, refusals, an owner allowlist) is not part of it.',
    'Indexer data (FastNEAR, NearBlocks) is not consensus. Only facts at or below the pinned block are used, and if both indexers fail the verdict is WARN (indexer_unavailable), never ALLOW.',
    ...(mainnet
      ? ['MimicWatch keeps its registry on testnet, so for a mainnet account it is read at the latest testnet block at or before this block\'s time; the snapshot notes below say whether that read happened.']
      : []),
    'An amount does not enter the verdict: the engine decides without one, so the verdict is the same for any amount.',
    'No model takes part in the verdict, and it is not financial, legal or investment advice.',
  ]
}

export type DeliverableContext = {
  amount: string | null
  round: 'first' | 'rework' | 'redo'
  /** For a rework: when the buyer's message was written, and whether it named another account. */
  feedback?: { at: string; switchedFrom: string | null; namedOne: boolean } | null
}

function versionNote(v: MarketVerdict, ctx: DeliverableContext): string | null {
  if (ctx.round === 'first') return null
  if (ctx.round === 'redo') return `This version is the redo a dispute ruling asked for: it checks ${v.caip10} again, at a newer block.`
  const at = ctx.feedback && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ctx.feedback.at) ? ` of ${ctx.feedback.at}` : ''
  if (ctx.feedback?.switchedFrom) return `This version answers your request for changes${at}: it checks ${v.caip10}, the account your message names, instead of ${ctx.feedback.switchedFrom}.`
  if (ctx.feedback?.namedOne) return `This version answers your request for changes${at}: it checks ${v.caip10} again, at a newer block.`
  return `This version answers your request for changes${at}. Your message does not name one other account, so it checks ${v.caip10} again, at a newer block. To have a different account checked, reply with exactly one account id.`
}

/** The deliverable for a computed verdict. */
export function renderDeliverable(v: MarketVerdict, ctx: DeliverableContext): string {
  const d = v.decision
  const height = d.block.height
  const deciding = v.deciding.length ? v.deciding.map((c) => `\`${c}\``).join(', ') : d.verdict === 'ALLOW' ? 'none: nothing decided against it' : 'none'
  const head: string[] = [
    `# A-Identity Guard for NEAR: ${d.verdict} on ${v.account} (${NETWORK_NAME[v.network]})`,
    '',
    `- Verdict: **${d.verdict}**${warnKind(v)}`,
    `- Score: **${d.score}** of 1000 (higher is more trustworthy; bands DENY 0-199, WARN 200-499, ALLOW 500-1000)`,
    `- Deciding reasons: ${deciding}`,
    `- Account: \`${v.account}\` (${v.kind} account)`,
    `- CAIP-10: \`${v.caip10}\``,
    `- Network: ${NETWORK_NAME[v.network]}`,
    `- Block read: #${height}, hash \`${d.block.hash}\`, time ${isoOfNs(d.block.timestamp_ns)}`,
    `- snapshot_sha256: \`${v.snapshot_sha256}\``,
    `- chain_sha256: \`${v.chain_sha256}\``,
    `- Engine: \`${d.engine_version}\`, policy \`${d.policy_id}\`, collector \`${v.collector}\``,
    `- Read live at ${v.collected_at || 'an unrecorded time'} from: ${v.endpoints.length ? v.endpoints.join(', ') : 'no host recorded'}`,
    `- Explorer, for people (the verdict reads RPC): ${v.explorer}`,
  ]
  const note = versionNote(v, ctx)
  if (note) head.push('', note)

  const body: string[] = [
    '',
    '## Every reason the engine returned',
    '',
    'In the engine\'s order: deny first, then warnings, positives (PLUS) and information. A warning a positive signal cleared does not decide.',
    '',
    fence('text', reasonsText(v)),
    '',
    '## A-Identity\'s registry',
    '',
    fence('text', registryText(v)),
  ]
  if (ctx.amount) {
    body.push(
      '',
      '## Amount',
      '',
      `The brief names an amount: ${ascii(ctx.amount)}. It does not enter the verdict, which is the same for any amount, as the SDK's is.${v.network === 'testnet' ? ' On NEAR testnet, A-Identity\'s spend vault caps amounts on chain.' : ''}`,
    )
  }
  body.push(
    '',
    '## Recompute it yourself',
    '',
    `From a clone of ${REPO_URL}, after \`npm ci\` in \`near/\`:`,
    '',
    fence('sh', recomputeCommand({ account: v.account, network: v.network, height })),
    '',
    'It sends the same block-pinned reads again (through archival RPC once the block is old) and prints the same verdict, score, reasons and chain_sha256. snapshot_sha256 also covers the indexer answers with their fetch time, so a new collection prints a new one.',
    '',
    'With no network at all: save the JSON under Snapshot below as `near/snapshot.json`, then',
    '',
    fence('sh', OFFLINE_COMMAND),
    '',
    'It prints this verdict, score and reasons, and the same snapshot_sha256 and chain_sha256, from that file alone.',
    '',
    '## What this check does not cover',
    '',
    ...limits(v, height).map((l) => `- ${l}`),
  )
  if (v.notes.length) body.push('', '## Notes from the collection', '', fence('text', v.notes.join('\n')))
  body.push('', '## Where A-Identity runs on NEAR', '', CONTRACTS_LINE)

  const text = ascii([...head, ...body].join('\n'))
  return `${text}\n\n${snapshotSection(v, MAX_DELIVERABLE_BYTES - text.length - 2)}\n`
}

/** The snapshot as JSON, pretty if it fits, compact if only that fits, else a note saying why it is left out. */
function snapshotSection(v: MarketVerdict, budget: number): string {
  const intro = (kib: number, form: string) =>
    `## Snapshot\n\nEvery request this verdict rests on, with its answer (${v.snapshot.schema}, ${kib} KiB, ${form}). Characters outside ASCII are written as \\u escapes, which JSON reads back as the same text.\n\n`
  for (const [indent, form] of [[2, 'indented'], [undefined, 'compact']] as const) {
    const json = asciiJson(v.snapshot, indent)
    const section = `${intro(Math.ceil(json.length / 1024), form)}~~~json\n${json}\n~~~`
    if (section.length <= budget) return section
  }
  const size = Math.ceil(asciiJson(v.snapshot).length / 1024)
  return (
    `## Snapshot\n\nThe snapshot is ${size} KiB, more than this deliverable can carry, so it is left out. ` +
    'The --at-block command above re-collects the same block-pinned reads and prints the same chain_sha256; add --save-snapshot snapshot.json to keep a copy for offline replay.'
  )
}

/** The decline detail (at most 1000 characters) when no verdict could be computed. */
export function failureDeclineDetail(target: BriefTarget, failure: VerdictFailure, attempts: number): string {
  const tries = attempts === 1 ? 'once' : `${attempts} times`
  const text =
    `The check on ${target.caip10} could not run: ${failure.error}. I tried ${tries} before the deadline. ` +
    'No verdict was made up and none is delivered: a verdict needs the chain read, and an unread chain is not evidence either way. ' +
    `You are refunded in full. To try again later, hire again; to run it yourself: cd near && npm run verdict -- ${target.account}${target.network === 'mainnet' ? ' --network mainnet' : ''} --json`
  return ascii(text).slice(0, 1000)
}

/** The decline detail when a delivery was refused for a reason of ours. */
export function internalDeclineDetail(target: BriefTarget, why: string): string {
  return ascii(
    `The check on ${target.caip10} ran, but its delivery was refused (${why}). That is a fault on our side, not about the account. ` +
      'You are refunded in full; hire again to get the verdict.',
  ).slice(0, 1000)
}
