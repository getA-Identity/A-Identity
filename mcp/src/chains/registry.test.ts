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

test('Arc, X Layer, Celo (live), Base, Celo Sepolia and RH Chain Testnet (beta) are the wired chains; Arc carries all its known contracts', () => {
  // Product decision 2026-08-08: X Layer identity is live (OKX ERC-8004 reads),
  // Base testnet is active via the Gateway demo, so it is beta.
  // 2026-08-09 (evening): Celo mainnet flips to LIVE — agent #9759 is minted on the
  // mainnet ERC-8004 registry and the x402 facilitator rail has real settlements
  // recorded in the durable proof log. Celo Sepolia stays beta.
  // 2026-08-11: rhchain-testnet flips to beta — the canonical ERC-8004 registry set
  // is live there at the cross-chain addresses (see the Robinhood tests below).
  // 2026-08-12: rhchain flips to beta — the canonical MAINNET identity + reputation
  // registries were verified live there (read-side wired; writes wait on a signer).
  // 2026-08-13: rhchain flips from beta to LIVE - money moves there now (four real USDG
  // settlements through our own first-party EIP-3009 facilitator, receipts recorded).
  const live = liveChains()
  assert.deepEqual(live.map((c) => c.id).sort(), ['arc', 'base', 'celo', 'celo-sepolia', 'rhchain', 'rhchain-testnet', 'xlayer'])
  assert.equal(live.find((c) => c.id === 'rhchain')?.status, 'live')
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
  // celo left this list on 2026-08-09 when its identity reads + x402 rail went beta;
  // rhchain-testnet left on 2026-08-11 when the canonical ERC-8004 set went live there;
  // rhchain left on 2026-08-12 when its canonical registries were verified live.
  for (const id of ['arbitrum', 'avalanche', 'stellar']) {
    const c = getChainById(id)
    assert.ok(c, `${id} missing from registry`)
    assert.equal(c.status, 'planned', `${id} should be planned`)
  }
})

test('the planned set is mostly EVM, with one non-EVM', () => {
  const planned = CHAINS.filter((c) => c.status === 'planned')
  const nonEvm = planned.filter((c) => c.ecosystem !== 'evm')
  assert.deepEqual(nonEvm.map((c) => c.id), ['stellar'])
  // Derived rather than `planned.length - N`: a hardcoded N goes stale the moment a chain
  // enters or leaves the registry, and it fails as an off-by-one somewhere unrelated to
  // the edit that caused it, which is exactly how this line broke once already.
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

test('the Robinhood pair carries the canonical registries it was actually verified to carry', () => {
  // Testnet, 2026-08-11: deployed/completed by replaying the canonical
  // Safe-Singleton-Factory calldata (scripts/rh-testnet-deploy-8004.mjs), the SAME
  // addresses as Arc/Celo Sepolia. Mainnet, 2026-08-12: the canonical MAINNET family
  // (same addresses as X Layer/Celo) was found ALREADY live — nobody deployed it for
  // us. Every pin below was verified with eth_getCode plus a real read on the proxy
  // (name/symbol/getClients), so these are observations, not intentions.
  const t = getChainById('rhchain-testnet')
  assert.ok(t)
  assert.equal(t.status, 'beta')
  assert.equal(t.contracts.identityRegistry, '0x8004A818BFB912233c491871b3d84c89A494BD9e')
  assert.equal(t.contracts.reputationRegistry, '0x8004B663056A597Dffe9eCcC1965A193B7388713')
  assert.equal(t.contracts.validationRegistry, '0x8004Cb1BF31DAf7788923b405b754f57acEB4272')
  assert.equal(t.faucet, 'https://faucets.chain.link/robinhood-testnet')

  const m = getChainById('rhchain')
  assert.ok(m)
  assert.equal(m.status, 'live')
  assert.equal(m.contracts.identityRegistry, '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432')
  assert.equal(m.contracts.reputationRegistry, '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63')
  // No ValidationRegistry in the mainnet family (mirroring Celo/X Layer): KYA cannot
  // be anchored on-chain there, so the registry must not pretend otherwise.
  assert.equal(m.contracts.validationRegistry, undefined)
})

test('Robinhood Chain names its settlement token explicitly and STILL asserts no USDC', () => {
  // The original decision stands and is the point of this test: no canonical Circle USDC
  // is documented for either Robinhood network, and `contracts.usdc` is the slot every
  // generic USDC path reads (payUsdc, the ERC-8183 approve, the vault constructor). What
  // changed on 2026-08-12 is that a REAL settlement token was found on each chain, so the
  // truth now has somewhere to live: `settlementTokens`, which no escrow or vault path
  // touches. Neither chain has a documented CCTP domain either.
  for (const id of ['rhchain', 'rhchain-testnet']) {
    const c = getChainById(id)
    assert.equal(c?.contracts.usdc, undefined, id)
    assert.equal(c?.cctpDomain, null, id)
  }

  const usdg = getChainById('rhchain')?.settlementTokens?.[0]
  assert.equal(usdg?.symbol, 'USDG')
  assert.equal(usdg?.address, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
  assert.equal(usdg?.decimals, 6)
  assert.equal(usdg?.authorization, 'eip3009')
  // USDG exposes no version(), so the domain version is a PROVEN candidate, not a read.
  assert.deepEqual(usdg?.domainVersionCandidates, ['1'])

  const bridged = getChainById('rhchain-testnet')?.settlementTokens?.[0]
  assert.equal(bridged?.symbol, 'USDC.e')
  assert.equal(bridged?.address, '0x71c6e1c209A4e3d4bd9911B2d53c98023A56C32F')
  assert.deepEqual(bridged?.domainVersionCandidates, ['2'])
})

test('every settlement token is well formed and agrees with its chain', () => {
  // A settlement token is the only place in the registry where a wrong number moves real
  // money (decimals) or sends it to the wrong contract (address), so the invariants are
  // asserted for every chain rather than only the ones that have one today.
  for (const c of CHAINS) {
    for (const t of c.settlementTokens ?? []) {
      assert.match(t.address, /^0x[0-9a-fA-F]{40}$/, `${c.id}: bad settlement token address`)
      assert.ok(t.decimals >= 1 && t.decimals <= 18, `${c.id}: implausible decimals`)
      assert.ok(t.verified.length > 40, `${c.id}: settlement token needs a provenance note`)
      assert.ok(c.stablecoins.includes(t.symbol), `${c.id}: ${t.symbol} missing from stablecoins`)
      // Only a canonical Circle USDC may share the `usdc` slot's identity.
      if (c.contracts.usdc && t.address.toLowerCase() === c.contracts.usdc.toLowerCase()) {
        assert.equal(t.symbol, 'USDC', `${c.id}: contracts.usdc must be the USDC entry`)
      }
      if (t.authorization === 'eip3009') {
        assert.ok(
          (t.domainVersionCandidates ?? []).length > 0,
          `${c.id}: an eip3009 token needs at least one domain version candidate to prove`,
        )
      }
    }
  }
})

test('every EVM chain records a verified CREATE2 factory, and no non-EVM chain does', () => {
  // The same-address promise in the chains README (one address, many chains) only holds where the factory is
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

