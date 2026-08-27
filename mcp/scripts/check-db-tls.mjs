#!/usr/bin/env node
/**
 * Does our database's certificate actually verify? Run this BEFORE deploying the change
 * that starts checking it.
 *
 * storage.ts used to connect with `rejectUnauthorized: false`, which keeps the encryption
 * and throws away the identity check: the connection is encrypted to whoever answered.
 * Verification is now the default, and if the certificate does not chain to a root Node
 * trusts, the backend loses its database on the next boot. That is worth one command up
 * front rather than a surprise in production.
 *
 * This makes a TLS handshake to the host in DATABASE_URL and reports what it sees. It never
 * prints the URL, the user, or the password, and it sends no Postgres traffic beyond the
 * SSLRequest byte the server needs before it will negotiate TLS.
 *
 *   DATABASE_URL='postgres://...' node scripts/check-db-tls.mjs
 *
 * Exit 0 means verification will work and you can deploy. Exit 1 means it will not, and the
 * fix is PGSSLROOTCERT pointing at your CA. PGSSL_ALLOW_UNVERIFIED=true exists as a last
 * resort and logs a warning every boot, for a reason.
 */
import net from 'node:net'
import tls from 'node:tls'

const url = process.env.DATABASE_URL?.trim()
if (!url) {
  console.error('error: DATABASE_URL is not set. Export it for this one command; nothing is written or logged.')
  process.exit(1)
}

let host, port
try {
  const u = new URL(url)
  host = u.hostname
  port = Number(u.port || 5432)
} catch {
  console.error('error: DATABASE_URL is not a URL this script can parse.')
  process.exit(1)
}
if (!host) {
  console.error('error: DATABASE_URL names no host.')
  process.exit(1)
}

console.log(`Host:   ${host}:${port}`)

// Postgres does not speak TLS on connect. The client sends an 8-byte SSLRequest and the
// server answers a single 'S' before either side starts a handshake.
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])

const socket = net.connect({ host, port }, () => socket.write(SSL_REQUEST))
socket.setTimeout(15000)
socket.on('timeout', () => {
  console.error('error: the host did not answer in 15s. Check the host, the port and any IP allowlist.')
  socket.destroy()
  process.exit(1)
})
socket.on('error', (e) => {
  console.error(`error: could not reach the host: ${e.message}`)
  process.exit(1)
})

socket.once('data', (buf) => {
  if (buf.toString('latin1', 0, 1) !== 'S') {
    console.error('error: the server refused TLS entirely (answered ' + JSON.stringify(buf.toString('latin1', 0, 1)) + ').')
    console.error('       A database reachable only in plaintext is a separate problem from certificate checking.')
    process.exit(1)
  }

  // This is the check that matters: Node's default CA bundle, servername set so the
  // hostname is verified too, which is the half `rejectUnauthorized: false` also discarded.
  const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => {
    const cert = secure.getPeerCertificate()
    console.log(`TLS:    ${secure.getProtocol()}`)
    console.log(`Subject:${cert.subject?.CN ? ` CN=${cert.subject.CN}` : ' (none)'}`)
    console.log(`Issuer: ${cert.issuer?.O ?? ''} ${cert.issuer?.CN ?? ''}`.trim())
    console.log(`Valid:  ${cert.valid_from} to ${cert.valid_to}`)
    console.log('\nVERIFIED. The certificate chains to a root Node trusts and matches the hostname.')
    console.log('storage.ts can verify by default; deploy without setting PGSSL_ALLOW_UNVERIFIED.')
    secure.end()
    process.exit(0)
  })
  secure.on('error', (e) => {
    console.error(`\nNOT VERIFIED: ${e.message}`)
    console.error('\nDo NOT deploy with verification on until this is resolved. Either:')
    console.error('  - point PGSSLROOTCERT at the CA that issued this certificate (the right fix), or')
    console.error('  - set PGSSL_ALLOW_UNVERIFIED=true, which keeps the old behaviour and warns every boot.')
    process.exit(1)
  })
})
