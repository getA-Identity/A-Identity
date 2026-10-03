/**
 * The same package, run as commands instead of as an MCP server, so a coding agent can do the
 * whole thing from a terminal in one session: fund a one-time wallet, check before paying, and
 * get what is left back.
 *
 *   npx -y @a-identity/trust-mcp buy [--new]                    XLM in, exchanged into USDC
 *   npx -y @a-identity/trust-mcp status
 *   npx -y @a-identity/trust-mcp check <TARGET> [AMOUNT USD]    the checks that amount calls for
 *   npx -y @a-identity/trust-mcp ask <verify|reputation|risk|passport> <AGENT ID> [DEAL USD]
 *   npx -y @a-identity/trust-mcp refund --to <YOUR STELLAR ADDRESS>
 *   npx -y @a-identity/trust-mcp wallet new | status | optin | sweep <YOUR ALGORAND ADDRESS>
 *
 * Nothing here prints the wallet's 25 words. Every paid check goes through checks.ts: the
 * spending cap (A_IDENTITY_MAX_USD_PER_CALL, default 10 USDC) is checked before anything is
 * signed, and a check already saved is answered from the ledger without paying again.
 */
import type { FetchLike } from '@a-identity/trust-guard'
import { configFromEnv, DEFAULT_BASE_URL, DEFAULT_MAX_USD_PER_CALL } from './server.js'
import { createWallet, keyfilePath, loadWallet, nextStep, optIn, readStatus, sweep, DEFAULT_ALGOD, type WalletFile } from './wallet.js'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createStellarWallet, HORIZON, isStellarAddress, loadStellarWallet, readXlm, STELLAR_KEEP_XLM, stellarKeyfilePath } from './stellar.js'
import { bridgeStatePath, exchangeUnderway, loadState, planIn, retireFiles, runBack, runIn } from './bridge.js'
import { advanceBuy, buyStatePath, loadBuy, saveBuy, statusLines } from './buy.js'
import { askOne, checkBeforePay, checksLedgerPath, explain, type Gate, type PayDecision, type Tool } from './checks.js'
import { refundAll } from './refund.js'
import { pair } from './sideshift.js'
import { CMD } from './version.js'

type Out = (line: string) => void

const EXPLORER = 'https://allo.info'
const HELP = `A-Identity checks, paid in USDC on Algorand from a wallet on this computer.

The easy way, with XLM: one deposit becomes the budget your agent spends on checks.
  ${CMD} buy [--new]          says where to send XLM, then exchanges it into USDC on its own
                              (--new: new wallets, if this computer has someone else's)
  ${CMD} status               Running, Idle or Finished, what was spent and what is left
  ${CMD} refund --to <YOUR STELLAR ADDRESS>   everything left back to you as XLM

Checking, before your agent pays (each check of a target is paid for once; repeats are free for 24 hours):
  ${CMD} check <ADDRESS|LINK|AGENT ID> [AMOUNT USD]   the checks a payment of that amount calls for
  ${CMD} ask <verify|reputation|risk|passport> <AGENT ID> [DEAL USD]

Step by step, with USDC:
  ${CMD} wallet new             make a one-time wallet (prints its address only)
  ${CMD} wallet status          balances and the next step
  ${CMD} wallet optin           let the wallet hold USDC (after ALGO arrives)
  ${CMD} wallet sweep <YOUR ADDRESS>   send everything left back and close the wallet

Paying with XLM instead (it is exchanged through SideShift):
  ${CMD} stellar start          make the wallets and say how much XLM to send
  ${CMD} stellar run            exchange the XLM into ALGO and USDC (run until it says Ready)
  ${CMD} stellar return <YOUR STELLAR ADDRESS>   everything back to you as XLM (run until Done)

Run with no arguments, it is an MCP server (for Claude Code, Cursor or any MCP client).`

const ASK: Record<string, Tool> = {
  verify: 'verify_agent',
  reputation: 'reputation_score',
  risk: 'risk_check',
  passport: 'agent_passport',
}

