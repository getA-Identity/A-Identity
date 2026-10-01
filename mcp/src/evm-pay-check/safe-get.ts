/**
 * GET a link a stranger pasted, without letting it reach this server's own network.
 *
 * The pay check reads the 402 challenge behind an x402 link, which means this server makes a
 * request to a URL it did not choose. Screening the URL's host and then handing it to fetch
 * leaves a window: the name can resolve to a public address when checked and a private one
 * when connected (DNS rebinding). So the screen runs INSIDE the connection's own lookup, on
 * every address the resolver returns, and the socket only ever connects to an address that
 * passed. Nothing is checked in one place and used in another.
 *
 * Also: https on port 443 only, no credentials in the URL, no IP literals, no redirects
 * followed, GET with no body and no forwarded headers, 8 s to answer, 64 KiB of body at most.
 */
import https from 'node:https'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { isSafePublicHttpUrl } from '../erc8004.js'

const MAX_BYTES = 64 * 1024
const SOCKET_MS = 8000
const OVERALL_MS = 9000
const USER_AGENT = 'A-Identity pay check (+https://a-identity.xyz/check/robinhood)'

/**
 * Every range a public web server cannot legitimately live in, one list per family. Two lists,
 * not one: a BlockList checks an IPv4 address against its IPv6 rules too, as ::ffff:a.b.c.d,
 * so a single list holding the mapped range would refuse every IPv4 address there is.
 */
const BLOCKED_V4 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_V4.addSubnet(net, prefix, 'ipv4')
const BLOCKED_V6 = new BlockList()
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) BLOCKED_V6.addSubnet(net, prefix, 'ipv6')

/** True for anything that is not a public unicast address, including anything unparseable. Pure. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return BLOCKED_V4.check(ip, 'ipv4')
  if (v === 6) return BLOCKED_V6.check(ip, 'ipv6')
  return true
}

export type Fetched = { status: number; headers: Headers; body: string }
export type Refused = { refused: string }

/** The URL-level screen, before any network. Pure. */
export function preflight(raw: string): { url: URL } | Refused {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { refused: 'That is not a link we can read.' }
  }
  if (url.protocol !== 'https:') return { refused: 'Only https links are read.' }
  if (url.username || url.password) return { refused: 'Links with credentials in them are not read.' }
  if (url.port && url.port !== '443') return { refused: 'Only links on the standard https port are read.' }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(host)) return { refused: 'Links to a bare IP address are not read. Paste the link with its domain name.' }
  if (host === 'localhost' || /\.(localhost|local|internal|onion)$/.test(host) || !host.includes('.')) {
    return { refused: 'That link points at a private network, so it is not read.' }
  }
  if (!isSafePublicHttpUrl(url.toString())) return { refused: 'That link points at a private network, so it is not read.' }
  return { url }
}

type Resolver = (hostname: string, options: { all: true; verbatim: true }, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void

/**
 * A `lookup` for https.request that refuses the connection when ANY resolved address is
 * blocked, and otherwise hands the socket exactly the addresses it vetted. Honors
 * `options.all`, which Node's happy-eyeballs connect asks for.
 */
export function guardedLookup(resolve: Resolver = dnsLookup as unknown as Resolver) {
  return (hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void
    const wantAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
    resolve(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err)
      if (!addresses?.length) {
        const e: NodeJS.ErrnoException = new Error(`${hostname} does not resolve`)
        e.code = 'ENOTFOUND'
        return cb(e)
      }
      if (addresses.some((a) => isBlockedIp(a.address))) {
        const e: NodeJS.ErrnoException = new Error(`${hostname} resolves to a non-public address`)
        e.code = 'EBLOCKED'
        return cb(e)
      }
      if (wantAll) return cb(null, addresses)
      cb(null, addresses[0].address, addresses[0].family)
    })
  }
}

/** One screened GET. Never throws: every failure is a sentence a person can act on. */
export function safeHttpsGet(raw: string, accept: string, resolve?: Resolver): Promise<Fetched | Refused> {
  const pf = preflight(raw)
  if ('refused' in pf) return Promise.resolve(pf)
  return new Promise((done) => {
    let settled = false
    const finish = (v: Fetched | Refused) => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      done(v)
    }
    const req = https.request(
      pf.url,
      { method: 'GET', agent: false, lookup: guardedLookup(resolve) as never, headers: { accept, 'user-agent': USER_AGENT }, maxHeaderSize: 32 * 1024, timeout: SOCKET_MS },
      (res) => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          // Never followed: a redirect is where a screened public URL becomes an internal one.
          res.resume()
          return finish({ status, headers, body: '' })
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_BYTES) {
            req.destroy()
            finish({ refused: 'That link answered with more than 64 KB, which is not a payment request.' })
          } else chunks.push(c)
        })
        res.on('end', () => finish({ status, headers, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', () => finish({ refused: 'The link could not be read.' }))
      },
    )
    const overall = setTimeout(() => {
      req.destroy()
      finish({ refused: 'The link did not answer within 8 seconds.' })
    }, OVERALL_MS)
    req.on('timeout', () => {
      req.destroy()
      finish({ refused: 'The link did not answer within 8 seconds.' })
    })
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EBLOCKED') finish({ refused: 'That link resolves to a private network, so it is not read.' })
      else if (e.code === 'ENOTFOUND') finish({ refused: `${pf.url.hostname} does not resolve.` })
      else finish({ refused: 'The link could not be reached.' })
    })
    req.end()
  })
}
