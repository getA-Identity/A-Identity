import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import {
  forwarderHookData,
  evmAddressToBytes32,
  contractStrkeyToBytes32,
  usdcUnits6,
  units7From6,
  cctpSide,
  maxFeeFor,
  irisHost,
  irisTxHash,
  bridgeEvmToStellar,
  bridgeStellarToEvm,
  bridgeCctp,
  cctpStellarStatus,
  ZERO_BYTES32,
  type CctpDeps,
  type IrisMessage,
} from './cctp-stellar.js'
import { CHAINS, getChainById } from './chains/index.js'

/**
 * The CCTP Stellar path, dry. Two things it must never get wrong, because Circle's
 * reference says the funds are then gone: a Stellar recipient goes in the hook data with
 * the forwarder in BOTH address slots, and the hook bytes are laid out exactly as Circle's
 * builder writes them. Everything else is prepared-or-executed discipline and the
 * registry declarations being what Circle's pages say.
 */

const arc = getChainById('arc')!
const stellarTestnet = getChainById('stellar-testnet')!
const EVM_KEY = '0x' + '11'.repeat(32)
const EVM_ADDR = '0x2222222222222222222222222222222222222222'
const G = Keypair.random().publicKey()
const SEED = Keypair.random().secret()
const BURN_TX = '0x' + 'ab'.repeat(32)
const MESSAGE = '0x' + 'cd'.repeat(80)
const ATTESTATION = '0x' + 'ef'.repeat(65)

test('the forwarder hook data is laid out exactly as Circle\'s builder writes it', () => {
  const hex = forwarderHookData(G)
  const buf = Buffer.from(hex.slice(2), 'hex')
  assert.equal(buf.length, 32 + 56)
  assert.ok(buf.subarray(0, 24).every((b) => b === 0), 'magic bytes are zero')
  assert.equal(buf.readUInt32BE(24), 0, 'version 0')
  assert.equal(buf.readUInt32BE(28), 56, 'length of a G... StrKey')
  assert.equal(buf.subarray(32).toString('utf8'), G)
  assert.throws(() => forwarderHookData('GNOTAKEY'), /forward recipient/)
  assert.throws(() => forwarderHookData(EVM_ADDR), /forward recipient/)
})

test('address payloads: an EVM address is left-padded, a Stellar contract is its raw 32 bytes', async () => {
  assert.equal(evmAddressToBytes32(EVM_ADDR), '0x' + '0'.repeat(24) + '2222222222222222222222222222222222222222')
  assert.throws(() => evmAddressToBytes32(G))
  const forwarder = stellarTestnet.contracts.cctp!.forwarder!
  const got = await contractStrkeyToBytes32(forwarder)
  assert.equal(got, '0x' + Buffer.from(StrKey.decodeContract(forwarder)).toString('hex'))
  assert.equal(got.length, 66)
  await assert.rejects(contractStrkeyToBytes32(G))
})

test('six-decimal message units and seven-decimal Stellar subunits never meet through a float', () => {
  assert.equal(usdcUnits6(0.2), 200000n)
  assert.equal(usdcUnits6(0.001), 1000n)
  assert.equal(units7From6(200000n), 2000000n)
  assert.equal(units7From6(123456n), 1234560n)
})

test('maxFee is Circle\'s basis points of the amount with a tenth of headroom, and zero when the tier is zero', () => {
  assert.equal(maxFeeFor(1_000_000n, [{ finalityThreshold: 1000, minimumFee: 0 }, { finalityThreshold: 2000, minimumFee: 0 }], 2000), 0n)
  // 15 bps of 1 USDC = 1500 units, plus a tenth and one.
  assert.equal(maxFeeFor(1_000_000n, [{ finalityThreshold: 1000, minimumFee: 15 }, { finalityThreshold: 2000, minimumFee: 0 }], 1000), 1651n)
  assert.equal(maxFeeFor(1_000_000n, [], 2000), 0n)
})

test('Iris: one host per environment, and only hex hashes are lowercased', () => {
  assert.equal(irisHost(true), 'https://iris-api-sandbox.circle.com')
  assert.equal(irisHost(false), 'https://iris-api.circle.com')
  assert.equal(irisTxHash('0xABCD'), '0xabcd')
  assert.equal(irisTxHash('5Kbase58SignatureCase'), '5Kbase58SignatureCase')
})

