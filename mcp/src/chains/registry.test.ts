import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAINS,
  getChain,
  requireChain,
  getChainById,
  getChainByEvmId,
  evmChains,
  liveChains,
  ARC_CHAIN,
} from './registry.js'
import { isValidCaip2, evmChainIdFromCaip2 } from './caip.js'

test('every descriptor has a valid, unique CAIP-2 id', () => {
  const seen = new Set<string>()
  for (const c of CHAINS) {
    assert.ok(isValidCaip2(c.caip2), `invalid caip2: ${c.caip2}`)
    assert.ok(!seen.has(c.caip2), `duplicate caip2: ${c.caip2}`)
    seen.add(c.caip2)
  }
})

test('every id slug is unique', () => {
  const ids = CHAINS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('EVM chains: caip2 reference matches evmChainId; non-EVM have null', () => {
  for (const c of CHAINS) {
    if (c.ecosystem === 'evm') {
      assert.equal(evmChainIdFromCaip2(c.caip2), c.evmChainId, `mismatch for ${c.id}`)
    } else {
      assert.equal(c.evmChainId, null, `${c.id} should have null evmChainId`)
    }
  }
})

test('lookups resolve the same descriptor by caip2, id, and evm id', () => {
  const arc = getChain('eip155:5042002')
  assert.ok(arc)
  assert.equal(getChainById('arc'), arc)
  assert.equal(getChainByEvmId(5042002), arc)
  assert.equal(requireChain('eip155:5042002'), arc)
})

test('requireChain throws on unknown chain', () => {
  assert.throws(() => requireChain('eip155:999999999'))
})

test('getChain returns undefined for unknown chain', () => {
  assert.equal(getChain('eip155:999999999'), undefined)
})

test('Arc, X Layer, Celo (live), Base and Celo Sepolia (beta) are the wired chains; Arc carries all its known contracts', () => {
  // Product decision 2026-08-08: X Layer identity is live (OKX ERC-8004 reads),
  // Base testnet is active via the Gateway demo, so it is beta.
  // 2026-08-09 (evening): Celo mainnet flips to LIVE — agent #9759 is minted on the
  // mainnet ERC-8004 registry and the x402 facilitator rail has real settlements
  // recorded in the durable proof log. Celo Sepolia stays beta.
  const live = liveChains()
  assert.deepEqual(live.map((c) => c.id).sort(), ['arc', 'base', 'celo', 'celo-sepolia', 'xlayer'])
  assert.equal(live.find((c) => c.id === 'xlayer')?.status, 'live')
  assert.equal(live.find((c) => c.id === 'base')?.status, 'beta')
  assert.equal(live.find((c) => c.id === 'celo')?.status, 'live')
  assert.equal(live.find((c) => c.id === 'celo-sepolia')?.status, 'beta')
  assert.equal(ARC_CHAIN.id, 'arc')
  // Guard the exact live Arc addresses against silent drift.
  assert.equal(ARC_CHAIN.contracts.identityRegistry, '0x8004A818BFB912233c491871b3d84c89A494BD9e')
  assert.equal(ARC_CHAIN.contracts.reputationRegistry, '0x8004B663056A597Dffe9eCcC1965A193B7388713')
  assert.equal(ARC_CHAIN.contracts.validationRegistry, '0x8004Cb1BF31DAf7788923b405b754f57acEB4272')
  assert.equal(ARC_CHAIN.contracts.agenticCommerce, '0x0747EEf0706327138c69792bF28Cd525089e4583')
  assert.equal(ARC_CHAIN.contracts.usdc, '0x3600000000000000000000000000000000000000')
  assert.equal(ARC_CHAIN.evmChainId, 5042002)
  assert.equal(ARC_CHAIN.usdcDecimals, 6)
  assert.equal(ARC_CHAIN.explorer, 'https://testnet.arcscan.app')
  assert.equal(ARC_CHAIN.rpcUrls[0], 'https://rpc.testnet.arc.network')
  assert.equal(ARC_CHAIN.signerEnvVar, 'ARC_SIGNER_KEY')
})

test('every roadmap chain is present and planned', () => {
  // celo left this list on 2026-08-09 when its identity reads + x402 rail went beta.
  for (const id of ['arbitrum', 'avalanche', 'rhchain', 'rhchain-testnet', 'stellar']) {
    const c = getChainById(id)
    assert.ok(c, `${id} missing from registry`)
    assert.equal(c.status, 'planned', `${id} should be planned`)
  }
})

test('the planned set is mostly EVM, with one non-EVM', () => {
  const planned = CHAINS.filter((c) => c.status === 'planned')
  const nonEvm = planned.filter((c) => c.ecosystem !== 'evm')
  assert.deepEqual(nonEvm.map((c) => c.id), ['stellar'])
  // Derived rather than `planned.length - N`: the hardcoded N is what went stale when
  // Solana was dropped, and it failed as an off-by-one somewhere unrelated to the change.
  assert.equal(planned.filter((c) => c.ecosystem === 'evm').length, planned.length - nonEvm.length)
})

test('evmChains covers Arc and every other EVM chain', () => {
  const ids = evmChains().map((c) => c.id).sort()
  assert.deepEqual(ids, ['arbitrum', 'arc', 'avalanche', 'base', 'celo', 'celo-sepolia', 'rhchain', 'rhchain-testnet', 'xlayer'])
})

// ── Robinhood Chain (Phase 6.1) ──────────────────────────────────────────────────

test('Robinhood Chain carries the values verified against its live RPCs', () => {
  // Every one of these was confirmed with an eth_chainId / eth_getCode call rather than
  // copied from a doc page, so pinning them means a later edit that drifts gets caught.
  const main = getChainById('rhchain')
  assert.ok(main)
  assert.equal(main.evmChainId, 4663) // eth_chainId returned 0x1237
  assert.equal(main.caip2, 'eip155:4663')
  assert.equal(main.testnet, false)
  assert.equal(main.rpcUrls[0], 'https://rpc.mainnet.chain.robinhood.com')
  assert.equal(main.explorer, 'https://robinhoodchain.blockscout.com')
  assert.equal(main.nativeCurrency.symbol, 'ETH')

  const test_ = getChainById('rhchain-testnet')
  assert.ok(test_)
  assert.equal(test_.evmChainId, 46630) // eth_chainId returned 0xb626
  assert.equal(test_.caip2, 'eip155:46630')
  assert.equal(test_.testnet, true)
  assert.equal(test_.rpcUrls[0], 'https://rpc.testnet.chain.robinhood.com')
})

test('Robinhood Chain asserts no USDC and no CCTP domain it cannot back up', () => {
  // Neither is documented for this chain. Inventing either would put a wrong address or a
  // wrong bridge domain into a payment path.
  for (const id of ['rhchain', 'rhchain-testnet']) {
    const c = getChainById(id)
    assert.equal(c?.contracts.usdc, undefined, id)
    assert.equal(c?.cctpDomain, null, id)
    assert.deepEqual(c?.stablecoins, [], id)
  }
})

test('every EVM chain records a verified CREATE2 factory, and no non-EVM chain does', () => {
  // The same-address promise in MULTICHAIN-STRATEGY 1.5 only holds where the factory is
  // actually deployed, so this is data gathered by eth_getCode, not an assumption.
  for (const c of CHAINS) {
    if (c.ecosystem === 'evm') {
      assert.equal(
        c.contracts.create2Factory,
        '0x4e59b44847B379578588920cA78FbF26c0B4956C',
        `${c.id} is missing its verified CREATE2 factory`,
      )
    } else {
      assert.equal(c.contracts.create2Factory, undefined, `${c.id} is not EVM and must not claim a factory`)
    }
  }
})

