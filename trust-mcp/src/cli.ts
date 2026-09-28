/**
 * The same package, run as commands instead of as an MCP server, so a coding agent can do the
 * whole thing from a terminal in one session: make a one-time wallet, wait for it to be
 * funded, pay for a check, and send what is left back.
 *
 *   npx -y @a-identity/trust-mcp@latest wallet new
 *   npx -y @a-identity/trust-mcp@latest wallet status
 *   npx -y @a-identity/trust-mcp@latest wallet optin
 *   npx -y @a-identity/trust-mcp@latest check <ALGORAND ADDRESS OR SELLER LINK>        (5 USDC)
 *   npx -y @a-identity/trust-mcp@latest ask <verify|reputation|risk|passport> <AGENT ID> [DEAL USD]
 *   npx -y @a-identity/trust-mcp@latest wallet sweep <YOUR ALGORAND ADDRESS>
 *
 * Nothing here prints the wallet's 25 words. The spending cap (A_IDENTITY_MAX_USD_PER_CALL,
 * default 10 USDC) is checked before anything is signed.
 */
import { PaymentRequiredError, TrustGuard, TrustOracleError, type FetchLike } from '@a-identity/trust-guard'
import { AlgorandPaymentError, algorandPayer, SpendCapError } from '@a-identity/trust-guard/algorand'
import { configFromEnv, DEFAULT_BASE_URL, DEFAULT_MAX_USD_PER_CALL } from './server.js'
import { createWallet, keyfilePath, loadWallet, nextStep, optIn, readStatus, sweep, DEFAULT_ALGOD } from './wallet.js'
import { createStellarWallet, loadStellarWallet, stellarKeyfilePath } from './stellar.js'
import { bridgeStatePath, loadState, planIn, retireFiles, runBack, runIn } from './bridge.js'
import { pair } from './sideshift.js'

type Out = (line: string) => void

const EXPLORER = 'https://allo.info'
const HELP = `A-Identity checks, paid in USDC on Algorand from a wallet on this computer.

  npx -y @a-identity/trust-mcp@latest wallet new             make a one-time wallet (prints its address only)
  npx -y @a-identity/trust-mcp@latest wallet status          balances and the next step
  npx -y @a-identity/trust-mcp@latest wallet optin           let the wallet hold USDC (after ALGO arrives)
  npx -y @a-identity/trust-mcp@latest check <ADDRESS|LINK>   is it safe to pay this Algorand address? (5 USDC)
  npx -y @a-identity/trust-mcp@latest ask <verify|reputation|risk|passport> <AGENT ID> [DEAL USD]
  npx -y @a-identity/trust-mcp@latest wallet sweep <YOUR ADDRESS>   send everything left back and close the wallet

Paying with XLM instead (it is exchanged through SideShift):
  npx -y @a-identity/trust-mcp@latest stellar start          make the wallets and say how much XLM to send
  npx -y @a-identity/trust-mcp@latest stellar run            exchange the XLM into ALGO and USDC (run until it says Ready)
  npx -y @a-identity/trust-mcp@latest stellar return <YOUR STELLAR ADDRESS>   everything back to you as XLM (run until Done)

Run with no arguments, it is an MCP server (for Claude Code, Cursor or any MCP client).`

const ASK: Record<string, 'verify' | 'reputation' | 'riskCheck' | 'passport'> = {
  verify: 'verify',
  reputation: 'reputation',
  risk: 'riskCheck',
  passport: 'passport',
}

function describeStatus(out: Out, s: Awaited<ReturnType<typeof readStatus>>) {
  out(`Address: ${s.address}`)
  out(`ALGO:    ${s.algo}`)
  out(`USDC:    ${s.usdcOptedIn ? s.usdc : 'not enabled yet'}`)
  out(`Next:    ${nextStep(s)}`)
}

