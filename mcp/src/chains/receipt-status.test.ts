/**
 * Every broadcast write must read the receipt's status before calling itself executed.
 *
 * Nine writes in the EVM adapter awaited `waitForTransactionReceipt` and threw the result
 * away, then returned `{ executed: true, txHash, explorerUrl }`. A REVERTED transaction has
 * a receipt, a hash and a working explorer link, so every one of those was indistinguishable
 * from a success: a vault deploy that reverted handed back `vault: null` cast to a string, a
 * reputation attestation that reverted was recorded as an attestation, and an over-limit
 * `pay()` that the contract correctly refused was reported to the owner as a payment.
 *
 * That is the exact defect the Soroban adapter grew its five-arm `CallOutcome` to prevent,
 * left standing in the sibling that never got the fix. Correcting the nine sites is not
 * enough on its own, because the tenth is one `await` away and nothing would notice.
 *
 * So this reads the source. A guard that cannot be satisfied by mocking is the point: it
 * costs nothing, needs no chain, and goes red the moment someone adds a write that skips
 * the check. Delete any one of the checks below and this test fails, which is what makes it
 * a control rather than a comment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// These run from dist/, so resolve the SOURCE the same way the sibling guards do. Reading
// the compiled output would work for the status checks and miss the type declarations
// entirely, which is half of what this file is here to hold in place.
const SRC = fileURLToPath(new URL('../../src/chains/', import.meta.url))
const EVM_DIR = join(SRC, 'evm')

/** A status check is any of these within reach of the await. `landed()` is the shared
 *  helper and does the same read, so naming it counts. */
const CHECKS = [/\.status !== 'success'/, /\.status === 'success'/, /\blanded\(/]

/** How far after the await we look. Every real check in this file is within a few lines;
 *  a generous window still fails a site that has no check at all. */
const WINDOW = 8

/** Code only. A comment may name the fallback client's wait to say why it is not used. */
const codeLines = (file: string) =>
  readFileSync(join(EVM_DIR, file), 'utf8').split('\n').map((l) => (/^\s*(\*|\/\/|\/\*)/.test(l) ? '' : l))

test('no receipt in the EVM adapter is awaited through the fallback client', () => {
  // A host with no receipt answers null, the fallback takes that as the answer, and so the wait
  // sits on the first host until it times out. receiptOf reads every RPC; this keeps it that way.
  const files = readdirSync(EVM_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const raw: string[] = []
  for (const file of files) {
    codeLines(file).forEach((line, i) => {
      if (line.includes('waitForTransactionReceipt')) raw.push(`${file}:${i + 1}  ${line.trim()}`)
    })
  }
  assert.deepEqual(raw, [], 'these wait on the fallback client, which never asks a second host about a null receipt')
})

test('every receipt read in the EVM adapter is followed by a status check', () => {
  const files = readdirSync(EVM_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  assert.ok(files.length > 0, 'found no EVM adapter sources to check, which means this guard is not running')

  const unchecked: string[] = []
  let sites = 0
  let viaHelper = 0

  for (const file of files) {
    const lines = codeLines(file)
    lines.forEach((line, i) => {
      if (!/await receiptOf\(/.test(line)) return
      // The helper's own body is where the check lives, so it is not a call site.
      if (lines.slice(Math.max(0, i - 6), i).some((l) => /async function landed\(/.test(l))) return
      sites++
      const near = lines.slice(i, i + WINDOW).join('\n')
      if (!CHECKS.some((re) => re.test(near))) {
        unchecked.push(`${file}:${i + 1}  ${line.trim()}`)
      }
    })
  }

  // Count the helper's callers too. A write that delegates to `landed()` no longer mentions
  // `receiptOf` at all, so counting only the direct reads would let the floor fall every time
  // a site is converted, which is backwards.
  for (const file of files) {
    for (const line of readFileSync(join(EVM_DIR, file), 'utf8').split('\n')) {
      if (/await landed\(/.test(line)) viaHelper++
    }
  }
  const writes = sites + viaHelper
  assert.ok(writes >= 18, `expected the adapter to still contain its broadcast writes, found only ${writes} (${sites} raw + ${viaHelper} via landed)`)
  assert.deepEqual(
    unchecked,
    [],
    'these writes await a receipt and never read its status, so a reverted transaction is ' +
      'reported as executed:\n  ' + unchecked.join('\n  '),
  )
})

test('the Unconfirmed arm exists and cannot be read as a revert or as prepared', () => {
  const types = readFileSync(join(SRC, 'types.ts'), 'utf8')
  assert.match(types, /export type Unconfirmed = \{[^}]*reverted: false[^}]*unconfirmed: true[^}]*txHash: string/s,
    'a broadcast with no receipt needs its own arm, with the hash, or it will be reported as a revert again')
  assert.match(types, /export type VaultResult = [^\n]*\bUnconfirmed\b/)
})

test('the Reverted arm exists, because without it there is nowhere to put a failure', () => {
  const types = readFileSync(join(SRC, 'types.ts'), 'utf8')
  assert.match(types, /export type Reverted = \{[^}]*reverted: true/s,
    'chains/types.ts must define a Reverted arm; Prepared | Executed models only "not broadcast" and "succeeded"')
  assert.match(types, /export type Prepared = \{[^}]*reverted\?: false/s,
    'Prepared must carry reverted?: false so callers can narrow between "we never asked" and "the chain said no"')
})
