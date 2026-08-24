#!/usr/bin/env node
/**
 * Regenerates docs/images/stellar-tests-passed.png, the tests-passed evidence for the
 * Instawards SoW deliverable D3.
 *
 * A screenshot of a terminal is the weakest kind of evidence there is, because a picture
 * of green text is trivially faked and impossible to re-check. So this script does not
 * take a picture of anything. It RUNS the three suites, fails if any of them is not
 * green, and renders the image out of their own stdout. Nothing in the picture is typed
 * by a human: the test names, the counts and the summary lines are the bytes the commands
 * printed on the machine that ran this, and the toolchain versions and commit come from
 * the environment rather than a literal someone forgot to update.
 *
 * That means the image cannot drift away from the repo. If a test is renamed the picture
 * says the new name; if a suite goes red there is no picture at all.
 *
 * Usage:  node scripts/gen-stellar-tests-image.mjs
 * Needs:  a Rust toolchain (soroban/rust-toolchain.toml pins it) and `npm ci` at the root
 *         for playwright. Takes a few minutes, because the negative-control runner
 *         recompiles the contract once per control.
 */
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs/images/stellar-tests-passed.png')

/**
 * Runs a command through a shell, so the string executed here is character for character
 * the string the image shows above the output. A glob expanded by node instead of by sh
 * would make the picture claim a command nobody actually ran.
 */
const run = (cmd, cwd, label) => {
  process.stderr.write(`  running ${label} ...\n`)
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    process.stderr.write(String(err.stdout ?? '') + String(err.stderr ?? ''))
    throw new Error(`${label} did not pass. No image is written for a red suite.`)
  }
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const one = (lines, re, label) => {
  const hit = lines.find((l) => re.test(l))
  if (!hit) throw new Error(`could not find ${label} in the output; this script needs updating`)
  return hit
}

// ---------------------------------------------------------------- run the three suites

const CMD = {
  cargo: 'cargo test',
  negctl: 'node soroban/audit/run-negative-controls.mjs',
  rail: 'npx tsx --test src/x402-stellar/*.test.ts src/chains/stellar/*.test.ts',
  backend: 'npm test',
}

const cargo = strip(run(CMD.cargo, join(ROOT, 'soroban'), 'cargo test')).split('\n')
const negctl = strip(run(CMD.negctl, ROOT, 'negative controls')).split('\n')
const railOut = strip(run(CMD.rail, join(ROOT, 'mcp'), 'the Stellar rail tests')).split('\n')
const backend = strip(run(CMD.backend, join(ROOT, 'mcp'), 'the full backend suite')).split('\n')

// ------------------------------------------------------------------- pane 1, all 52

const cargoTests = cargo.filter((l) => l.startsWith('test test::'))
const cargoResult = one(cargo, /^test result:/, 'the cargo summary line')
if (!cargoResult.includes('0 failed')) throw new Error(`cargo test was not green: ${cargoResult}`)
const paneOne = cargoTests
  .map((l) => {
    const m = l.match(/^(.*?)(\s\.\.\. ok)$/)
    return m ? `<div>${esc(m[1])}<span class="ok">${esc(m[2])}</span></div>` : `<div>${esc(l)}</div>`
  })
  .join('\n')

// ------------------------------------------------------- pane 2, the deletion runner

const negctlBody = negctl.join('\n').trimEnd()
if (!/All \d+ negative controls were caught\./.test(negctlBody)) {
  throw new Error('the negative-control runner did not report every control caught')
}
const paneTwo = esc(negctlBody).replace(/\b(green|caught)\b/g, '<span class="ok">$1</span>')

// ------------------------------------------------- pane 3, a named spread of the rail

const railNames = railOut.filter((l) => l.startsWith('✔')).map((l) => l.replace(/\s\([\d.]+ms\)$/, '').slice(2))
/**
 * Which rail tests to show. These are SELECTED by substring and then printed from the
 * run's own output, never retyped: a pick that stops matching exactly one test throws,
 * so a renamed test breaks this script instead of quietly leaving stale copy in a picture
 * that claims to be a terminal.
 */