/** Prints a paid answer as a person reads it, then the receipt. */
function describeAnswer(out: Out, tool: string, r: Record<string, unknown>) {
  if (tool === 'pay_check') {
    out(`${String(r.headline ?? r.verdict)}  (${String(r.address ?? '')})`)
    for (const x of (r.reasons as { text?: string }[] | undefined) ?? []) out(`  - ${x.text}`)
    const d = r.details as { topPayers?: { address: string; usdc: number; share: number; linked: boolean }[]; createdBy?: string | null; createdAt?: string | null } | undefined
    if (d?.createdBy) out(`Created by ${d.createdBy}${d.createdAt ? ` on ${d.createdAt.slice(0, 10)}` : ''}`)
    if (d?.topPayers?.length) {
      out('Biggest payers:')
      for (const p of d.topPayers.slice(0, 5)) out(`  ${p.address}  ${p.usdc} USDC  ${Math.round(p.share * 100)}%${p.linked ? '  (linked to this address)' : ''}`)
    }
  } else if (tool === 'riskCheck') {
    out(`${String(r.decision)}  (${String(r.agentId ?? '')})`)
    for (const x of (r.reasons as string[] | undefined) ?? []) out(`  - ${x}`)
  } else {
    out(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'settlement' && k !== '_meta')), null, 2))
  }
  const tx = (r.settlement as { transaction?: string } | undefined)?.transaction
  if (tx) out(`Receipt: ${EXPLORER}/tx/${tx}`)
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = (l) => console.log(l),
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<number> {
  const [cmd, sub, arg, extra] = argv
  const path = keyfilePath(env)
  const algod = env.A_IDENTITY_ALGOD_URL?.trim() || DEFAULT_ALGOD
  try {
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      out(HELP)
      return 0
    }

    if (cmd === 'wallet' && sub === 'new') {
      const w = createWallet(path)
      out(w.created ? `Made a one-time wallet. Its secret words are saved in ${path} (readable by you only) and are never printed.` : `Using the wallet already in ${path}.`)
      describeStatus(out, await readStatus(w.address, algod, fetchImpl))
      return 0
    }

    if (cmd === 'stellar') {
      const spath = stellarKeyfilePath(env)
      const statePath = bridgeStatePath(env)
      if (sub === 'start') {
        const a = createWallet(path)
        const x = createStellarWallet(spath)
        const plan = planIn(await pair('xlm-stellar', 'algo-algorand', fetchImpl), await pair('xlm-stellar', 'usdc-algorand', fetchImpl))
        out(x.created ? 'Made two one-time wallets on this computer (their secrets are saved under ~/.a-identity, readable by you only, and never printed).' : 'Using the one-time wallets already on this computer.')
        out(`Send XLM to this Stellar address: ${x.address}`)
        out(`Send at least ${plan.totalXlm} XLM for one 5 USDC address check; each extra ${plan.perExtraCheckXlm} XLM is about one more.`)
        out(`It becomes ALGO and USDC in the Algorand wallet ${a.address}.`)
        out('Then run: npx -y @a-identity/trust-mcp@latest stellar run')
        return 0
      }
      const aw = loadWallet(path)
      const sw = loadStellarWallet(spath)
      if (!aw || !sw) {
        out('No one-time wallets yet. Run: npx -y @a-identity/trust-mcp@latest stellar start')
        return 1
      }
      const ctx = { algorand: aw, stellar: sw, statePath, algod, fetchImpl, out }
      if (sub === 'run') return (await runIn(ctx)) ? 0 : 2
      if (sub === 'return') {
        if (!arg) {
          out('Name your own Stellar address: npx -y @a-identity/trust-mcp@latest stellar return <YOUR STELLAR ADDRESS>')
          return 1
        }
        if (!(await runBack(ctx, arg))) return 2
        const leftUsdc = loadState(statePath).back?.usdcLeft ?? 0
        retireFiles(leftUsdc > 0 ? [spath, statePath] : [spath, statePath, path])
        return 0
      }
      out(HELP)
      return 1
    }

    const w = loadWallet(path)
    if (!w) {
      out('No wallet yet. Run: npx -y @a-identity/trust-mcp@latest wallet new')
      return 1
    }

    if (cmd === 'wallet' && sub === 'status') {
      describeStatus(out, await readStatus(w.address, algod, fetchImpl))
      return 0
    }

    if (cmd === 'wallet' && sub === 'optin') {
      const tx = await optIn(w, algod, fetchImpl)
      out(tx === 'already' ? 'This wallet can already hold USDC.' : `The wallet can now hold USDC. Transaction: ${EXPLORER}/tx/${tx}`)
      describeStatus(out, await readStatus(w.address, algod, fetchImpl))
      return 0
    }

    if (cmd === 'wallet' && sub === 'sweep') {
      if (!arg) {
        out('Name the address to send everything back to: npx -y @a-identity/trust-mcp@latest wallet sweep <YOUR ALGORAND ADDRESS>')
        return 1
      }
      const r = await sweep(w, path, arg, algod, fetchImpl)
      out(`Sent ${r.usdc} USDC and the remaining ALGO (${r.algo} before fees) to ${arg}, and closed the wallet.`)
      out(`Transaction: ${EXPLORER}/tx/${r.txId}`)
      out(`The wallet file was renamed to ${r.retiredFile}; delete it whenever you like.`)
      return 0
    }

    if (cmd === 'check' || cmd === 'ask') {
      // Nothing is attempted from a wallet that cannot pay yet; the person gets the next step.
      const ready = await readStatus(w.address, algod, fetchImpl)
      if (!ready.usdcOptedIn || ready.usdc <= 0) {
        out(`Not ready to pay yet. ${nextStep(ready)}`)
        return 1
      }
      const config = configFromEnv(env)
      const cap = config.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL
      const oracle = new TrustGuard({
        rail: 'algorand',
        baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
        fetch: fetchImpl,
        onPaymentRequired: algorandPayer({ mnemonic: w.mnemonic, maxUsdPerCall: cap, algodUrl: config.algodUrl, fetch: fetchImpl }),
      })
      if (cmd === 'check') {
        if (!sub) {
          out('Name the address or link to check: npx -y @a-identity/trust-mcp@latest check <ADDRESS OR LINK>')
          return 1
        }
        describeAnswer(out, 'pay_check', await oracle.payCheck(sub))
        return 0
      }
      const method = ASK[sub ?? '']
      if (!method || !arg) {
        out('Usage: npx -y @a-identity/trust-mcp@latest ask <verify|reputation|risk|passport> <AGENT ID> [DEAL USD]')
        return 1
      }
      const deal = extra === undefined ? undefined : Number(extra)
      const r =
        method === 'riskCheck'
          ? await oracle.riskCheck(arg, deal !== undefined && Number.isFinite(deal) ? { amountUsd: deal } : undefined)
          : await oracle[method](arg)
      describeAnswer(out, method, r as Record<string, unknown>)
      return 0
    }

    out(HELP)
    return 1
  } catch (e) {
    if (e instanceof SpendCapError) out(`Not paid: the price ${e.amountUsd} USDC is above the cap of ${e.capUsd}. Raise A_IDENTITY_MAX_USD_PER_CALL to allow it. Nothing was signed.`)
    else if (e instanceof PaymentRequiredError) {
      const reason = (e.challenge as { reason?: unknown } | null)?.reason
      out(`Not paid: the payment was not accepted${typeof reason === 'string' ? ` (${reason})` : ''}. Nothing was charged. Check the wallet with: npx -y @a-identity/trust-mcp@latest wallet status`)
    }
    else if (e instanceof AlgorandPaymentError) out(`Not paid: ${e.message}. Nothing was signed.`)
    else if (e instanceof TrustOracleError) out(`The check failed (HTTP ${e.status}): ${e.message}`)
    else out(e instanceof Error ? e.message : String(e))
    return 1
  }
}
