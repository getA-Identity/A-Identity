/**
 * Which NEAR account a marketplace brief asks about, or why it names none we can check.
 *
 * The listing promises one thing: brief it with a NEAR account id (and optionally an amount) and
 * get A-Identity's verdict on that account. So a brief is read for exactly one account, and a
 * brief that names none, or more than one, is answered with one question rather than a guess:
 * checking the wrong account and charging for it is the worst outcome this worker can have.
 *
 * The forms read, all of them NEAR's own:
 *
 *  - `near:testnet:<id>` and `near:mainnet:<id>`, any account kind, because the prefix says which
 *    network is meant. Another network after `near:` is named back as one this worker does not read.
 *  - a bare named account ending in `.testnet` (NEAR testnet's registrar suffix) or `.near`
 *    (mainnet's). This is wider than chains/near/ids.ts nearTargetOf on purpose, and only here: on
 *    a request path a bare `.near` or 64-hex string can mean something else (a web name, an EVM
 *    key, a Stellar hash), while a brief bought from a NEAR-only listing is about NEAR by
 *    construction. The account rules themselves are ids.ts's (isNearAccountId, nearAccountKind).
 *  - a bare 64-hex implicit account, whose network the brief must say in so many words (the
 *    word `testnet` or `mainnet`); without it the same id names an account on each network, so it
 *    is asked about, never guessed.
 *
 * What ends an id: whitespace, ASCII punctuation other than `.`, `-` and `_`, and the typographic
 * punctuation phone keyboards and model-written briefs put next to one (curly quotes, guillemets,
 * the em dash, the ellipsis, CJK brackets, full-width commas and colons). None of those can be part
 * of an account id or pass for one of its characters. The lookalikes of `-` and `.` (the Unicode
 * hyphens and en dash, the minus sign, the ideographic and full-width full stops) are trimmed at
 * either end of an id, where they are punctuation, and never split on inside one, where splitting
 * would turn a lookalike name into a different, valid account.
 *
 * Near misses are named in the question, so a buyer sees what went wrong: an id with capitals
 * (NEAR ids are lowercase), an id with a character outside a-z, 0-9 and . - _ (which is how a
 * lookalike name is built, so it is never silently repaired), an id too long or with doubled
 * separators. Every string this module returns is plain ASCII, a character outside it shown as a
 * \u escape, and every mention it echoes is cut to SHOWN_MAX characters, so no brief can make the
 * question or a decline longer than the marketplace takes.
 *
 * Pure: no I/O. The worker decides what to do with the answer.
 */
import { isNearAccountId, nearAccountKind, type NearAccountKind } from '../chains/near/ids.js'

export type NearNetwork = 'testnet' | 'mainnet'

export type BriefTarget = { network: NearNetwork; account: string; kind: NearAccountKind; caip10: string }

export type BriefParse =
  | { kind: 'one'; target: BriefTarget; amount: string | null }
  | {
      kind: 'unclear'
      /** none: nothing account-shaped; many: more than one mention (resolved or not); invalid: one mention, unusable. */
      reason: 'none' | 'many' | 'invalid'
      /** Every account-shaped mention, as a reader would recognise it, in order of appearance (each at most SHOWN_MAX characters). */
      mentions: string[]
      /** The mentions that are checkable accounts, in order of appearance. */
      targets: BriefTarget[]
      /** Why each unusable mention could not be used, or where each account was named. */
      notes: string[]
      amount: string | null
    }

export type UnclearBrief = Extract<BriefParse, { kind: 'unclear' }>

const HEX64 = /^[0-9a-f]{64}$/

/** Plain ASCII for anything we echo back: every other character becomes a \u escape. */
export const asciiEscape = (s: string): string => s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** The longest mention echoed back. A valid CAIP-10 (13 + 64 characters) always fits whole. */
export const SHOWN_MAX = 80

/** A mention cut to SHOWN_MAX characters, never through the middle of a \u escape. */
export function shown(s: string): string {
  if (s.length <= SHOWN_MAX) return s
  let cut = s.slice(0, SHOWN_MAX - 3)
  const escape = cut.lastIndexOf('\\u')
  if (escape >= 0 && escape > cut.length - 6) cut = cut.slice(0, escape)
  return `${cut}...`
}