/** Printed first by every `buy`: what the money is for, and how to get it back. */
export const DISCLOSURE = [
  'Everything you send is spent by your agent on checks of the targets it chooses, each one a different check.',
  `If no new target is left, what remains waits in the wallet; get it back with: ${CMD} refund --to <YOUR STELLAR ADDRESS>`,
]

function describeStatus(out: Out, s: Awaited<ReturnType<typeof readStatus>>) {
  out(`Address: ${s.address}`)
  out(`ALGO:    ${s.algo}`)
  out(`USDC:    ${s.usdcOptedIn ? s.usdc : 'not enabled yet'}`)
  out(`Next:    ${nextStep(s)}`)
}

const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

/** Prints a paid answer as a person reads it, then the receipt and whether it was paid now. */
function describeAnswer(out: Out, tool: Tool, r: Record<string, unknown>) {
  if (tool === 'pay_check') {
    out(`${String(r.headline ?? r.verdict)}  (${String(r.address ?? '')})`)
    for (const x of (r.reasons as { text?: string }[] | undefined) ?? []) out(`  - ${x.text}`)
    const d = r.details as { topPayers?: { address: string; usdc: number; share: number; linked: boolean }[]; createdBy?: string | null; createdAt?: string | null } | undefined
    if (d?.createdBy) out(`Created by ${d.createdBy}${d.createdAt ? ` on ${d.createdAt.slice(0, 10)}` : ''}`)
    if (d?.topPayers?.length) {
      out('Biggest payers:')
      for (const p of d.topPayers.slice(0, 5)) out(`  ${p.address}  ${p.usdc} USDC  ${Math.round(p.share * 100)}%${p.linked ? '  (linked to this address)' : ''}`)
    }
  } else if (tool === 'risk_check') {
    out(`${String(r.decision)}  (${String(r.agentId ?? '')})`)
    for (const x of (r.reasons as string[] | undefined) ?? []) out(`  - ${x}`)
  } else {
    out(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'settlement' && k !== '_meta' && k !== 'cache')), null, 2))
  }
  const cache = r.cache as { source?: string; paidUsd?: number; checkedAt?: string; receipt?: string } | undefined
  const tx = (r.settlement as { transaction?: string } | undefined)?.transaction ?? cache?.receipt
  if (tx) out(`Receipt: ${EXPLORER}/tx/${tx}`)
  if (cache?.source === 'cache') out(`Saved answer from ${when(cache.checkedAt ?? '')}: nothing was paid this time.`)
  else if (cache) out(`Paid ${cache.paidUsd} USDC.`)
}

/** Prints a check_before_pay decision: the verdict first, then each check and what it cost. */
function describeDecision(out: Out, d: PayDecision) {
  out(`${d.decision}: ${d.advice}  (${d.target}, ${d.amount} USD)`)
  for (const c of d.checks) {
    out(`  ${c.label}: ${c.summary}  [${c.source === 'paid' ? `paid ${c.paidUsd} USDC` : `saved answer from ${when(c.checkedAt)}, free`}]`)
    const reasons =
      c.check === 'pay_check' ? ((c.answer?.reasons as { text?: string }[] | undefined) ?? []).map((x) => x.text ?? '') : c.check === 'risk_check' ? ((c.answer?.reasons as string[] | undefined) ?? []) : []
    for (const x of reasons.slice(1)) out(`    - ${x}`)
    if (c.receipt) out(`    Receipt: ${EXPLORER}/tx/${c.receipt}`)
  }
  for (const f of d.failed ?? []) out(`  ${f.label}: not checked. ${f.error}`)
  if (d.budgetLeftUsd !== null && d.budgetLeftUsd !== undefined) out(`Left for checks: ${d.budgetLeftUsd} USDC.`)
}

