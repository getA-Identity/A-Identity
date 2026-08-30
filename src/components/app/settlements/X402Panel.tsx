import { useState } from 'react'
import { encodeFunctionData, toHex } from 'viem'
import { CheckCircle2, ExternalLink, Lock, Zap } from 'lucide-react'

import { apiFetch } from '../../../lib/api'
import { Button } from '../../ui/button'
import { getActiveInjectedProvider, getConnectedProvider } from '../../../lib/wallets'
import { ARC_TESTNET } from '../../../lib/arc'
import { Panel } from '../../ui/panel'

/** Arc Testnet chain id as the 0x-hex EIP-155 wallets expect. */
const ARC_CHAIN_HEX = '0x' + ARC_TESTNET.id.toString(16)

/** Make sure the wallet is on Arc before we send a USDC transfer, otherwise the transfer
 *  would be broadcast to the Arc-USDC address on whatever chain is active (e.g. Ethereum
 *  mainnet), a confusing and potentially fund-losing transaction. Switches (or adds) Arc. */
async function ensureArcChain(eth: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }) {
  const current = (await eth.request({ method: 'eth_chainId' })) as string
  if (typeof current === 'string' && current.toLowerCase() === ARC_CHAIN_HEX) return
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC_CHAIN_HEX }] })
  } catch (err) {
    if ((err as { code?: number })?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: ARC_CHAIN_HEX,
          chainName: ARC_TESTNET.name,
          nativeCurrency: ARC_TESTNET.nativeCurrency,
          rpcUrls: [ARC_TESTNET.rpc.http],
          blockExplorerUrls: [ARC_TESTNET.blockExplorer],
        }],
      })
    } else {
      throw new Error('Switch your wallet to Arc Testnet to pay.')
    }
  }
}

const ERC20_TRANSFER = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

type Accepts = {
  asset: string
  assetSymbol: string
  decimals: number
  maxAmountRequired: string
  payTo: string
  description: string
  nonce?: string
}
type Resource = {
  paid: boolean
  tx: string
  explorerUrl: string
  resource: { title: string; arcBlock: string | null; chainId: number; servedAt: string }
}

type Phase = 'idle' | 'quoting' | 'paying' | 'verifying' | 'done' | 'error'

