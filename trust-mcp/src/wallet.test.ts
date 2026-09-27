import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as algosdk from 'algosdk'
import { buildOptIn, buildSweep, createWallet, loadWallet, nextStep, USDC_ASSET, type WalletStatus } from './wallet.js'
import { runCli } from './cli.js'

const dir = () => mkdtempSync(join(tmpdir(), 'aid-wallet-'))

const PARAMS = {
  fee: 1000,
  flatFee: true,
  minFee: 1000,
  firstValid: 100,
  lastValid: 1100,
  genesisID: 'mainnet-v1.0',
  genesisHash: Uint8Array.from(Buffer.from('wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=', 'base64')),
}

test('wallet new writes a file only its owner can read, once, and keeps the same wallet after that', () => {
  const path = join(dir(), 'nested', 'wallet.json')
  const first = createWallet(path)
  assert.equal(first.created, true)
  assert.ok(algosdk.isValidAddress(first.address))
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700)
  const w = loadWallet(path)!
  assert.equal(w.address, first.address)
  assert.equal(algosdk.mnemonicToSecretKey(w.mnemonic).addr.toString(), first.address, 'the saved words are the key to that address')

  const again = createWallet(path)
  assert.deepEqual(again, { address: first.address, created: false })
})

test('no command ever prints the 25 words', async () => {
  const d = dir()
  const env = { A_IDENTITY_KEYFILE: join(d, 'w.json'), A_IDENTITY_ALGOD_URL: 'https://algod.test' }
  const lines: string[] = []
  const algod = (async () => new Response(JSON.stringify({ message: 'no accounts found' }), { status: 404 })) as typeof fetch
  assert.equal(await runCli(['wallet', 'new'], env, (l) => lines.push(l), algod), 0)
  assert.equal(await runCli(['wallet', 'status'], env, (l) => lines.push(l), algod), 0)
  const words = loadWallet(env.A_IDENTITY_KEYFILE)!.mnemonic.split(' ')
  const printed = lines.join('\n')
  assert.match(printed, /Send 0.3 ALGO/)
  // Common words can appear in prose by chance; two secret words in a row cannot.
  for (let i = 0; i + 1 < words.length; i++) {
    assert.ok(!printed.includes(`${words[i]} ${words[i + 1]}`), `secret words ${i} and ${i + 1} were printed`)
  }
})

test('the next step walks a person through funding in the only order that works', () => {
  const base: WalletStatus = { address: 'ADDR', exists: false, algo: 0, minBalanceAlgo: 0.1, usdcOptedIn: false, usdc: 0, otherAssets: 0 }
  assert.match(nextStep(base), /Send 0.3 ALGO .* Send only ALGO for now/)
  assert.match(nextStep({ ...base, exists: true, algo: 0.3 }), /wallet optin/)
  assert.match(nextStep({ ...base, exists: true, algo: 0.299, usdcOptedIn: true, usdc: 1 }), /Send USDC .* costs 5 USDC; it holds 1/)
  assert.match(nextStep({ ...base, exists: true, algo: 0.299, usdcOptedIn: true, usdc: 6 }), /^Ready\. Run: .* check/)
})

test('opt-in is a zero USDC transfer to itself, and sweep closes USDC then ALGO to the named address in one group', () => {
  const me = algosdk.generateAccount().addr.toString()
  const home = algosdk.generateAccount().addr.toString()
  const optin = buildOptIn(me, PARAMS)
  assert.equal(optin.type, 'axfer')
  assert.equal(optin.assetTransfer?.assetIndex, BigInt(USDC_ASSET))
  assert.equal(optin.assetTransfer?.amount, 0n)
  assert.equal(optin.assetTransfer?.receiver.toString(), me)

  const [usdcOut, algoOut] = buildSweep(me, home, home, PARAMS)
  assert.equal(usdcOut.assetTransfer?.closeRemainderTo?.toString(), home)
  assert.equal(algoOut.type, 'pay')
  assert.equal(algoOut.payment?.closeRemainderTo?.toString(), home)
  assert.ok(usdcOut.group && algoOut.group && Buffer.from(usdcOut.group).equals(Buffer.from(algoOut.group)), 'one atomic group')

  const onlyAlgo = buildSweep(me, home, null, PARAMS)
  assert.equal(onlyAlgo.length, 1, 'a wallet that never held USDC just closes its ALGO')
})
