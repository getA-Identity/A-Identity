/**
 * Render the live OpenAPI spec as a print-ready API reference PDF.
 *
 * Circle's intake form accepts PDF, document or spreadsheet only, so the raw
 * openapi.json cannot be uploaded directly. This renders the SAME document the
 * server serves, fetched live rather than read from disk, so the PDF can never
 * describe a spec the service does not actually publish.
 */
import playwright from '/Users/mericcintosun/A-Identity/node_modules/playwright/index.js'
import { writeFileSync } from 'node:fs'

const SPEC_URL = 'https://a-identity-asp.onrender.com/openapi.json'
const OUT = process.argv[2] ?? '/Users/mericcintosun/Downloads/A-Identity-Trust-Oracle-API.pdf'

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const spec = await (await fetch(SPEC_URL)).json()

const METHODS = ['get', 'post', 'put', 'patch', 'delete']
const ops = []
for (const [path, item] of Object.entries(spec.paths)) {
  for (const m of METHODS) {
    if (item[m]) ops.push({ path, method: m.toUpperCase(), op: item[m], servers: item.servers })
  }
}
const paid = ops.filter((o) => o.op['x-price'] && o.op['x-price'] !== 'free')
const free = ops.filter((o) => !o.op['x-price'] || o.op['x-price'] === 'free')

/** Resolve a $ref (one level is all this spec needs) into a readable field list. */
function fields(schema) {
  if (!schema) return []
  if (schema.$ref) {
    const key = schema.$ref.split('/').pop()
    return fields(spec.components.schemas[key])
  }
  if (schema.allOf) return schema.allOf.flatMap(fields)
  const req = schema.required ?? []
  return Object.entries(schema.properties ?? {}).map(([name, p]) => ({
    name,
    type: p.type ?? 'object',
    required: req.includes(name),
    desc: p.description ?? '',
    example: p.examples?.[0],
  }))
}

function bodyFor(op) {
  const s = op.requestBody?.content?.['application/json']?.schema
  return fields(s)
}

const rails = spec['x-x402']?.rails ?? []

