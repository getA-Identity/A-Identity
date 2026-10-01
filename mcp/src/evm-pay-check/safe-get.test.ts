import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LookupAddress } from 'node:dns'
import { guardedLookup, isBlockedIp, preflight, safeHttpsGet } from './safe-get.js'

type Answer = { err?: NodeJS.ErrnoException; addresses?: LookupAddress[] }
const resolver = (answer: Answer) => (_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
  cb(answer.err ?? null, answer.addresses ?? [])

function lookupWith(answer: Answer, options: unknown): Promise<{ err: NodeJS.ErrnoException | null; address?: unknown; family?: unknown }> {
  return new Promise((done) => {
    guardedLookup(resolver(answer))('seller.example', options, (err: NodeJS.ErrnoException | null, address?: unknown, family?: unknown) => done({ err, address, family }))
  })
}

test('isBlockedIp: every private, loopback, link-local, CGNAT, documentation and mapped range', () => {
  for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '198.18.0.1', '203.0.113.9', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:93.184.216.34', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isBlockedIp(ip), true, ip)
  }
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700::1111']) assert.equal(isBlockedIp(ip), false, ip)
})

test('preflight: https on 443 with a domain name, nothing else', () => {
  assert.ok('url' in preflight('https://seller.example/api/tool'))
  assert.ok('url' in preflight('https://seller.example:443/api/tool'))
  for (const bad of ['http://seller.example/', 'https://seller.example:8443/', 'https://user:pw@seller.example/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://box.internal/', 'https://printer.local/', 'https://intranet/', 'not a url']) {
    assert.ok('refused' in preflight(bad), bad)
  }
})

test('guardedLookup: a name that resolves to ANY private address is refused, not just the first', async () => {
  const r = await lookupWith({ addresses: [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] }, { all: true })
  assert.equal(r.err?.code, 'EBLOCKED')
})

test('guardedLookup: public addresses are handed to the socket exactly as vetted', async () => {
  const one = await lookupWith({ addresses: [{ address: '93.184.216.34', family: 4 }] }, {})
  assert.equal(one.err, null)
  assert.equal(one.address, '93.184.216.34')
  assert.equal(one.family, 4)
  const all = await lookupWith({ addresses: [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }] }, { all: true })
  assert.deepEqual(all.address, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700::1111', family: 6 },
  ])
})

test('guardedLookup: a name that does not resolve is an error, never an empty success', async () => {
  const r = await lookupWith({ addresses: [] }, {})
  assert.equal(r.err?.code, 'ENOTFOUND')
})

test('safeHttpsGet: a rebinding answer stops the request inside the connection, before any byte is sent', async () => {
  // A real https.request with a resolver that answers a private address: the refusal has to
  // come from the connect-time lookup, because the URL itself passes every screen.
  const out = await safeHttpsGet('https://rebind.example/pay', 'application/json', resolver({ addresses: [{ address: '169.254.169.254', family: 4 }] }))
  assert.deepEqual(out, { refused: 'That link resolves to a private network, so it is not read.' })
})

test('safeHttpsGet: a refused URL never reaches the resolver', async () => {
  let asked = false
  const out = await safeHttpsGet('http://seller.example/', 'application/json', (_h, _o, cb) => {
    asked = true
    cb(null, [{ address: '93.184.216.34', family: 4 }])
  })
  assert.ok('refused' in out)
  assert.equal(asked, false)
})