test('a side needs a domain, Circle-verified contracts and USDC; the registry says which chains have them', () => {
  const a = cctpSide('arc')
  assert.ok(!('error' in a))
  assert.equal(a.domain, 26)
  assert.equal(a.usdcDecimals, 6)
  const s = cctpSide('stellar-testnet')
  assert.ok(!('error' in s))
  assert.equal(s.domain, 27)
  assert.equal(s.usdcDecimals, 7)
  assert.match(s.usdc, /^C/)
  assert.ok(s.contracts.forwarder)
  const rh = cctpSide('rhchain')
  assert.ok('error' in rh)
  assert.match(rh.error, /no CCTP domain|no CCTP contracts/)
  assert.ok('error' in cctpSide('nope'))
  assert.ok('error' in cctpSide('algorand'))
})

test('every registry CCTP declaration is Circle\'s: one EVM address set per environment, C... ids and a forwarder on Stellar, domains and citations present', () => {
  const declared = CHAINS.filter((c) => c.contracts.cctp)
  for (const id of ['arc', 'base', 'arbitrum', 'xlayer', 'stellar', 'stellar-testnet']) assert.ok(declared.some((c) => c.id === id), `${id} declares CCTP`)
  const evmMain = declared.filter((c) => c.ecosystem === 'evm' && !c.testnet)
  const evmTest = declared.filter((c) => c.ecosystem === 'evm' && c.testnet)
  for (const group of [evmMain, evmTest]) {
    const tm = new Set(group.map((c) => c.contracts.cctp!.tokenMessenger.toLowerCase()))
    const mt = new Set(group.map((c) => c.contracts.cctp!.messageTransmitter.toLowerCase()))
    assert.equal(tm.size, 1, 'Circle deploys one TokenMessengerV2 address per environment')
    assert.equal(mt.size, 1, 'Circle deploys one MessageTransmitterV2 address per environment')
  }
  for (const c of declared) {
    assert.notEqual(c.cctpDomain, null, `${c.id}: a CCTP domain`)
    assert.match(c.contracts.cctp!.verified, /developers\.circle\.com\/cctp/, `${c.id}: cites Circle's page`)
    if (c.ecosystem === 'stellar') {
      for (const k of ['tokenMessenger', 'messageTransmitter', 'forwarder'] as const) assert.ok(StrKey.isValidContract(c.contracts.cctp![k] as string), `${c.id}: ${k} is a C... id`)
      assert.equal(c.cctpDomain, 27)
    } else {
      assert.match(c.contracts.cctp!.tokenMessenger, /^0x[0-9a-fA-F]{40}$/)
      assert.equal(c.contracts.cctp!.forwarder, undefined, `${c.id}: a forwarder is a Stellar thing`)
    }
  }
  assert.equal(getChainById('xlayer')!.cctpDomain, 37)
  assert.equal(getChainById('base')!.cctpDomain, 6)
})

// ── dry flows ─────────────────────────────────────────────────────────────────────

type Log = { evmWrites: { functionName: string; args: unknown[]; to: string }[]; stellarInvokes: { contract: string; method: string; args: unknown[] }[]; irisCalls: number }