const opHtml = (o) => {
  const f = bodyFor(o.op)
  const price = o.op['x-price'] ?? 'free'
  const isPaid = price !== 'free'
  return `
  <section class="op">
    <div class="op-head">
      <span class="verb verb-${o.method.toLowerCase()}">${o.method}</span>
      <code class="op-path">${esc(o.path)}</code>
      <span class="price ${isPaid ? 'paid' : 'free'}">${esc(price)}</span>
    </div>
    <h3>${esc(o.op.summary ?? '')}</h3>
    ${o.op.description ? `<p>${esc(o.op.description)}</p>` : ''}
    ${o.servers ? `<p class="host">Host: <code>${esc(o.servers[0].url)}</code></p>` : ''}
    ${o.op['x-network'] ? `<p class="host">Settles on: <code>${esc(o.op['x-network'])}</code></p>` : ''}
    ${
      f.length
        ? `<table class="params">
            <thead><tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr></thead>
            <tbody>${f
              .map(
                (p) => `<tr>
                  <td><code>${esc(p.name)}</code></td>
                  <td class="dim">${esc(p.type)}</td>
                  <td>${p.required ? '<span class="req">required</span>' : '<span class="dim">optional</span>'}</td>
                  <td>${esc(p.desc)}${p.example ? ` <span class="dim">e.g. <code>${esc(p.example)}</code></span>` : ''}</td>
                </tr>`,
              )
              .join('')}</tbody>
          </table>`
        : ''
    }
    <table class="params responses">
      <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
      <tbody>${Object.entries(o.op.responses ?? {})
        .map(([code, r]) => {
          const d = r.$ref
            ? spec.components.responses[r.$ref.split('/').pop()]?.description
            : r.description
          return `<tr><td><code>${esc(code)}</code></td><td>${esc(d ?? '')}</td></tr>`
        })
        .join('')}</tbody>
    </table>
  </section>`
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(spec.info.title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #16181d;
         font-size: 9.6pt; line-height: 1.5; margin: 0; }
  code, .mono { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.88em; }
  h1 { font-size: 21pt; letter-spacing: -0.02em; margin: 0 0 2mm; }
  h2 { font-size: 12pt; margin: 9mm 0 3mm; padding-bottom: 1.6mm;
       border-bottom: 1.4px solid #16181d; letter-spacing: -0.01em; }
  h3 { font-size: 10.4pt; margin: 2.4mm 0 1.4mm; }
  p  { margin: 0 0 2.2mm; }
  .lede { font-size: 10pt; color: #3c4048; margin-bottom: 3mm; }
  .meta { color: #6b7280; font-size: 8.4pt; margin-bottom: 5mm; }
  .dim { color: #6b7280; }
  .op { break-inside: avoid; page-break-inside: avoid; margin-bottom: 6mm;
        border-left: 2.4px solid #d8dade; padding-left: 4mm; }
  .op-head { display: flex; align-items: center; gap: 2.4mm; margin-bottom: 1.2mm; }
  .verb { font-family: "SF Mono", Menlo, monospace; font-size: 7.4pt; font-weight: 700;
          letter-spacing: 0.06em; padding: 0.7mm 1.8mm; border-radius: 2.4px; color: #fff; }
  .verb-post { background: #2f6f4f; } .verb-get { background: #2b4a7e; }
  .op-path { font-size: 9.6pt; font-weight: 600; }
  .price { margin-left: auto; font-family: "SF Mono", Menlo, monospace; font-size: 8.2pt;
           padding: 0.7mm 1.8mm; border-radius: 2.4px; }
  .price.paid { background: #f0ece3; color: #6b5a2e; }
  .price.free { background: #e8eef0; color: #41616b; }
  .host { font-size: 8.4pt; color: #6b7280; margin: 0 0 1.4mm; }
  table { border-collapse: collapse; width: 100%; margin: 2mm 0 0; font-size: 8.6pt; }
  th { text-align: left; font-weight: 600; font-size: 7.4pt; text-transform: uppercase;
       letter-spacing: 0.07em; color: #6b7280; border-bottom: 1px solid #d8dade;
       padding: 1.2mm 2mm 1.2mm 0; }
  td { padding: 1.2mm 2mm 1.2mm 0; border-bottom: 1px solid #eceef0; vertical-align: top; }
  .req { color: #8a4a3c; font-size: 7.6pt; font-weight: 600; }
  .responses { margin-top: 2.4mm; }
  .rail { break-inside: avoid; border: 1px solid #d8dade; border-radius: 3px;
          padding: 3mm 3.4mm; margin-bottom: 3mm; }
  .rail h3 { margin-top: 0; }
  .kv { display: grid; grid-template-columns: 32mm 1fr; gap: 0.8mm 3mm; font-size: 8.6pt; }
  .kv dt { color: #6b7280; } .kv dd { margin: 0; }
  .summary-table td:first-child { width: 56mm; white-space: nowrap; }
  footer { margin-top: 8mm; padding-top: 2.4mm; border-top: 1px solid #d8dade;
           font-size: 8pt; color: #6b7280; }
</style></head><body>

<h1>${esc(spec.info.title)}</h1>
<p class="lede">${esc(spec.info.summary ?? '')}</p>
<p class="meta">OpenAPI ${esc(spec.openapi)} &nbsp;|&nbsp; version ${esc(spec.info.version)}
   &nbsp;|&nbsp; ${esc(spec.info.contact?.url ?? '')} &nbsp;|&nbsp; ${esc(spec.info.license?.name ?? '')}<br>
   Generated from the live specification at ${esc(SPEC_URL)}</p>

<h2>Overview</h2>
${spec.info.description
  .split('\n\n')
  .map((p) => `<p>${esc(p)}</p>`)
  .join('')}

<h2>Endpoints at a glance</h2>
<table class="summary-table">
  <thead><tr><th>Endpoint</th><th>Price</th><th>What it answers</th></tr></thead>
  <tbody>${[...paid, ...free]
    .map(
      (o) => `<tr>
        <td><code>${esc(o.method)} ${esc(o.path)}</code></td>
        <td class="mono">${esc(o.op['x-price'] ?? 'free')}</td>
        <td>${esc(o.op.summary ?? '')}</td>
      </tr>`,
    )
    .join('')}</tbody>
</table>

<h2>Settlement rails</h2>
${rails
  .map(
    (r) => `<div class="rail">
      <h3>${esc(r.networkName)} <span class="dim">(${esc(r.name)})</span></h3>
      <dl class="kv">
        <dt>Network</dt><dd><code>${esc(r.network)}</code></dd>
        <dt>Scheme</dt><dd><code>${esc(r.scheme)}</code></dd>
        <dt>Asset</dt><dd>${esc(r.asset)}${r.assetAddress ? ` <code>${esc(r.assetAddress)}</code>` : ''}</dd>
        ${r.facilitator ? `<dt>Facilitator</dt><dd>${esc(r.facilitator)}</dd>` : ''}
        ${r.verifyingContract ? `<dt>Verifying contract</dt><dd><code>${esc(r.verifyingContract)}</code></dd>` : ''}
        <dt>Applies to</dt><dd><code>${esc(r.paths)}</code></dd>
      </dl>
      <p style="margin-top:2mm">${esc(r.note)}</p>
    </div>`,
  )
  .join('')}

<h2>Paid endpoints</h2>
${paid.map(opHtml).join('')}

<h2>Free endpoints</h2>
${free.map(opHtml).join('')}

<footer>
  Every paid endpoint answers an unpaid request with HTTP 402 and a machine-readable payment
  challenge carrying the input schema and a worked example, then serves the resource on a paid
  retry. Settlements are published at /proof and the scoring method at /methodology.
</footer>
</body></html>`

const browser = await playwright.chromium.launch()
const page = await browser.newPage()
await page.setContent(html, { waitUntil: 'load' })
await page.pdf({ path: OUT, format: 'A4', printBackground: true })
await browser.close()

writeFileSync(OUT.replace(/\.pdf$/, '.debug.html'), html)
console.log(`wrote ${OUT}`)
console.log(`ops: ${ops.length} (paid ${paid.length}, free ${free.length}), rails: ${rails.length}`)