const PICKS = [
  'redeemed and recorded as the buyer having paid',
  'the same hash cannot be redeemed twice',
  'the facts come off the chain not the request',
  'no transfer at all is refused',
  'on the WRONG token is refused',
  'a transfer to someone else, on our authorization',
  'settling a DIFFERENT authorization, is refused',
  'so a replay is named as a replay',
  'a failed transaction is decided, and decided against',
  'the RPC has never seen is undecided, not refused',
  'unconfirmed, and the buyer is told to come back',
  'an unreachable RPC is its own outcome',
  'is our blindness, not a refusal',
  'fails closed rather than skipping the binding',
  'verify never broadcasts',
  'the way x402 clients expect',
  'settling for somebody else is refused until they are allowlisted',
  'settle is closed by default',
  'credits OpenZeppelin Channels as prior art',
  'the passphrase a buyer must sign against',
  'an unsigned write returns the exact call it would have made',
  'every owner control has a prepared path too',
]
const picked = PICKS.map((needle) => {
  const hit = railNames.filter((n) => n.includes(needle))
  if (hit.length !== 1) throw new Error(`pick "${needle}" matched ${hit.length} tests, expected exactly 1`)
  return hit[0]
})
const paneThree = picked.map((n) => `<div class="tick"><span class="ok">&check;</span> ${esc(n)}</div>`).join('\n')
const railSummary = railOut.filter((l) => /^ℹ (tests|pass|fail|duration_ms)/.test(l)).map(esc)
const railPass = Number(one(railOut, /^ℹ pass /, 'the rail pass count').split(' ').pop())
const railFail = Number(one(railOut, /^ℹ fail /, 'the rail fail count').split(' ').pop())
if (railFail !== 0) throw new Error(`the Stellar rail suite was not green: ${railFail} failed`)

const backendPass = Number(one(backend, /^ℹ pass /, 'the backend pass count').split(' ').pop())
const backendFail = Number(one(backend, /^ℹ fail /, 'the backend fail count').split(' ').pop())
if (backendFail !== 0) throw new Error(`the backend suite was not green: ${backendFail} failed`)

// ------------------------------------------------------ facts, read rather than typed