function fakes(over: { allowance?: bigint; balance?: bigint; iris?: IrisMessage[]; env?: NodeJS.ProcessEnv; stellarStatus?: 'success' | 'failed' } = {}): { deps: CctpDeps; log: Log } {
  const log: Log = { evmWrites: [], stellarInvokes: [], irisCalls: 0 }
  const irisSeq = over.iris ?? [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION, eventNonce: '0x01' }]
  const deps: CctpDeps = {
    env: over.env ?? ({ ARC_SIGNER_KEY: EVM_KEY, CCTP_STELLAR_TESTNET_SECRET: SEED } as NodeJS.ProcessEnv),
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 1000) })(),
    irisMaxWaitMs: 10_000,
    irisPollMs: 1,
    evm: {
      allowance: async () => over.allowance ?? 0n,
      balance: async () => over.balance ?? 10_000_000n,
      signerAddress: async () => EVM_ADDR,
      write: async (_s, _k, call) => { log.evmWrites.push({ functionName: call.functionName, args: call.args, to: call.to }); return { txHash: BURN_TX, status: 'success', blockNumber: '1' } },
    },
    stellar: {
      currentLedger: async () => 1000,
      balance: async () => over.balance ?? 10_000_000n,
      publicKey: (s) => Keypair.fromSecret(s).publicKey(),
      invoke: async (_s, _k, call) => { log.stellarInvokes.push(call); return { txHash: 'f'.repeat(64), status: over.stellarStatus ?? 'success', ledger: 5 } },
    },
    iris: {
      fees: async () => [{ finalityThreshold: 1000, minimumFee: 0 }, { finalityThreshold: 2000, minimumFee: 0 }],
      message: async () => { const m = irisSeq[Math.min(log.irisCalls, irisSeq.length - 1)]; log.irisCalls += 1; return m },
    },
  }
  return { deps, log }
}

test('EVM -> Stellar without execute is fully prepared: forwarder in both slots, recipient in the hook, nothing sent', async () => {
  const { deps, log } = fakes()
  const r = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2, recipient: G }, deps)
  assert.ok(!('error' in r))
  assert.equal(r.executed, false)
  assert.equal(r.amountUnits6, '200000')
  assert.equal(r.steps.length, 4)
  assert.ok(r.steps.every((s) => s.state === 'prepared'))
  const burn = r.steps[1]
  assert.equal(burn.function, 'depositForBurnWithHook')
  const forwarder32 = await contractStrkeyToBytes32(stellarTestnet.contracts.cctp!.forwarder!)
  assert.equal(burn.args![2], forwarder32, 'mintRecipient is the forwarder')
  assert.equal(burn.args![4], forwarder32, 'destinationCaller is the forwarder')
  assert.equal(burn.args![1], 27)
  assert.equal(burn.args![7], forwarderHookData(G))
  assert.equal(log.evmWrites.length, 0)
  assert.equal(log.stellarInvokes.length, 0)
})

test('the recipient defaults to the Stellar bridging signer, and is refused when neither exists', async () => {
  const { deps } = fakes()
  const r = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2 }, deps)
  assert.ok(!('error' in r))
  assert.equal(r.recipient, Keypair.fromSecret(SEED).publicKey())
  const none = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2 }, { ...deps, env: {} as NodeJS.ProcessEnv })
  assert.ok('error' in none)
  assert.match(none.error, /recipient/)
})

test('mainnet is refused without the opt-in, a testnet-mainnet mix always, and the cap always', async () => {
  const { deps } = fakes()
  const main = await bridgeEvmToStellar({ from: 'base', to: 'stellar', amountUsd: 1, recipient: G, execute: true }, deps)
  assert.ok('error' in main)
  assert.match(main.error, /CCTP_STELLAR_ALLOW_MAINNET/)
  const dry = await bridgeEvmToStellar({ from: 'base', to: 'stellar', amountUsd: 1, recipient: G }, deps)
  assert.ok(!('error' in dry), 'a dry mainnet run is allowed: it broadcasts nothing')
  const mix = await bridgeEvmToStellar({ from: 'arc', to: 'stellar', amountUsd: 1, recipient: G }, deps)
  assert.ok('error' in mix)
  const big = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 50, recipient: G }, deps)
  assert.ok('error' in big)
  assert.match(big.error, /cap/)
})

