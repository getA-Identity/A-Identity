import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asideLabel, parseAsideName, walletSets } from './refund.js'

const dir = () => mkdtempSync(join(tmpdir(), 'aid-refund-'))
const algo = (address: string) =>
  JSON.stringify({ version: 1, network: 'algorand-mainnet', address, mnemonic: 'not a real mnemonic', createdAt: '2026-09-28T09:10:24.757Z', purpose: 'test' })
const stellar = (address: string) =>
  JSON.stringify({ version: 1, network: 'stellar-pubnet', address, secret: 'not a real secret', createdAt: '2026-09-28T09:10:24.782Z', purpose: 'test' })

test('parseAsideName: every name a wallet directory accumulates is a set, and nothing else is', () => {
  // The common case, moved aside once: the bare stamp stays the key, so older refund state still matches.
  assert.deepEqual(parseAsideName('algorand-wallet.closed-1790593131000.json', 'algorand-wallet'), { stamp: '1790593131000', movedAsideMs: 1790593131000 })
  // Moved aside, then swept: `wallet sweep` retires the file once more. Dated by the first move.
  assert.deepEqual(parseAsideName('algorand-wallet.closed-1790593131000.closed-1791051007420.json', 'algorand-wallet'), {
    stamp: 'closed-1790593131000.closed-1791051007420',
    movedAsideMs: 1790593131000,
  })
  // Renamed by hand with a day instead of a millisecond stamp.
  assert.deepEqual(parseAsideName('stellar-wallet.old-20260928.json', 'stellar-wallet'), { stamp: 'old-20260928', movedAsideMs: Date.UTC(2026, 8, 28) })
  // A tag that is not a date still counts; it just has no date to sort by.
  assert.deepEqual(parseAsideName('stellar-wallet.old-backup.json', 'stellar-wallet'), { stamp: 'old-backup', movedAsideMs: 0 })
  // Not sets: the current file, other files in the directory, and other suffixes.
  for (const f of [
    'algorand-wallet.json',
    'algorand-wallet.json.bak',
    'algorand-wallet-2.closed-1790593131000.json',
    'algorand-wallet.closed-1790593131000.done-5.json',
    'algorand-wallet.closed-.json',
    'refund-1790593131000.json',
    'bridge-state.closed-1790593131000.json',
  ]) {
    assert.equal(parseAsideName(f, 'algorand-wallet'), null, f)
  }
})

test('walletSets: every set moved aside is found however it was named, oldest first, with its own state file', () => {
  const d = dir()
  writeFileSync(join(d, 'algorand-wallet.json'), algo('A0'))
  // A round from 2026-09-28 whose Algorand file was swept afterwards (two .closed- parts) while the
  // Stellar file was moved aside once: two keys, both found.
  writeFileSync(join(d, 'algorand-wallet.closed-1790593131000.closed-1791051007420.json'), algo('A1'))
  writeFileSync(join(d, 'stellar-wallet.closed-1790593131000.json'), stellar('S1'))
  // A Stellar wallet renamed by hand, earlier the same day.
  writeFileSync(join(d, 'stellar-wallet.old-20260928.json'), stellar('S0'))
  // A later round moved aside once, both files sharing the stamp.
  writeFileSync(join(d, 'algorand-wallet.closed-1791398331996.json'), algo('A2'))
  writeFileSync(join(d, 'stellar-wallet.closed-1791398331996.json'), stellar('S2'))
  // Noise that must not become a set.
  writeFileSync(join(d, 'refund-1791398331996.json'), '{"version":1}')
  writeFileSync(join(d, 'bridge-state.closed-1791398331996.json'), '{"version":1}')
  writeFileSync(join(d, 'buy-state.json'), '{"version":1}')

  const sets = walletSets({ algorandPath: join(d, 'algorand-wallet.json'), stellarPath: join(d, 'stellar-wallet.json'), statePath: join(d, 'bridge-state.json') })
  assert.deepEqual(
    sets.map((s) => s.stamp),
    [null, 'old-20260928', '1790593131000', 'closed-1790593131000.closed-1791051007420', '1791398331996'],
  )
  assert.deepEqual(
    sets.map((s) => s.statePath),
    [
      join(d, 'bridge-state.json'),
      join(d, 'refund-old-20260928.json'),
      join(d, 'refund-1790593131000.json'),
      join(d, 'refund-closed-1790593131000.closed-1791051007420.json'),
      join(d, 'refund-1791398331996.json'),
    ],
  )
  assert.deepEqual(
    sets.map((s) => [s.algorand?.address ?? null, s.stellar?.address ?? null]),
    [
      ['A0', null],
      [null, 'S0'],
      [null, 'S1'],
      ['A1', null],
      ['A2', 'S2'],
    ],
  )
  // The sweep command of a moved-aside set must point at that set's own key file.
  assert.equal(sets[3].algorandPath, join(d, 'algorand-wallet.closed-1790593131000.closed-1791051007420.json'))
  assert.equal(sets[4].algorandPath, join(d, 'algorand-wallet.closed-1791398331996.json'))
  // Labels name the day a set was moved aside, and fall back to the key when there is none.
  assert.equal(asideLabel(sets[0]), 'The current wallets')
  assert.equal(asideLabel(sets[1]), 'Wallets moved aside on 2026-09-28 00:00 UTC')
  assert.equal(asideLabel(sets[3]), 'Wallets moved aside on 2026-09-28 10:58 UTC')
  assert.equal(asideLabel({ ...sets[1], stamp: 'old-backup', movedAsideMs: 0 }), 'Wallets moved aside (old-backup)')
})

test('walletSets: a moved-aside file that is not a wallet is skipped, not fatal', () => {
  const d = dir()
  writeFileSync(join(d, 'stellar-wallet.closed-1791398331996.json'), '{}')
  writeFileSync(join(d, 'algorand-wallet.closed-1791398331996.json'), 'not json')
  writeFileSync(join(d, 'stellar-wallet.closed-1791398331997.json'), stellar('S9'))
  const sets = walletSets({ algorandPath: join(d, 'algorand-wallet.json'), stellarPath: join(d, 'stellar-wallet.json'), statePath: join(d, 'bridge-state.json') })
  assert.deepEqual(sets.map((s) => s.stamp), ['1791398331997'])
})