const target = (network: NearNetwork, account: string): BriefTarget => ({
  network,
  account,
  kind: nearAccountKind(account) ?? 'named',
  caip10: `near:${network}:${account}`,
})

/** ASCII characters that end a token. `.`, `-` and `_` do not: account ids are made of them. */
const ASCII_STOPS = String.raw`\s,;:!?()[\]{}<>"'\x60*|\\/=&#+~^%@$`
/**
 * Typographic punctuation that ends a token too: curly quotes and their low and reversed forms,
 * guillemets, the em dash, the ellipsis, CJK corner brackets, the ideographic comma and the
 * full-width exclamation mark, parentheses, comma, colon, semicolon and question mark. Escapes,
 * so this file keeps the ASCII rule.
 */
const TYPO_STOPS = String.raw`\u2018-\u201F\u00AB\u00BB\u2039\u203A\u2014\u2026\u300C-\u300F\u3001\uFF01\uFF08\uFF09\uFF0C\uFF1A\uFF1B\uFF1F`
/** The lookalikes of `-` and `.`: trimmed at a token's ends only, never split on inside it. */
const EDGE_ONLY = String.raw`\u2010-\u2013\u2212\u3002\uFF0E`

const SPLIT = new RegExp(`[${ASCII_STOPS}${TYPO_STOPS}]+`)
const PREFIXED = new RegExp(`near:([A-Za-z0-9-]*):([^${ASCII_STOPS}${TYPO_STOPS}]+)`, 'gi')
const EDGES = new RegExp(String.raw`^[._\-${EDGE_ONLY}]+|[._\-${EDGE_ONLY}]+$`, 'g')
const trimSeparators = (t: string): string => t.replace(EDGES, '')

/**
 * The text of an A2A opening message. The docs: its body "is the protocol's serialized Message
 * ({"role":"user","parts":[...]}), not prose", and a data part "survives nowhere else". Text parts
 * and data parts are read; any other body is returned unchanged.
 */
export function a2aText(body: string): string {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return body
  try {
    const msg = JSON.parse(trimmed) as { parts?: unknown }
    if (!Array.isArray(msg.parts)) return body
    const out: string[] = []
    for (const p of msg.parts as Array<Record<string, unknown>>) {
      if (p && typeof p.text === 'string') out.push(p.text)
      else if (p && p.data !== undefined) out.push(JSON.stringify(p.data))
    }
    return out.join('\n')
  } catch {
    return body
  }
}

