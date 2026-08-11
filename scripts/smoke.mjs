import { chromium } from 'playwright'

/**
 * Renders every route against the live backend and fails on any console error or page
 * exception. The point is to catch what tsc cannot: a hook-order break or an undefined
 * component introduced while moving code between files.
 */
const BASE = 'http://localhost:4173'
// /stats and /intro were missing, which is how a redesign of /stats reached a build
// without this catching anything. /brand-kit stays listed even though it now redirects
// to /brand: the redirect itself is worth a check.
const PUBLIC = ['/', '/explorer?q=849980', '/celo-proof', '/stats', '/intro', '/mascot', '/brand-kit', '/motion', '/manifesto', '/brand', '/contact', '/faq', '/blog', '/architecture', '/login', '/bozuk-link']
const CONSOLE = ['/app', '/app/agent-id', '/app/wallet', '/app/settlements', '/app/permissions', '/app/marketplace', '/app/earnings']

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
console.log('\n' + (problems.length ? `${problems.length} route(s) with problems:` : 'ALL ROUTES CLEAN'))
for (const [p, e] of problems) { console.log('\n' + p); e.slice(0, 4).forEach((x) => console.log('   ' + x.slice(0, 200))) }
process.exit(problems.length ? 1 : 0)
