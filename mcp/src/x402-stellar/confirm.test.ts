import test from 'node:test'
import assert from 'node:assert/strict'
import { rpc } from '@stellar/stellar-sdk'

import { confirmStellarTransfer } from './confirm.js'
import { getChainById } from '../chains/registry.js'

/**
 * These are the REAL contract-event bytes from settlement 3da74634... on Stellar testnet,
 * ledger 4147945, captured verbatim. Decoding actual bytes offline is the point: a
 * hand-written fixture would only prove the decoder agrees with whatever the author
 * imagined the event looked like, which is exactly the assumption that produced the dead
 * explorer link earlier in this work.
 *
 * The first is the SAC's transfer, the second is the vault's own Paid event. Both are
 * present on a real settlement, so the decoder has to pick the right one.
 */
const REAL_SAC_TRANSFER =
  'AAAAAAAAAAFQRc1ewHKado/VrQJQWFLfTwKNzoMOWsUiCbpISDsvAQAAAAEAAAAAAAAABAAAAA8AAAAIdHJhbnNmZXIAAAASAAAAARC/EFEAelpSMO8j908vvGIhu1Lfd4n5vqZpZARm1lxAAAAAEgAAAAAAAAAAWRstfyzs2GS1teYtvEc9OLSCQzWAMdOUvgStWL6REgYAAAAOAAAAPVVTREM6R0JCRDQ3SUY2TFdLN1A3TURFVlNDV1I3RFBVV1YzTlkzRFRRRVZGTDROQVQ0QVFIM1pMTEZMQTUAAAAAAAAKAAAAAAAAAAAAAAAAAJiWgA=='
const REAL_VAULT_PAID =
  'AAAAAAAAAAEQvxBRAHpaUjDvI/dPL7xiIbtS33eJ+b6maWQEZtZcQAAAAAEAAAAAAAAAAwAAAA8AAAAEcGFpZAAAABIAAAAAAAAAAFkbLX8s7NhktbXmLbxHPTi0gkM1gDHTlL4ErVi+kRIGAAAABQAAAAAAAFDIAAAAEQAAAAEAAAACAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAAmJaAAAAADwAAAAhieV9vd25lcgAAAAAAAAAA'

const CHAIN = getChainById('stellar-testnet')!
const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const PAYEE = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'
const VAULT = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'
const HASH = '3da7463422c7d122202b009bb27442199ffc3b6da87da12a7112963bf4bcc999'
const ONE_USDC = 10_000_000n

/** A stub RPC that hands back one canned response. No network, ever. */
const serverReturning = (response: unknown) => ({
  getTransaction: async () => response as never,
})

const success = (events: string[]) => ({
  status: rpc.Api.GetTransactionStatus.SUCCESS,
  ledger: 4147945,
  events: { contractEventsXdr: [events] },
})

const deps = (response: unknown) => ({
  server: serverReturning(response),
  timeoutMs: 50,
  pollMs: 1,
  sleep: async () => {},
})

test('a real settlement confirms, and the facts come off the chain not the request', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: SAC, to: PAYEE, amountRaw: ONE_USDC },
    deps(success([REAL_SAC_TRANSFER, REAL_VAULT_PAID])),
  )
  assert.equal(r.confirmed, true)
  if (!r.confirmed) return
  assert.equal(r.ledger, 4147945)
  // `from` is read out of the event, so it reports the vault that actually paid rather
  // than echoing anything the caller supplied.
  assert.equal(r.from, VAULT)
  assert.equal(r.amountRaw, '10000000')
  assert.match(r.asset, /^USDC:GBBD47IF/)
})

test('one base unit off is not our settlement', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: SAC, to: PAYEE, amountRaw: ONE_USDC + 1n },
    deps(success([REAL_SAC_TRANSFER])),
  )
  assert.equal(r.confirmed, false)
  if (r.confirmed) return
  assert.equal(r.code, 'no_matching_transfer')
  // It must report what it DID see, or a mismatch is undebuggable in production.
  assert.equal(r.sawTransfers?.[0]?.amountRaw, '10000000')
})

test('a transfer to someone else is not our settlement', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: SAC, to: VAULT, amountRaw: ONE_USDC },
    deps(success([REAL_SAC_TRANSFER])),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'no_matching_transfer')
})

test('the right amount to the right payee on the WRONG token is refused', async () => {
  // The sharpest version of the attack this guards: a worthless token can emit an event
  // with our payee and our number in it.
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAAA', to: PAYEE, amountRaw: ONE_USDC },
    deps(success([REAL_SAC_TRANSFER])),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'no_matching_transfer')
})

test('a successful transaction with no transfer at all is refused', async () => {
  // The vault's own Paid event says a payment happened. It is not evidence that one did:
  // only the token can say that.
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: SAC, to: PAYEE, amountRaw: ONE_USDC },
    deps(success([REAL_VAULT_PAID])),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'no_matching_transfer')
    assert.deepEqual(r.sawTransfers, [], 'the vault event is not a transfer')
  }
})

test('a failed transaction is decided, and decided against', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: SAC, to: PAYEE, amountRaw: ONE_USDC },
    deps({ status: rpc.Api.GetTransactionStatus.FAILED, ledger: 4147972 }),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'tx_failed')
    assert.equal(r.ledger, 4147972)
  }
})

test('a transaction that has not landed is undecided, not refused', async () => {
  // The distinction that matters most operationally: not_found may still become settled,
  // so it must never be recorded as a refusal and never retried blindly.
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: SAC, to: PAYEE, amountRaw: ONE_USDC },
    deps({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'not_found')
    assert.match(r.reason, /NOT a refusal/)
  }
})

test('an unreachable RPC is its own outcome, never a silent refusal', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: SAC, to: PAYEE, amountRaw: ONE_USDC },
    {
      server: {
        getTransaction: async () => {
          throw new Error('connect ECONNREFUSED')
        },
      },
      timeoutMs: 50,
      pollMs: 1,
      sleep: async () => {},
    },
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'unreachable')
})

test('a malformed event does not hide the good one next to it', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac: SAC, to: PAYEE, amountRaw: ONE_USDC },
    deps(success(['not-base64-at-all', REAL_SAC_TRANSFER])),
  )
  assert.equal(r.confirmed, true, 'one undecodable event must not lose the rest')
})