test('EVM -> Stellar executed: allowance reused, burn confirmed, Iris polled to complete, mint_and_forward submitted once', async () => {
  const { deps, log } = fakes({ allowance: 10_000_000n, iris: [{ status: 'pending_confirmations' }, { status: 'complete', message: MESSAGE, attestation: ATTESTATION, eventNonce: '0x07' }] })
  const r = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2, recipient: G, execute: true }, deps)
  assert.ok(!('error' in r))
  assert.equal(r.executed, true)
  assert.equal(r.reason, undefined)
  assert.equal(r.steps[0].state, 'skipped')
  assert.equal(r.steps[1].state, 'confirmed')
  assert.equal(r.steps[1].txHash, BURN_TX)
  assert.match(r.steps[1].explorerUrl!, new RegExp(`^${arc.explorer}/tx/`))
  assert.equal(r.steps[2].state, 'confirmed')
  assert.equal(r.steps[3].state, 'confirmed')
  assert.equal(r.steps[3].contract, stellarTestnet.contracts.cctp!.forwarder)
  assert.equal(log.evmWrites.length, 1)
  assert.equal(log.evmWrites[0].functionName, 'depositForBurnWithHook')
  assert.equal(log.stellarInvokes.length, 1)
  assert.equal(log.stellarInvokes[0].method, 'mint_and_forward')
  assert.equal(log.irisCalls, 2)
  assert.deepEqual(r.attested, { message: MESSAGE, attestation: ATTESTATION, eventNonce: '0x07' })
})

test('EVM -> Stellar executed without a Stellar signer stops after attestation with the mint prepared and the payload attached', async () => {
  const { deps, log } = fakes({ env: { ARC_SIGNER_KEY: EVM_KEY } as NodeJS.ProcessEnv })
  const r = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2, recipient: G, execute: true }, deps)
  assert.ok(!('error' in r))
  assert.equal(r.executed, true)
  assert.equal(r.steps[3].state, 'prepared')
  assert.deepEqual(r.steps[3].args, [MESSAGE, ATTESTATION])
  assert.match(r.reason ?? '', /prepared, not submitted/)
  assert.equal(log.stellarInvokes.length, 0)
})

test('an insufficient balance and a burn that reverts both stop before anything else, and say so', async () => {
  const poor = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2, recipient: G, execute: true }, fakes({ balance: 1n }).deps)
  assert.ok(!('error' in poor))
  assert.equal(poor.executed, false)
  assert.match(poor.reason ?? '', /holds 1 USDC units/)
  const { deps, log } = fakes({ allowance: 10_000_000n })
  deps.evm!.write = async (_s, _k, call) => { log.evmWrites.push({ functionName: call.functionName, args: call.args, to: call.to }); return { txHash: BURN_TX, status: 'reverted' } }
  const rev = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2, recipient: G, execute: true }, deps)
  assert.ok(!('error' in rev))
  assert.equal(rev.executed, false)
  assert.match(rev.reason ?? '', /burn reverted/)
  assert.equal(log.irisCalls, 0)
})

test('Iris not completing inside the window leaves the leg pending with the burn hash to resume from', async () => {
  const { deps } = fakes({ allowance: 10_000_000n, iris: [{ status: 'pending_confirmations', delayReason: 'insufficient_fee' }] })
  const r = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2, recipient: G, execute: true }, deps)
  assert.ok(!('error' in r))
  assert.equal(r.executed, true)
  const iris = r.steps.find((s) => s.name === 'Iris attestation')!
  assert.equal(iris.state, 'pending')
  assert.equal(iris.detail?.burnTx, BURN_TX)
  assert.equal(iris.detail?.delayReason, 'insufficient_fee')
  assert.match(r.reason ?? '', /resumeBurnTx/)
  // Resuming skips the burn and goes straight to Iris.
  const { deps: d2, log } = fakes({ allowance: 10_000_000n })
  const resumed = await bridgeEvmToStellar({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.2, recipient: G, execute: true, resumeBurnTx: BURN_TX }, d2)
  assert.ok(!('error' in resumed))
  assert.equal(log.evmWrites.length, 0)
  assert.equal(resumed.steps[0].reason, 'resumed from an earlier burn')
  assert.equal(resumed.steps[2].state, 'confirmed')
})