/** The background worker gives up after this long, or after this many errors in a row. */
const WORKER_MAX_MS = 6 * 60 * 60 * 1000
const WORKER_MAX_ERRORS = 10
const WORKER_PAUSE_MS = 15_000
/** A round younger than this is taken to be the current person's own, even by `buy --new`. */
const FRESH_ROUND_MS = 30 * 60 * 1000

export type CliDeps = {
  /** Starts `buy --worker` detached from this process; returns its pid. */
  spawnWorker?: (args: string[], logPath: string) => number
  isAlive?: (pid: number) => boolean
  stopWorker?: (pid: number) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function spawnDetached(args: string[], logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  const fd = openSync(logPath, 'a', 0o600)
  const child = spawn(process.execPath, [process.argv[1], ...args], { detached: true, stdio: ['ignore', fd, fd], env: process.env, windowsHide: true })
  child.unref()
  closeSync(fd)
  return child.pid ?? 0
}

function stopProcess(pid: number) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = (l) => console.log(l),
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  deps: CliDeps = {},
): Promise<number> {
  const [cmd, sub, arg, extra] = argv
  const path = keyfilePath(env)
  const algod = env.A_IDENTITY_ALGOD_URL?.trim() || DEFAULT_ALGOD
  const horizon = env.A_IDENTITY_HORIZON_URL?.trim() || HORIZON
  const gateFor = (w: WalletFile): Gate => {
    const config = configFromEnv(env)
    return {
      ledgerPath: config.ledgerPath ?? checksLedgerPath(env),
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl,
      mnemonic: w.mnemonic,
      algod: config.algodUrl ?? algod,
      maxUsdPerCall: config.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL,
      cacheHours: config.cacheHours,
      now: deps.now,
    }
  }
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

    if (cmd === 'buy' || cmd === 'status' || cmd === 'refund') {
      const spath = stellarKeyfilePath(env)
      const statePath = bridgeStatePath(env)
      const buyPath = buyStatePath(env)
      const logPath = join(dirname(buyPath), 'buy.log')
      const now = deps.now ?? Date.now
      const alive = (st: ReturnType<typeof loadBuy>) =>
        Boolean(st.worker && now() - Date.parse(st.worker.startedAt) < WORKER_MAX_MS + 60_000 && (deps.isAlive ?? pidAlive)(st.worker.pid))
      const ledgerPath = configFromEnv(env).ledgerPath ?? checksLedgerPath(env)
      const walletsCtx = () => {
        const aw = loadWallet(path)
        const sw = loadStellarWallet(spath)
        return aw && sw ? { algorand: aw, stellar: sw, statePath, buyPath, algod, horizon, fetchImpl, baseUrl: configFromEnv(env).baseUrl } : null
      }

      if (cmd === 'status') {
        const aw = loadWallet(path)
        if (!aw) {
          out('Status: Idle | Spent: 0 USDC (0 checks) | Left: 0 USDC')
          out(`Nothing started yet. Start with: ${CMD} buy`)
          return 1
        }
        const st = loadBuy(buyPath)
        const lines = await statusLines({ algorand: aw, stellar: loadStellarWallet(spath), statePath, buyPath, ledgerPath, algod, fetchImpl }, alive(st))
        for (const l of lines) out(l)
        if (/^Status: Idle/.test(lines[0]) && st.funded) out(`To get what is left back as XLM: ${CMD} refund --to <YOUR STELLAR ADDRESS>`)
        return 0
      }

      if (cmd === 'refund') {
        const at = argv.indexOf('--to')
        const to = at >= 0 ? argv[at + 1] : undefined
        if (!to || to.startsWith('--')) {
          out(`Name your own Stellar address: ${CMD} refund --to <YOUR STELLAR ADDRESS>`)
          return 1
        }
        const sw = loadStellarWallet(spath)
        if (!isStellarAddress(to) || to === sw?.address) {
          out(`${to} is not your Stellar address. It starts with G and is 56 characters long.`)
          return 1
        }
        const underway = () => exchangeUnderway(loadState(statePath))
        const busy = `Your XLM is still being exchanged. Wait until ${CMD} status no longer says Running, then run the refund again.`
        if (underway()) {
          out(busy)
          return 2
        }
        // The worker is only waiting for XLM: stop it, so nothing new starts while the money goes back.
        const st = loadBuy(buyPath)
        if (st.worker && alive(st)) {
          ;(deps.stopWorker ?? stopProcess)(st.worker.pid)
          const s = loadBuy(buyPath)
          delete s.worker
          saveBuy(buyPath, s)
          if (underway()) {
            out(`An exchange started just now. Run ${CMD} buy to let it finish, then run the refund again.`)
            return 2
          }
        }
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
        return (await refundAll({ algorandPath: path, stellarPath: spath, statePath, to, algod, horizon, fetchImpl, out, now: deps.now, sleep })) ? 0 : 2
      }

      // The background worker: advances until everything is done, then exits.
      if (sub === '--worker') {
        const ctx = walletsCtx()
        if (!ctx) return 1
        const stamp = (l: string) => out(`${new Date(now()).toISOString()}  ${l}`)
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
        const started = now()
        const mark = (f: (s: ReturnType<typeof loadBuy>) => void) => {
          const s = loadBuy(buyPath)
          f(s)
          saveBuy(buyPath, s)
        }
        mark((s) => {
          s.worker = { pid: process.pid, startedAt: new Date(started).toISOString() }
          delete s.stopped
        })
        let errors = 0
        for (;;) {
          try {
            if ((await advanceBuy({ ...ctx, out: stamp, now, sleep: deps.sleep })) === 'done') break
            errors = 0
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            stamp(`Problem: ${msg}`)
            if (++errors >= WORKER_MAX_ERRORS) {
              mark((s) => (s.stopped = `${msg} Run the buy command again to try again.`))
              break
            }
          }
          if (now() - started > WORKER_MAX_MS) {
            mark((s) => (s.stopped = 'It waited 6 hours. Run the buy command again to continue.'))
            break
          }
          await sleep(WORKER_PAUSE_MS)
        }
        mark((s) => delete s.worker)
        return 0
      }

      // `buy` starts a round, or continues the one under way; `status` only looks.
      let st = loadBuy(buyPath)
      const flags = argv.slice(1)
      if (flags.includes('--return')) {
        out(`--return is gone since 0.4.5: nothing is spent or sent back on its own any more. Run ${CMD} buy, and when you are done: ${CMD} refund --to <YOUR STELLAR ADDRESS>`)
        return 1
      }
      for (const l of DISCLOSURE) out(l)
      // Everything a round keeps on this computer, moved aside together (never deleted).
      const answers = join(dirname(buyPath), 'answers')
      const archive = (files: string[]) => {
        const stamp = now()
        retireFiles(files, stamp)
        if (existsSync(answers)) renameSync(answers, `${answers}.closed-${stamp}`)
        return stamp
      }

      if (flags.includes('--new')) {
        // New wallets for this person. Wallets that hold unspent money, or an exchange under
        // way, are never set aside. A round that is still waiting for XLM and has received
        // nothing is set aside (its worker stopped) once it is old enough not to be this
        // person's own, just started: a second `buy --new` a minute later continues it instead.
        const aw = loadWallet(path)
        const sw = loadStellarWallet(spath)
        const br = loadState(statePath)
        if (aw || sw) {
          const exchanging = Boolean((br.fundIn.algo && !br.fundIn.done) || br.fundIn.topUps?.some((r) => !r.settled) || (br.back && !br.back.done))
          const xlm = sw ? (await readXlm(sw.address, horizon, fetchImpl)).xlm : 0
          const usdc = aw ? (await readStatus(aw.address, algod, fetchImpl)).usdc : 0
          const unspent = exchanging || xlm - STELLAR_KEEP_XLM >= 1 || usdc >= 1
          const underway = Boolean(st.round && !st.funded)
          const started = st.roundStartedAt ? Date.parse(st.roundStartedAt) : 0
          if (unspent && (underway || alive(st))) out('A round with money in it is under way on the wallets on this computer; continuing it.')
          else if (unspent) {
            out(
              `The wallets already on this computer still hold money that was not spent (${xlm} XLM, ${usdc} USDC)` +
                `${exchanging ? ', or an exchange is under way' : ''}. Keep using it for checks, or get it back with ` +
                `${CMD} refund --to <YOUR STELLAR ADDRESS>, before starting new wallets.`,
            )
            return 1
          } else if (underway && now() - started < FRESH_ROUND_MS) out('A round was started here a few minutes ago; continuing it.')
          else {
            if (st.worker && alive(st)) (deps.stopWorker ?? stopProcess)(st.worker.pid)
            const stamp = archive([path, spath, statePath, buyPath])
            out(
              `Made new wallets. The earlier ones (Algorand ${aw?.address ?? '-'}, Stellar ${sw?.address ?? '-'}) were moved aside, ` +
                `not deleted: their files in ${dirname(path)} now end in .closed-${stamp}.json, and anything left in them stays there. ` +
                `Do not send anything to the earlier Stellar address.`,
            )
            st = loadBuy(buyPath)
          }
        }
      }

      if (alive(st)) {
        out('Already working on it.')
        const ctx = walletsCtx()
        if (ctx) for (const l of await statusLines({ ...ctx, ledgerPath }, true)) out(l)
        return 0
      }

      const earlier = loadState(statePath)
      if (earlier.back?.done) {
        // A finished return merged the Stellar wallet away: a new round needs a new one. The
        // Algorand wallet stays, with anything left in it.
        archive([spath, statePath, buyPath])
        st = loadBuy(buyPath)
      } else if (earlier.back) {
        out(`What is left is on its way to ${earlier.back.to}. Finish that first: ${CMD} refund --to ${earlier.back.to}`)
        return 1
      }
      const a = createWallet(path)
      const x = createStellarWallet(spath)
      if ((a.created || x.created) && (existsSync(statePath) || existsSync(buyPath))) {
        // State left behind by wallets that are gone (moved by hand, say) belongs to them, not
        // to these new ones: acting on it would treat an empty wallet as funded.
        archive([statePath, buyPath])
        st = loadBuy(buyPath)
      }
      delete st.stopped
      const br = loadState(statePath)
      const funded = Boolean(br.fundIn.done && !br.back)
      if (!st.round || st.funded) {
        // A new round. On wallets an earlier run already funded, nothing tells it XLM is on the
        // way, so it waits for a new deposit before it can call itself funded.
        st.round = (st.round ?? 0) + 1
        st.roundStartedAt = new Date(now()).toISOString()
        delete st.funded
        st.waitForXlm = funded
      }
      saveBuy(buyPath, st)

      const usdcPair = await pair('xlm-stellar', 'usdc-algorand', fetchImpl)
      out('Send XLM to this Stellar address (no memo needed):')
      out(`  ${x.address}`)
      if (funded) {
        // The ALGO for fees is already there: only the exchange into USDC has a minimum.
        out(`Send as much as you want your agent to spend on checks, at least ${Math.ceil(usdcPair.min * 1.02 + 0.1)} XLM.`)
        const held = await readStatus(a.address, algod, fetchImpl)
        if (held.usdc >= 1) out(`The Algorand wallet already holds ${held.usdc} USDC from before; it is part of the same budget.`)
      } else {
        const plan = planIn(await pair('xlm-stellar', 'algo-algorand', fetchImpl), usdcPair)
        out(`Send as much as you want your agent to spend on checks, at least ${plan.totalXlm} XLM.`)
        out(`About ${Math.ceil(plan.algoXlm)} XLM of it first becomes ALGO, which the Algorand wallet needs to hold USDC; once the USDC is in, that ALGO becomes USDC too, all but 0.2.`)
      }
      out('The exchange runs in the background, even if you close this window, as long as this computer stays on. Nothing is spent until your agent asks for a check.')
      out('Then let your agent use it; it finds this wallet on its own:')
      out(`  claude mcp add a-identity-trust -- ${CMD}`)
      out(`or from a terminal: ${CMD} check <ADDRESS, LINK OR AGENT ID> <AMOUNT ABOUT TO BE PAID, IN USD>`)
      out(`To see how it is going: ${CMD} status`)
      out(`(Wallets on this computer, secrets never printed: Stellar ${x.address}, Algorand ${a.address}.)`)
      const pid = (deps.spawnWorker ?? spawnDetached)(['buy', '--worker'], logPath)
      const fresh = loadBuy(buyPath)
      fresh.worker = { pid, startedAt: new Date(now()).toISOString() }
      saveBuy(buyPath, fresh)
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
        out(`Then run: ${CMD} stellar run`)
        return 0
      }
      const aw = loadWallet(path)
      const sw = loadStellarWallet(spath)
      if (!aw || !sw) {
        out(`No one-time wallets yet. Run: ${CMD} stellar start`)
        return 1
      }
      const ctx = { algorand: aw, stellar: sw, statePath, algod, horizon, fetchImpl, out }
      if (sub === 'run') return (await runIn(ctx)) ? 0 : 2
      if (sub === 'return') {
        if (!arg) {
          out(`Name your own Stellar address: ${CMD} stellar return <YOUR STELLAR ADDRESS>`)
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
      out(`No wallet yet. Run: ${CMD} wallet new`)
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
        out(`Name the address to send everything back to: ${CMD} wallet sweep <YOUR ALGORAND ADDRESS>`)
        return 1
      }
      const r = await sweep(w, path, arg, algod, fetchImpl)
      out(`Sent ${r.usdc} USDC and the remaining ALGO (${r.algo} before fees) to ${arg}, and closed the wallet.`)
      out(`Transaction: ${EXPLORER}/tx/${r.txId}`)
      out(`The wallet file was renamed to ${r.retiredFile}; delete it whenever you like.`)
      return 0
    }

    if (cmd === 'check' || cmd === 'ask') {
      // Every check goes through the gate: saved answers are free, new ones are paid for once,
      // and a wallet without enough USDC is refused before anything is signed.
      const gate = gateFor(w)
      if (cmd === 'check') {
        const amount = arg === undefined ? 0 : Number(arg)
        if (!sub || !Number.isFinite(amount) || amount < 0) {
          out(`Usage: ${CMD} check <ADDRESS, LINK OR AGENT ID> [AMOUNT ABOUT TO BE PAID, IN USD]`)
          return 1
        }
        describeDecision(out, await checkBeforePay(gate, sub, amount))
        return 0
      }
      const tool = ASK[sub ?? '']
      if (!tool || !arg) {
        out(`Usage: ${CMD} ask <verify|reputation|risk|passport> <AGENT ID> [DEAL USD]`)
        return 1
      }
      const deal = extra === undefined ? undefined : Number(extra)
      describeAnswer(out, tool, await askOne(gate, tool, arg, deal !== undefined && Number.isFinite(deal) ? deal : undefined))
      return 0
    }

    out(HELP)
    return 1
  } catch (e) {
    const { error } = explain(e, true)
    out(/^(Not paid|Stopped|Payment refused)/.test(error) ? error : `Not done: ${error}`)
    if (/budget is spent|wallet holds 0 USDC/.test(error)) {
      const w = loadWallet(path)
      if (w) out(nextStep(await readStatus(w.address, algod, fetchImpl).catch(() => ({ address: w.address, exists: false, algo: 0, minBalanceAlgo: 0.1, usdcOptedIn: false, usdc: 0, otherAssets: 0 }))))
    }
    return 1
  }
}
