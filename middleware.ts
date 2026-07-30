/**
 * Markdown content negotiation for agents.
 *
 * An agent that asks for `Accept: text/markdown` should get prose, not a
 * single-page-app shell it has to execute JavaScript to read. The obvious way to
 * do this is a rewrite in vercel.json conditioned on the Accept header, and it
 * does not work: Vercel resolves the filesystem before it reaches `rewrites`, so
 * `/` matches the built `index.html` and the rewrite is never consulted. The
 * symptom is the worst kind, a response that says `Content-Type: text/markdown`
 * over an HTML body.
 *
 * Routing Middleware runs before any of that, which is why this file exists.
 * Browsers never send `text/markdown` in Accept, so nothing here is reachable by
 * a human and the rendered site is untouched.
 *
 * Docs: https://vercel.com/docs/routing-middleware
 */
export const config = {
  // Only the routes that have a markdown twin. Everything else skips the
  // middleware entirely rather than paying for an invocation to do nothing.
  matcher: ['/', '/manifesto', '/faq'],
}

/** Does this client actually want markdown, rather than merely tolerating it?
 *
 *  Browsers send `Accept: text/html,...,* / *;q=0.8`, so a naive substring test
 *  for a wildcard would hand every visitor a text file. We require markdown to be
 *  named explicitly and not disclaimed with `q=0`.
 */
function wantsMarkdown(accept: string | null): boolean {
  if (!accept) return false
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().split(';')
    if (type.trim().toLowerCase() !== 'text/markdown') continue
    const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='))
    if (q && Number(q.slice(2)) === 0) return false
    return true
  }
  return false
}

export default async function middleware(request: Request): Promise<Response | undefined> {
  if (!wantsMarkdown(request.headers.get('accept'))) return undefined

  const url = new URL(request.url)
  const upstream = await fetch(new URL('/index.md', url.origin), {
    headers: { accept: 'text/plain' },
  })
  if (!upstream.ok) return undefined // fall through to the HTML page rather than erroring

  const body = await upstream.text()

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      // Caches must not hand this markdown to the next visitor asking for HTML.
      vary: 'Accept',
      'cache-control': 'public, max-age=0, must-revalidate',
      // Rough token count, so a caller can budget before it reads. The 4-chars-per-token
      // rule of thumb is approximate by nature and the header is advisory.
      'x-markdown-tokens': String(Math.ceil(body.length / 4)),
      link: '</llms-full.txt>; rel="service-doc"; type="text/markdown", </.well-known/api-catalog>; rel="api-catalog"',
    },
  })
}