export default function X402Panel() {
  const [req, setReq] = useState<Accepts | null>(null)
  const [resource, setResource] = useState<Resource | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [tx, setTx] = useState<string | null>(null)

  const priceUsdc = req ? Number(req.maxAmountRequired) / 10 ** req.decimals : 0.001

  const call = async () => {
    setError(null)
    setResource(null)
    setTx(null)
    try {
      // 1. Unpaid request -> expect 402 with payment requirements.
      setPhase('quoting')
      const quote = await apiFetch('/api/x402/data') // retries through a cold start; 402 is the expected quote
      if (quote.status === 501) throw new Error('x402 is not configured on the server.')
      if (quote.status !== 402) throw new Error(`Unexpected response: HTTP ${quote.status}`)
      const reqs = (await quote.json()) as { accepts: Accepts[]; nonce?: string }
      const accepts = reqs.accepts?.[0]
      if (!accepts) throw new Error('No payment requirements returned.')
      // The server binds this redemption to a fresh single-use nonce; echo it back.
      const nonce = reqs.nonce ?? accepts.nonce
      setReq(accepts)

      // 2. Pay the required USDC on Arc from the wallet the user signed in with, so
      //    we don't pop a different extension than the one they're using.
      const eth = getConnectedProvider() ?? getActiveInjectedProvider()
      if (!eth) throw new Error('No wallet found. Sign in with a browser wallet to pay.')
      setPhase('paying')
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
      const from = accounts?.[0]
      if (!from) throw new Error('No account selected.')
      // Pin the wallet to Arc before sending, so the USDC transfer can't land on another chain.
      await ensureArcChain(eth)
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER,
        functionName: 'transfer',
        args: [accepts.payTo as `0x${string}`, BigInt(accepts.maxAmountRequired)],
      })
      const txHash = (await eth.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: accepts.asset, data }],
      })) as string
      setTx(txHash)

      // 2b. Prove control of the paying wallet by signing the (nonce, payer) challenge.
      //     The server binds the redemption to this signature AND to the on-chain sender,
      //     so only the wallet that actually paid can unlock it, a front-runner who only
      //     scraped the tx hash off the public chain cannot.
      let paySig: string | null = null
      if (nonce) {
        const authMessage =
          `A-Identity x402 payment authorization\nResource: /api/x402/data\nNonce: ${nonce}\nPayer: ${from.toLowerCase()}`
        paySig = (await eth.request({
          method: 'personal_sign',
          params: [toHex(authMessage), from],
        })) as string
      }

      // 3. Retry with the payment proof until the server verifies it on-chain.
      setPhase('verifying')
      let paid: Resource | null = null
      for (let i = 0; i < 20; i++) {
        const pr = await apiFetch('/api/x402/data', {
          headers: {
            'X-Payment': txHash,
            ...(nonce ? { 'X-Payment-Nonce': nonce } : {}),
            ...(paySig ? { 'X-Payment-Payer': from, 'X-Payment-Sig': paySig } : {}),
          },
          retries: 0, // this loop already retries; don't double-retry inside apiFetch
        })
        if (pr.status === 200) {
          paid = (await pr.json()) as Resource
          break
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      if (!paid) throw new Error('Payment not verified yet. Give it a moment and try again.')
      setResource(paid)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'x402 call failed')
      setPhase('error')
    }
  }

  const busy = phase === 'quoting' || phase === 'paying' || phase === 'verifying'
  const label =
    phase === 'quoting'
      ? 'Getting quote...'
      : phase === 'paying'
        ? 'Confirm in your wallet...'
        : phase === 'verifying'
          ? 'Verifying payment on Arc...'
          : `Pay ${priceUsdc} USDC & call`

  return (
<Panel tone="brand" className="mt-8">
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-white">
          <Zap size={15} />
        </div>
        <div>
          <h3 className="font-semibold text-foreground">x402: pay-per-call API</h3>
          <p className="text-xs text-foreground/55">
            A real HTTP 402 rail: the server asks for payment, you pay USDC on Arc, it verifies
            on-chain and serves. One payment unlocks one call.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" className="px-4 py-2.5 text-sm" onClick={call} disabled={busy}>
          <Lock size={14} />
          {label}
        </Button>
      </div>

      {/* The 402 challenge is the whole point of the demo, surface it on-screen so the
          expected red "402" the browser logs to the console reads as intentional, not a bug. */}
      {req && phase !== 'done' && (
        <div className="mt-3 rounded-xl border border-warn/40 bg-warn/[0.1] p-3">
          <div className="flex items-center gap-1.5 text-sm font-bold text-warn">
            <Lock size={13} /> HTTP 402 · Payment Required
          </div>
          <p className="mt-1 text-xs leading-relaxed text-foreground/65">
            The server answered with a real <b>402 challenge</b>, the paywall working as intended, not
            an error. Pay <b>{priceUsdc} USDC</b> on Arc to {req.payTo.slice(0, 8)}...{req.payTo.slice(-4)}{' '}
            and the call unlocks.
          </p>
        </div>
      )}

      {tx && phase === 'verifying' && (
        <p className="mt-2 font-mono text-xs text-foreground/45">paid tx {tx.slice(0, 12)}..., verifying on Arc</p>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {resource && (
        <div className="mt-4 rounded-xl border border-ok/30 bg-ok/[0.08] p-4">
          <div className="flex items-center gap-1.5 text-sm font-bold text-ok">
            <CheckCircle2 size={15} /> Unlocked: paid per request
          </div>
          <div className="mt-2 grid gap-1 text-xs text-foreground/70">
            <div>
              <span className="text-foreground/45">Resource:</span> {resource.resource.title}
            </div>
            <div>
              <span className="text-foreground/45">Live Arc block:</span> #{resource.resource.arcBlock ?? 'n/a'}
            </div>
            <a
              href={resource.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-usdc hover:underline"
            >
              View payment on arcscan <ExternalLink size={11} />
            </a>
          </div>
        </div>
      )}
    </Panel>
  )
}