/** A number as people write one: 5, 0.25, 1,000 or 1,000.50. */
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,12})?|\d{1,15}(?:\.\d{1,12})?)`

/** The first amount the text states, normalised ("5 NEAR", "1000.50 USD"), or null. Informational only. */
export function parseAmount(text: string): string | null {
  const dollar = new RegExp(String.raw`(?:^|[\s(])\$\s?${NUMBER}(?![\d,.]*\d)`).exec(text)
  // The unit must end the word: in 5near.testnet, "near" is part of an account id, not a unit.
  const unit = new RegExp(String.raw`(?:^|[^\w.,])${NUMBER}\s?(near|usdc|usdt|usd|dollars?)(?![\w.-]*\w)`, 'i').exec(text)
  const plain = (n: string) => n.replace(/,/g, '')
  const pick = [
    dollar && { at: dollar.index, s: `${plain(dollar[1])} USD` },
    unit && { at: unit.index, s: `${plain(unit[1])} ${/^dollar/i.test(unit[2]) ? 'USD' : unit[2].toUpperCase()}` },
  ]
    .filter((x): x is { at: number; s: string } => Boolean(x))
    .sort((a, b) => a.at - b.at)
  return pick[0]?.s ?? null
}

/** Read one brief (or one reply) for exactly one NEAR account. */
export function parseBrief(input: string): BriefParse {
  const resolved = new Map<string, BriefTarget>()
  // Mentions are told apart by their whole text and echoed cut, so two long ids that share a
  // beginning still count as two.
  const seen = new Set<string>()
  const mentions: string[] = []
  const notes: string[] = []
  const mention = (full: string) => {
    if (seen.has(full)) return
    seen.add(full)
    mentions.push(shown(full))
  }
  const unusable = (full: string, why: string) => {
    mention(full)
    const note = `${shown(full)}: ${why}`
    if (!notes.includes(note)) notes.push(note)
  }
  const resolve = (t: BriefTarget) => {
    mention(t.caip10)
    if (!resolved.has(t.caip10)) resolved.set(t.caip10, t)
  }

  // 1. The prefixed forms, which say their network. Cut out of the text so their parts are not
  //    read a second time below.
  const rest = input.replace(PREFIXED, (_m, net: string, rawId: string) => {
    const network = net.toLowerCase()
    const id = trimSeparators(rawId)
    const full = asciiEscape(`near:${net}:${id}`)
    if (network !== 'testnet' && network !== 'mainnet') unusable(full, `${shown(`near:${asciiEscape(net)}`)} is not a network this check reads (testnet and mainnet only)`)
    else if (isNearAccountId(id)) resolve(target(network, id))
    else unusable(full, idProblem(id))
    return ' '
  })

  // 2. Bare tokens.
  const tokens = rest.split(SPLIT).map(trimSeparators).filter(Boolean)
  const words = new Set(tokens.map((t) => t.toLowerCase()))
  const hint: NearNetwork | null = words.has('testnet') && !words.has('mainnet') ? 'testnet' : words.has('mainnet') && !words.has('testnet') ? 'mainnet' : null
  for (const t of tokens) {
    const lower = t.toLowerCase()
    const suffix = lower.endsWith('.testnet') ? 'testnet' : lower.endsWith('.near') ? 'mainnet' : null
    if (suffix) {
      if (t === lower && nearAccountKind(t) === 'named') resolve(target(suffix, t))
      else unusable(asciiEscape(t), idProblem(t))
      continue
    }
    if (HEX64.test(lower)) {
      if (t !== lower) unusable(asciiEscape(t), idProblem(t))
      else if (hint) resolve(target(hint, t))
      else unusable(t, 'a 64-hex implicit account names an account on testnet and on mainnet alike, and the brief does not say which (write near:testnet:<id> or near:mainnet:<id>)')
    }
  }

  const amount = parseAmount(rest)
  if (resolved.size === 1 && notes.length === 0) return { kind: 'one', target: [...resolved.values()][0], amount }
  const reason = mentions.length === 0 ? 'none' : mentions.length > 1 ? 'many' : 'invalid'
  return { kind: 'unclear', reason, mentions, targets: [...resolved.values()], notes, amount }
}

/**
 * The job brief names one account and the buyer's message another. Which one is meant is a
 * question for the buyer, never a pick: checking the other one would answer a question nobody
 * asked, and charge for it.
 */
export function disagreement(brief: BriefTarget, message: BriefTarget, amount: string | null): UnclearBrief {
  return {
    kind: 'unclear',
    reason: 'many',
    mentions: [brief.caip10, message.caip10],
    targets: [brief, message],
    notes: [`${brief.caip10}: named in the job brief`, `${message.caip10}: named in your message`],
    amount,
  }
}

/** Why a string shaped like an account id is not one, in the terms of the account-id rule. */
function idProblem(id: string): string {
  if (/[^\x00-\x7f]/.test(id)) return 'not a NEAR account id: it holds a character outside a-z, 0-9 and . - _, which is how lookalike names are made, so it is not repaired'
  if (id !== id.toLowerCase() && isNearAccountId(id.toLowerCase())) return `not a NEAR account id: NEAR ids are lowercase (${id.toLowerCase()} would be one)`
  if (id.length > 64) return 'not a NEAR account id: longer than 64 characters'
  if (id.length < 2) return 'not a NEAR account id: shorter than 2 characters'
  return 'not a NEAR account id: 2 to 64 characters of a-z, 0-9 and . - _, never a separator at either end or two in a row'
}

/** The forms a reply can take, as one block of text. */
export const FORMS =
  'Write it as one of:\n' +
  '- near:testnet:<account> or near:mainnet:<account>\n' +
  '- a name ending in .testnet (NEAR testnet) or .near (NEAR mainnet)\n' +
  '- a 64-character hex implicit account, with the word testnet or mainnet'

const listed = (mentions: string[], max: number): string => mentions.slice(0, max).join(', ') + (mentions.length > max ? `, and ${mentions.length - max} more` : '')

/** What was wrong with the job's text, as a clause in the first person. */
function what(p: UnclearBrief): string {
  if (p.reason === 'none') return 'I found no NEAR account I can read in the brief or your messages'
  if (p.reason === 'many') return `I found more than one account (${listed(p.mentions, 6)}), and each hire checks exactly one`
  return `I found ${listed(p.mentions, 6)}, which I cannot check as written`
}

const notesText = (p: UnclearBrief): string => (p.notes.length ? `\n\n${p.notes.slice(0, 6).map((n) => `- ${n}`).join('\n')}` : '')

/** How the clarifying message starts, so a restarted worker can find it in the thread. */
export const CLARIFY_PREFIX = 'Thanks for hiring A-Identity Guard for NEAR. Before I run the check I need exactly one NEAR account'

/** The marketplace's limit on a thread message, in characters after trimming. */
export const MESSAGE_MAX = 4000

/** The one clarifying message an assignment gets. Deterministic for the same brief, and never over MESSAGE_MAX. */
export function clarifyingMessage(p: UnclearBrief): string {
  const build = (notes: string) =>
    `${CLARIFY_PREFIX}. ${what(p)}.${notes}\n\n` +
    `Please reply in this thread with the one account to check. ${FORMS}\n\n` +
    'I run the check as soon as a reply names exactly one account. A reply that names more than one, or one I cannot check as written, ends the job, and so does no reply by 5 minutes before the delivery deadline. Either way you are refunded in full: nothing is charged for a check that did not run.'
  const full = build(notesText(p))
  return (full.length <= MESSAGE_MAX ? full : build('')).slice(0, MESSAGE_MAX)
}

/** Why a job is handed back before any check ran. */
export type UnclearDecline =
  /** Too little time was left to ask which account to check. */
  | { when: 'no_time'; parse: UnclearBrief }
  /** Asked once; the reply names more than one account, or one that cannot be checked. */
  | { when: 'reply'; parse: UnclearBrief }
  /** Asked once; no reply names an account, and the deadline is near. */
  | { when: 'no_reply'; replied: boolean }
  /** The marketplace refused the question itself, with this error code. */
  | { when: 'refused'; code: string }

function replyProblem(p: UnclearBrief): string {
  if (p.reason === 'none') return 'names no NEAR account I can read'
  if (p.reason === 'many') return `names more than one account (${listed(p.mentions, 4)})`
  return `names only ${p.notes[0] ?? p.mentions[0]}`
}

/**
 * The decline detail (at most 1000 characters) for a job that never named one account. The fixed
 * sentences come first, so a cut can only shorten the reason at the end, never the refund.
 */
export function unclearDeclineDetail(d: UnclearDecline): string {
  const why =
    d.when === 'reply'
      ? `I asked once which account to check, and the reply ${replyProblem(d.parse)}`
      : d.when === 'no_reply'
        ? d.replied
          ? 'I asked once which account to check, and no reply names one I can read; none arrived before the deadline'
          : 'I asked once which account to check, and no reply arrived before the deadline'
        : d.when === 'no_time'
          ? `${what(d.parse)}, and too little time was left before the deadline to ask which one to check`
          : `the marketplace refused my question about which account to check (${asciiEscape(d.code).slice(0, 40)})`
  const text =
    'Declined before any check ran: nothing was checked and you are refunded in full. ' +
    'To try again, hire with exactly one NEAR account: near:testnet:<id>, near:mainnet:<id>, a name ending in .testnet or .near, or a 64-hex implicit account with the word testnet or mainnet. ' +
    `Why: ${why}.`
  return asciiEscape(text).slice(0, 1000)
}