const release = JSON.parse(readFileSync(join(ROOT, 'soroban/releases/testnet-v0.1.0.json'), 'utf8'))
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const rustc = execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim().split(' ')[1]
const today = new Date().toISOString().slice(0, 10)

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg:#0d1117; --panel:#12181f; --line:#22303c; --fg:#c9d5e1; --dim:#7c8b9a; --ok:#4ec9a0; --accent:#E0B23C; --white:#e8eef4; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:"SF Mono","Menlo","Consolas",monospace; width:1560px; padding:34px 38px 30px; }
  header { display:flex; align-items:baseline; gap:14px; border-bottom:1px solid var(--line); padding-bottom:16px; margin-bottom:20px; }
  h1 { font-size:19px; margin:0; color:var(--white); font-weight:600; letter-spacing:-0.2px; }
  .chip { color:#0d1117; background:var(--accent); padding:2px 9px; border-radius:4px; font-size:11px; font-weight:700; letter-spacing:0.4px; }
  .meta { margin-left:auto; color:var(--dim); font-size:11.5px; text-align:right; line-height:1.7; }
  .row { display:grid; gap:18px; margin-bottom:18px; }
  .row.two { grid-template-columns:1fr 1fr; align-items:start; }
  .pane { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; }
  .pane-head { padding:9px 14px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:8px; background:#0f151c; }
  .dots { display:flex; gap:5px; }
  .dot { width:9px; height:9px; border-radius:50%; }
  .pane-title { color:var(--dim); font-size:11.5px; }
  .pane-body { padding:12px 15px 15px; flex:1; font-size:11.3px; line-height:1.62; white-space:pre-wrap; }
  .tests { column-count:2; column-gap:26px; white-space:pre; font-size:10.9px; line-height:1.66; }
  .tests div { break-inside:avoid; }
  .tick { white-space:normal; padding-left:14px; text-indent:-14px; }
  .cmd { color:var(--white); }
  .cmd .p { color:var(--ok); }
  .ok { color:var(--ok); }
  .dim { color:var(--dim); }
  .white { color:var(--white); }
  .caption { padding:11px 15px; border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:6px; color:var(--dim); font-size:11.7px; line-height:1.75; background:var(--panel); }
  .caption b { color:var(--fg); font-weight:600; }
</style></head><body>
  <header>
    <span class="chip">STELLAR TESTNET</span>
    <h1>AgentSpendPolicy: test suites passing</h1>
    <div class="meta">A-Identity &middot; Instawards SoW D3 evidence<br>commit ${commit} &middot; ${today} &middot; rustc ${rustc}, node ${process.version}</div>
  </header>

  <div class="row">
    <div class="pane">
      <div class="pane-head"><div class="dots"><div class="dot" style="background:#e0504a"></div><div class="dot" style="background:#e0b23c"></div><div class="dot" style="background:#4ec9a0"></div></div><div class="pane-title">1. the contract: soroban/, all ${cargoTests.length} tests shown</div></div>
      <div class="pane-body"><span class="cmd"><span class="p">$</span> cd soroban &amp;&amp; ${esc(CMD.cargo)}</span>
<span class="dim">    Finished \`test\` profile [unoptimized + debuginfo] target(s)
     Running unittests src/lib.rs</span>

running ${cargoTests.length} tests
<div class="tests">${paneOne}</div>
<span class="white">${esc(cargoResult)}</span></div>
    </div>
  </div>

  <div class="row two">
    <div class="pane">
      <div class="pane-head"><div class="dots"><div class="dot" style="background:#e0504a"></div><div class="dot" style="background:#e0b23c"></div><div class="dot" style="background:#4ec9a0"></div></div><div class="pane-title">2. negative controls: would the tests notice?</div></div>
      <div class="pane-body"><span class="cmd"><span class="p">$</span> ${esc(CMD.negctl)}</span>
${paneTwo}

<span class="dim">Why this pane exists, and why it outranks the count above it.
\`pay\` moves the vault's OWN balance, so Soroban's direct-call rule
satisfies the token's from-side authorization by itself, and Soroban
has no msg.sender. The entire authorization surface collapses onto
one line, operator.require_auth(). Delete it and every policy gate
still passes and every amount is still checked. The vault is simply
drainable by anyone. The usual harness, mock_all_auths(), hides
exactly that: a suite written the normal way passes identically
against a contract with the guard removed. So each control deletes
one guard and REQUIRES the suite to go red.</span></div>
    </div>

    <div class="pane">
      <div class="pane-head"><div class="dots"><div class="dot" style="background:#e0504a"></div><div class="dot" style="background:#e0b23c"></div><div class="dot" style="background:#4ec9a0"></div></div><div class="pane-title">3. the x402 rail: mcp/src/x402-stellar, mcp/src/chains/stellar, ${picked.length} of ${railPass} shown</div></div>
      <div class="pane-body"><span class="cmd"><span class="p">$</span> cd mcp &amp;&amp; ${esc(CMD.rail)}</span>

${paneThree}
<span class="dim">        ... ${railNames.length - picked.length} more</span>

<span class="white">${railSummary.join('\n')}</span>

<span class="dim">The full backend suite is ${backendPass} tests, also green:
$ cd mcp &amp;&amp; ${esc(CMD.backend)}   ->   pass ${backendPass}, fail ${backendFail}</span></div>
    </div>
  </div>

  <div class="caption"><b>What this shows, and what it does not.</b> Pane 1 is the Soroban contract deployed at <b>${release.contractId}</b> on Stellar testnet passing its own suite. Pane 2 carries more weight than the count in pane 1: a green suite proves the contract passes its tests, and only the deletion runner proves the tests would go red if the contract stopped being safe. Pane 3 is the x402 rail the agent buys through, where a payment counts as settled only once we have read the transfer off the chain ourselves. This is testnet only and it is not an audit, and we do not call it one.</div>
</body></html>`

const scratch = mkdtempSync(join(tmpdir(), 'stellar-tests-'))
const pagePath = join(scratch, 'shot.html')
writeFileSync(pagePath, html)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1560, height: 1200 }, deviceScaleFactor: 2 })
await page.goto(`file://${pagePath}`)
await page.screenshot({ path: OUT, fullPage: true })
await browser.close()

process.stderr.write(
  `\nwrote docs/images/stellar-tests-passed.png\n` +
    `  contract: ${cargoTests.length} tests green\n` +
    `  controls: every guard deletion caught\n` +
    `  rail:     ${railPass} tests green (backend total ${backendPass})\n`,
)
