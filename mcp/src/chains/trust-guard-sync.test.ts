import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodeFunctionData, toFunctionSelector, type AbiFunction } from 'viem'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import { ARC_MIN_MAX_FEE_WEI } from '../verify-then-pay/prepare.js'
import { getChainById } from './registry.js'
import { txUrl } from './explorer.js'
import { renderTrustGuardArc, trustGuardArcMainnet, trustGuardVaultAbi } from './trust-guard-view.js'

// trust-guard signs real payments from these constants and cannot import the registry, so
// its copy is generated (npm run gen:chains), and these fail the build when the copy drifts.

/** Compiled to dist/chains/, so the repo root is three levels up. */
const generatedPath = fileURLToPath(new URL('../../../trust-guard/src/arc-mainnet.generated.ts', import.meta.url))

test("trust-guard's generated Arc Mainnet file equals the renderer's output", () => {
  assert.equal(
    readFileSync(generatedPath, 'utf8'),
    renderTrustGuardArc(),
    'trust-guard/src/arc-mainnet.generated.ts is stale or was hand-edited. Run: cd mcp && npm run gen:chains',
  )
})

test('the rendered constants are the arc-mainnet descriptor, unmodified', () => {
  const c = getChainById('arc-mainnet')!
  const v = trustGuardArcMainnet()
  assert.equal(v.caip2, c.caip2)
  assert.equal(v.chainId, c.evmChainId)
  assert.equal(v.usdc, c.contracts.usdc)
  assert.equal(v.usdcDecimals, c.usdcDecimals)
  assert.equal(v.nativeDecimals, c.nativeCurrency?.decimals)
  assert.equal(v.identityRegistry, c.contracts.identityRegistry)
  assert.equal(v.gatewayWallet, c.gateway?.wallet)
  assert.equal(v.gatewayFacilitator, c.gateway?.facilitator)
  assert.equal(v.gatewayDomain, c.cctpDomain)
  assert.deepEqual(v.rpcUrls, c.rpcUrls, 'every registry RPC, primary first: a receipt can live on only some of them')
  // The SDK derives a payment's explorer link as explorer + /tx/ + hash.
  assert.equal(`${v.explorer}/tx/0xabc`, txUrl(c, '0xabc'))
  assert.match(renderTrustGuardArc(), new RegExp(`"minMaxFeePerGasWei": ${ARC_MIN_MAX_FEE_WEI}n`))
})

test('the rendered vault ABI encodes pay() and ownerPay() exactly as the contract ABI does', () => {
  const slice = trustGuardVaultAbi() as unknown as typeof AgentSpendPolicyAbi
  const payee = `0x${'d4'.repeat(20)}` as const
  for (const functionName of ['pay', 'ownerPay'] as const) {
    assert.equal(
      encodeFunctionData({ abi: slice, functionName, args: [payee, 250000n] }),
      encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName, args: [payee, 250000n] }),
    )
  }
  const pay = (slice as readonly { type: string; name?: string }[]).find((e) => e.type === 'function' && e.name === 'pay') as AbiFunction
  assert.equal(toFunctionSelector(pay), toFunctionSelector('pay(address,uint256)'))
  // Every error the contract can revert with is decodable by the SDK.
  const errors = (a: readonly { type: string; name?: string }[]) => a.filter((e) => e.type === 'error').map((e) => e.name)
  assert.deepEqual(errors(slice as readonly { type: string; name?: string }[]), errors(AgentSpendPolicyAbi as readonly { type: string; name?: string }[]))
})