test('Stellar -> EVM executed: SAC approve with a short expiry, deposit_for_burn in seven-decimal subunits to the padded recipient, receiveMessage on the transmitter', async () => {
  const { deps, log } = fakes()
  const r = await bridgeStellarToEvm({ from: 'stellar-testnet', to: 'arc', amountUsd: 0.15, execute: true }, deps)
  assert.ok(!('error' in r), JSON.stringify(r))
  assert.equal(r.executed, true)
  assert.equal(r.reason, undefined)
  assert.equal(r.recipient, EVM_ADDR, 'defaults to the EVM signer')
  assert.equal(log.stellarInvokes.length, 2)
  assert.equal(log.stellarInvokes[0].method, 'approve')
  assert.equal(log.stellarInvokes[0].contract, cctpSide('stellar-testnet') && (cctpSide('stellar-testnet') as { usdc: string }).usdc)
  assert.equal(log.stellarInvokes[1].method, 'deposit_for_burn')
  assert.equal(log.stellarInvokes[1].contract, stellarTestnet.contracts.cctp!.tokenMessenger)
  const burn = r.steps.find((s) => s.name === 'deposit_for_burn')!
  assert.equal(burn.args![1], '1500000', 'seven-decimal subunits')
  assert.equal(burn.args![2], 26)
  assert.equal(burn.args![3], evmAddressToBytes32(EVM_ADDR))
  assert.equal(burn.args![5], ZERO_BYTES32, 'permissionless mint')
  assert.equal(burn.args![7], 2000)
  assert.equal((r.steps.find((s) => s.name.includes('approve'))!.detail as { expiryLedger: number }).expiryLedger, 1100)
  assert.equal(log.evmWrites.length, 1)
  assert.equal(log.evmWrites[0].functionName, 'receiveMessage')
  assert.equal(log.evmWrites[0].to, arc.contracts.cctp!.messageTransmitter)
  assert.deepEqual(log.evmWrites[0].args, [MESSAGE, ATTESTATION])
  assert.equal(r.steps[r.steps.length - 1].state, 'confirmed')
})

test('Stellar -> EVM: a refused approve stops the leg; no burn, no Iris', async () => {
  const { deps, log } = fakes({ stellarStatus: 'failed' })
  const r = await bridgeStellarToEvm({ from: 'stellar-testnet', to: 'arc', amountUsd: 0.15, execute: true }, deps)
  assert.ok(!('error' in r))
  assert.equal(r.executed, false)
  assert.match(r.reason ?? '', /approve failed/)
  assert.equal(log.stellarInvokes.length, 1)
  assert.equal(log.irisCalls, 0)
})

test('bridgeCctp routes by the source ecosystem, and both directions refuse a wrong pairing', async () => {
  const { deps } = fakes()
  const a = await bridgeCctp({ from: 'stellar-testnet', to: 'arc', amountUsd: 0.1 }, deps)
  assert.ok(!('error' in a) && a.direction === 'stellar-to-evm')
  const b = await bridgeCctp({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.1, recipient: G }, deps)
  assert.ok(!('error' in b) && b.direction === 'evm-to-stellar')
  assert.ok('error' in (await bridgeEvmToStellar({ from: 'stellar-testnet', to: 'arc', amountUsd: 0.1 }, deps)))
  assert.ok('error' in (await bridgeStellarToEvm({ from: 'arc', to: 'stellar-testnet', amountUsd: 0.1 }, deps)))
  assert.ok('error' in (await bridgeCctp({ from: 'nope', to: 'arc', amountUsd: 0.1 }, deps)))
})

test('the status names every CCTP side, its Circle contracts, and whether a signer is present, without leaking one', () => {
  const s = cctpStellarStatus({} as NodeJS.ProcessEnv)
  assert.equal(s.mainnetAllowed, false)
  assert.equal(s.maxUsd, 5)
  for (const id of ['arc', 'base', 'stellar', 'stellar-testnet', 'xlayer']) assert.ok(s.sides.some((x) => x.chain === id), id)
  assert.ok(s.sides.every((x) => x.signer.configured === false))
  const withKeys = cctpStellarStatus({ ARC_SIGNER_KEY: EVM_KEY, CCTP_STELLAR_TESTNET_SECRET: SEED } as NodeJS.ProcessEnv)
  const st = withKeys.sides.find((x) => x.chain === 'stellar-testnet')!
  assert.equal(st.signer.configured, true)
  assert.equal(st.signer.address, Keypair.fromSecret(SEED).publicKey())
  assert.equal(JSON.stringify(withKeys).includes(SEED), false)
  assert.equal(JSON.stringify(withKeys).includes(EVM_KEY.slice(2)), false)
  assert.equal(withKeys.sides.find((x) => x.chain === 'arc')!.signer.from, 'ARC_SIGNER_KEY')
})
