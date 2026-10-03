import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

/**
 * Renders every route against the live backend and fails on any console error or page
 * exception. The point is to catch what tsc cannot: a hook-order break or an undefined
 * component introduced while moving code between files.
 *
 * With --serve (what `npm run smoke` passes) this script starts `vite preview` itself and
 * stops it at the end, so its exit code is the verdict. The npm script used to background
 * the preview and `kill %1` it, which a non-interactive shell cannot do: every run exited 1
 * whatever the routes did, and left the server up on 4173. The next run's preview then
 * moved to another port while these checks went on hitting the OLD build. So a port that is
 * already answering is refused here rather than tested.
 */
const BASE = 'http://localhost:4173'

const serve = process.argv.includes('--serve')
let preview = null
if (serve) {
  const busy = await fetch(BASE, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)
  if (busy) {
    console.error(`${BASE} is already serving something. Stop it first: a stale preview would be checked instead of this build.`)
    process.exit(2)
  }
  // vite's own entry under this node, not npx: killing an npx wrapper can leave vite running.
  preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' })
  process.on('exit', () => preview.kill())
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500))
    up = await fetch(BASE, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
  }
  if (!up) {
    preview.kill()
    console.error(`vite preview did not come up on ${BASE} within 30 s.`)
    process.exit(2)
  }
}
// /stats and /intro were missing, which is how a redesign of /stats reached a build
// without this catching anything. /brand-kit stays listed even though it now redirects
// to /brand: the redirect itself is worth a check.
// /app/vault/stellar sits in the console shell but outside the sign-in gate, so it belongs
// here and not in CONSOLE: a reviewer opens it with no account and no wallet.
const PUBLIC = ['/', '/explorer?q=849980', '/arc', '/stellar', '/stellar?network=testnet', '/app/vault/stellar', '/algorand', '/check', '/check?q=WHZ74ZGNGZGAVEQZTHESENVP5RTHMEQ4BOUKF7UHWOADQMKXDKAK3FESJE', '/check/robinhood', '/check/robinhood?q=%230', '/check/arbitrum', '/celo-proof', '/proof', '/proof/arc', '/proof/stellar',
  '/proof/algorand', '/proof/base', '/proof/robinhood', '/proof/arbitrum', '/proof/celo',
  '/stats', '/intro', '/mascot', '/brand-kit', '/motion', '/manifesto', '/brand', '/contact', '/faq', '/blog', '/architecture', '/login', '/bozuk-link']
const CONSOLE = ['/app', '/app/checks', '/app/agent-id', '/app/wallet', '/app/settlements', '/app/permissions', '/app/marketplace', '/app/earnings']

const IGNORE = [/favicon/i, /net::ERR/i, /Failed to load resource/i, /model-viewer/i, /unpkg\.com/i]

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
// Preview only serves static files, so stand in for the Vercel rewrite and forward
// /api and /mcp to the live backend, carrying cookies both ways.
const BACKEND = 'https://a-identity-backend.onrender.com'
const jar = []
const forward = async (route, request) => {
  const url = request.url().replace(BASE, BACKEND)
  const headers = { ...request.headers(), host: 'a-identity-backend.onrender.com' }
  if (jar.length) headers.cookie = jar.join('; ')
  try {
    const res = await fetch(url, { method: request.method(), headers, body: request.postData() ?? undefined, redirect: 'manual' })
    const setCookie = res.headers.getSetCookie?.() ?? []
    for (const c of setCookie) jar.push(c.split(';')[0])
    const body = Buffer.from(await res.arrayBuffer())
    await route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }, body })
  } catch {
    await route.fulfill({ status: 502, body: '{}' })
  }
}
await ctx.route('**/api/**', forward)
await ctx.route('**/mcp', forward)

const problems = []
async function visit(path, label) {
  const page = await ctx.newPage()
  const errs = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (!IGNORE.some((re) => re.test(t))) errs.push(t)
  })
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(3500)
  const bodyLen = await page.evaluate(() => document.getElementById('root')?.innerText?.length ?? 0)
  if (bodyLen < 30) errs.push(`EMPTY RENDER (${bodyLen} chars of text)`)
  if (errs.length) problems.push([label + path, errs])
  console.log(`${errs.length ? 'FAIL' : ' ok '}  ${label}${path}  (${bodyLen} chars)`)
  await page.close()
}

for (const p of PUBLIC) await visit(p, '')

// Sign in as a browse-only guest so the console routes actually mount.
const page = await ctx.newPage()
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.evaluate(async () => {
  const r = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include', body: JSON.stringify({ email: 'smoke@a-identity.xyz', name: 'Smoke' }),
  })
  return r.ok
})
await page.close()
for (const p of CONSOLE) await visit(p, 'auth ')

await browser.close()
preview?.kill()
console.log('\n' + (problems.length ? `${problems.length} route(s) with problems:` : 'ALL ROUTES CLEAN'))
for (const [p, e] of problems) { console.log('\n' + p); e.slice(0, 4).forEach((x) => console.log('   ' + x.slice(0, 200))) }
process.exit(problems.length ? 1 : 0)
