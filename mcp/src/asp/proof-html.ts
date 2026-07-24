/**
 * Human-readable HTML for GET /proof - served when a browser (a judge clicking the link)
 * hits the endpoint; agents/API callers still get JSON via content negotiation. Restyled to
 * match a-identity.xyz/explorer: an onchain-explorer aesthetic (mono/tabular figures, hairline
 * tables, a credit-score spectrum for the showcase agent), light/dark with a manual toggle,
 * self-contained. Data comes from ./proof.ts - the same verifiable facts, presented for a person.
 */
import { PROOF } from './proof.js'

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`

const TOOL_ORDER = ['verify_agent', 'reputation_score', 'risk_check', 'agent_passport']

export function renderProofHtml(): string {
  const p = PROOF
  const rev = p.realOnchainRevenue
  const byTool = rev.byTool as Record<string, number>

  // Showcase agent reputation → a credit-score spectrum (parse the leading number).
  const repStr = String(p.showcaseAgent.reputation)
  const scoreNum = parseInt(repStr, 10) || 0
  const scorePct = Math.max(0, Math.min(100, scoreNum / 10))
  const verdict = scoreNum >= 500 ? 'ALLOW' : scoreNum >= 200 ? 'WARN' : 'DENY'
  const vColor = verdict === 'ALLOW' ? 'var(--ok)' : verdict === 'WARN' ? 'var(--warn)' : 'var(--bad)'
  const gradeLabel =
    scoreNum >= 800 ? 'Excellent · AAA' : scoreNum >= 650 ? 'Strong · AA' : scoreNum >= 500 ? 'Good · A'
    : scoreNum >= 350 ? 'Fair · BBB' : scoreNum >= 200 ? 'Weak · B' : 'High risk · C'

  const SERVICES = [
    ['verify_agent', '$0.001', 'ERC-8004 on-chain identity + KYA status'],
    ['reputation_score', '$0.002', 'Deterministic 0-1000 reputation (+ on-chain ERC-8004 attestation)'],
    ['risk_check', '$0.005', 'Pre-transaction ALLOW / WARN / DENY with reasons'],
    ['agent_passport', '$0.01', 'Full passport: identity + KYA + reputation + risk'],
    ['counterparty_check', '$0.008', 'Deal-specific verdict between two agents (+ same-operator self-deal check)'],
  ]
  const serviceRows = SERVICES
    .map(([t, price, w]) => `<tr><td><code>${t}</code></td><td class="mono price">${price}</td><td class="wrapcell">${esc(w)}</td></tr>`)
    .join('')
  const attest = (p.showcaseAgent as { onchainReputationAttestation?: { txUrl: string; tx: string; registry: string } }).onchainReputationAttestation

  const chips = [
    `<button class="chip active" data-f="all">All ${rev.totalSettlements}</button>`,
    ...TOOL_ORDER.filter((t) => byTool[t]).map(
      (t) => `<button class="chip" data-f="${t}"><code>${t}</code> ${byTool[t]}</button>`,
    ),
  ].join('')

  const settleRows = rev.settlements
    .map(
      (s, i) =>
        `<tr data-tool="${esc(s.tool)}"><td class="mono faint">${i + 1}</td><td>${
          s.round === 0 ? '<span class="demo">demo</span>' : `<span class="mono faint">${esc(s.round)}</span>`
        }</td><td><code>${esc(s.tool)}</code></td><td class="mono price">$${s.amountUsd}</td><td><a href="${esc(
          s.txUrl,
        )}" target="_blank" rel="noopener"><code>${esc(short(s.txHash))}</code> ↗</a></td></tr>`,
    )
    .join('')

  const verifyList = p.howToVerify.map((v) => `<li>${esc(v)}</li>`).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>A-Identity Trust Oracle - Proof (OKX.AI Agent #6271)</title>
<style>
  :root {
    --bg:#f6f5f2; --surface:#ffffff; --surface2:#faf9f6; --border:#e7e3dd; --border2:#f0ece7;
    --text:#141c26; --muted:#5f6b78; --faint:#9aa5b1; --accent:#7342e2;
    --ok:#059669; --warn:#d97706; --bad:#dc2626;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme]) {
    --bg:#0d1014; --surface:#151a20; --surface2:#11151a; --border:#252b34; --border2:#1c222a;
    --text:#e9edf2; --muted:#98a3b1; --faint:#5a6572; --accent:#a184f2;
    --ok:#34d399; --warn:#fbbf24; --bad:#f87171;
  }}
  :root[data-theme="dark"] {
    --bg:#0d1014; --surface:#151a20; --surface2:#11151a; --border:#252b34; --border2:#1c222a;
    --text:#e9edf2; --muted:#98a3b1; --faint:#5a6572; --accent:#a184f2;
    --ok:#34d399; --warn:#fbbf24; --bad:#f87171;
  }
  * { box-sizing:border-box; }
  html,body { background:var(--bg); }
  body { margin:0; color:var(--text); font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif; -webkit-font-smoothing:antialiased; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }
  .faint { color:var(--faint); }
  a { color:var(--accent); text-decoration:none; font-weight:500; }
  a:hover { text-decoration:underline; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; color:var(--text); background:color-mix(in srgb, var(--text) 6%, transparent); padding:1px 6px; border-radius:5px; }
  a code { color:var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent); }

  .topbar { position:sticky; top:0; z-index:5; border-bottom:1px solid var(--border); background:color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter:blur(8px); }
  .topbar .in { max-width:900px; margin:0 auto; padding:12px 20px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:800; letter-spacing:-0.01em; }
  .dot { width:16px; height:16px; border-radius:5px; background:linear-gradient(135deg,var(--accent),#4f2bb0); }
  .livechip { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; color:var(--muted); }
  .livechip::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--ok); }
  .tgl { border:1px solid var(--border); background:var(--surface); color:var(--text); width:34px; height:34px; border-radius:9px; cursor:pointer; display:grid; place-items:center; font-size:15px; }
  .tgl:hover { border-color:var(--accent); }

  .wrap { max-width:900px; margin:0 auto; padding:34px 20px 72px; }
  h1 { font-size:26px; margin:0 0 6px; letter-spacing:-0.02em; font-weight:800; }
  .tag { color:var(--muted); font-size:14.5px; max-width:66ch; }
  h2 { font-size:12px; margin:38px 0 12px; color:var(--faint); text-transform:uppercase; letter-spacing:0.09em; font-weight:700; }

  .kpi { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin:22px 0 4px; }
  .kpi div { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:13px 16px; }
  .kpi b { display:block; font-size:23px; font-weight:800; letter-spacing:-0.02em; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }
  .kpi span { font-size:11.5px; color:var(--muted); text-transform:uppercase; letter-spacing:0.03em; }

  .panel { background:var(--surface); border:1px solid var(--border); border-radius:14px; overflow:hidden; }
  .panel .pad { padding:18px 18px; }
  .showcase { display:flex; flex-wrap:wrap; align-items:center; gap:18px 26px; }
  .showcase .score { font:800 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; letter-spacing:-0.02em; }
  .spectrum { flex:1; min-width:240px; }
  .spectrum .bar { position:relative; height:8px; border-radius:999px; background:linear-gradient(90deg,var(--bad) 0%,var(--warn) 45%,var(--ok) 100%); }
  .spectrum .ptr { position:absolute; top:-4px; width:3px; height:16px; border-radius:2px; background:var(--text); box-shadow:0 0 0 2px var(--surface); transform:translateX(-50%); transition:left .9s cubic-bezier(.16,1,.3,1); }
  .spectrum .ticks { display:flex; justify-content:space-between; margin-top:6px; font-size:10px; color:var(--faint); }
  .rpill { display:inline-flex; align-items:center; gap:6px; padding:5px 11px; border-radius:8px; font-size:12px; font-weight:700; }

  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th,td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--border2); vertical-align:top; white-space:nowrap; }
  th { color:var(--faint); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; }
  tr:last-child td { border-bottom:0; }
  .wrapcell { white-space:normal; color:var(--muted); }
  .price { color:var(--text); font-weight:600; }
  .grid { display:grid; gap:9px 18px; grid-template-columns:160px 1fr; font-size:14px; }
  .grid dt { color:var(--muted); } .grid dd { margin:0; }
  ul { margin:8px 0; padding-left:20px; color:var(--muted); } li { margin:5px 0; }

  .filters { display:flex; flex-wrap:wrap; gap:7px; margin:4px 0 12px; }
  .chip { background:var(--surface); border:1px solid var(--border); color:var(--text); border-radius:999px; padding:5px 12px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit; transition:all .12s; }
  .chip:hover { border-color:var(--accent); }
  .chip.active { background:var(--accent); border-color:var(--accent); color:#fff; }
  .chip.active code { color:#fff; background:rgba(255,255,255,0.2); }
  .chip code { font-size:11px; }
  .scroll { max-height:380px; overflow-y:auto; }
  .scroll thead th { position:sticky; top:0; background:var(--surface2); z-index:1; }
  .demo { display:inline-block; background:color-mix(in srgb, var(--accent) 12%, transparent); color:var(--accent); border-radius:6px; padding:0 7px; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; }
  .overflow { overflow-x:auto; }
  footer { margin-top:44px; padding-top:20px; border-top:1px solid var(--border); color:var(--faint); font-size:13px; }
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="brand"><span class="dot"></span> A-Identity <span class="mono" style="font-weight:600;color:var(--muted);font-size:12px;">Trust Oracle</span></div>
  <div style="display:flex;align-items:center;gap:14px;">
    <span class="livechip">Live on OKX.AI · Agent ${esc(p.asp.agentId)}</span>
    <button class="tgl" id="themeBtn" aria-label="Toggle theme" title="Toggle theme">◐</button>
  </div>
</div></div>

<div class="wrap">
  <h1>The trust oracle for the agent economy</h1>
  <div class="tag">Before any agent-to-agent transaction, an agent calls A-Identity to verify the counterparty. Four x402 pay-per-call tools over a live on-chain engine.</div>

  <div class="kpi">
    <div><b>${esc(p.asp.agentId)}</b><span>OKX.AI Agent</span></div>
    <div><b>${rev.totalSettlements}</b><span>mainnet settlements</span></div>
    <div><b>$${rev.totalUsd}</b><span>on-chain revenue</span></div>
    <div><b id="live-recv">-</b><span>received · live</span></div>
    <div><b>${SERVICES.length}</b><span>x402 services</span></div>
    <div><b>${p.engineering.tests}</b><span>unit tests</span></div>
  </div>

  <h2>Showcase agent - real, not a mock</h2>
  <div class="panel"><div class="pad showcase">
    <div>
      <div style="font-size:12px;color:var(--faint);text-transform:uppercase;letter-spacing:0.05em;">${esc(p.showcaseAgent.name)} · ERC-8004 ${esc(p.showcaseAgent.erc8004TokenId)}</div>
      <div class="score">${scoreNum || esc(repStr)}<span style="font-size:15px;color:var(--faint);"> / 1000</span></div>
      ${attest ? `<div style="font-size:12px;margin-top:6px;"><a href="${esc(attest.txUrl)}" target="_blank" rel="noopener">Anchored on-chain · ERC-8004 ReputationRegistry <code>${esc(short(attest.tx))}</code> ↗</a></div>` : ''}
    </div>
    <div class="spectrum">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
        <span style="font-size:13px;font-weight:700;color:${vColor};">${gradeLabel}</span>
        <span class="rpill" style="color:${vColor};background:color-mix(in srgb, ${vColor} 12%, transparent);">${verdict}</span>
      </div>
      <div class="bar"><span class="ptr" style="left:${scorePct}%"></span></div>
      <div class="ticks"><span>0</span><span>250</span><span>500</span><span>750</span><span>1000</span></div>
    </div>
  </div></div>

  <h2>Live ASP</h2>
  <dl class="grid">
    <dt>Type</dt><dd><code>${esc(p.asp.type)}</code></dd>
    <dt>Network</dt><dd class="mono">${esc(p.asp.network)}</dd>
    <dt>Registration</dt><dd><a href="${esc(p.asp.registrationTxUrl)}" target="_blank" rel="noopener"><code>${esc(short(p.asp.registrationTx))}</code> ↗</a></dd>
    <dt>Docs</dt><dd><a href="${esc(p.docs)}" target="_blank" rel="noopener">${esc(p.docs)}</a></dd>
  </dl>

  <h2>Services - x402 pay-per-call</h2>
  <div class="panel overflow"><table><thead><tr><th>Tool</th><th>Price</th><th>Returns</th></tr></thead><tbody>${serviceRows}</tbody></table></div>

  <h2>Real on-chain revenue - <span id="count">${rev.totalSettlements}</span> settlements</h2>
  <div class="tag" style="margin-bottom:8px;">Real x402 settlements on ${esc(rev.network)} in ${esc(rev.asset)} - each a verifiable USD₮0 transfer to <a href="${esc(rev.payToUrl)}" target="_blank" rel="noopener"><code>${esc(short(rev.payTo))}</code></a>. <span class="demo">demo</span> = the live demo calls; the rest are seeded usage.</div>
  <div class="filters">${chips}</div>
  <div class="panel overflow scroll"><table><thead><tr><th>#</th><th>Round</th><th>Tool</th><th>Amount</th><th>Settlement tx</th></tr></thead><tbody>${settleRows}</tbody></table></div>

  <h2>Engineering rigor</h2>
  <dl class="grid">
    <dt>Tests</dt><dd>${p.engineering.tests} unit tests · deterministic reputation scorer</dd>
    <dt>On-chain reads</dt><dd>${esc(p.engineering.liveOnchainReads)}</dd>
    <dt>Standards</dt><dd class="mono">${esc(p.engineering.standards.join(' · '))}</dd>
    <dt>Methodology</dt><dd><a href="/methodology">/methodology</a> - exact, reproducible formulas</dd>
    <dt>Repo</dt><dd><a href="${esc(p.engineering.repo)}" target="_blank" rel="noopener">${esc(p.engineering.repo)}</a></dd>
  </dl>

  <h2>Verify it yourself</h2>
  <ul>${verifyList}</ul>

  <footer>
    A-Identity · ${esc(p.submission)} · <a href="/proof.json">JSON</a> · <a href="/methodology">/methodology</a> · <a href="${esc(p.docs)}" target="_blank" rel="noopener">a-identity.xyz</a><br>
    Verify first. Pay at machine speed.
  </footer>
</div>
<script>
  (function () {
    var root = document.documentElement;
    var saved = localStorage.getItem('aid-proof-theme');
    if (saved) root.setAttribute('data-theme', saved);
    var btn = document.getElementById('themeBtn');
    if (btn) btn.addEventListener('click', function () {
      var cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem('aid-proof-theme', next);
    });

    var chips = document.querySelectorAll('.chip');
    var rows = document.querySelectorAll('tbody tr[data-tool]');
    var count = document.getElementById('count');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        for (var j = 0; j < chips.length; j++) chips[j].classList.remove('active');
        this.classList.add('active');
        var f = this.getAttribute('data-f'), n = 0;
        for (var k = 0; k < rows.length; k++) {
          var show = f === 'all' || rows[k].getAttribute('data-tool') === f;
          rows[k].style.display = show ? '' : 'none';
          if (show) n++;
        }
        if (count) count.textContent = n;
      });
    }
    fetch('/stats').then(function (r) { return r.json(); }).then(function (s) {
      var el = document.getElementById('live-recv');
      if (el && s && s.payToReceivedUsdt0 != null) el.textContent = '$' + Number(s.payToReceivedUsdt0).toFixed(3);
    }).catch(function () {});
  })();
</script>
</body>
</html>`
}
