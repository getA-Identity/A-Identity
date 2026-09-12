import { test } from 'node:test'
import assert from 'node:assert/strict'
import algosdk from 'algosdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildTrustMcpServer, configFromEnv, type TrustMcpConfig } from './server.js'

const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
const buyer = algosdk.generateAccount()
const feePayer = algosdk.generateAccount()
const payTo = algosdk.generateAccount().addr.toString()

const challenge = (amount: string) => ({
  x402Version: 2,
  resource: { url: 'https://oracle.test/api/x402/algorand/tools/risk_check', description: 'risk', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: MAINNET, amount, asset: '31566704', payTo, extra: { decimals: 6 } }],
})

/** An oracle that answers 402 until paid, plus the facilitator and algod endpoints the payer reads. */
function world(amount: string) {
  const hits: string[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    hits.push(url)
    if (url.endsWith('/supported')) {
      return new Response(JSON.stringify({ kinds: [{ network: MAINNET, extra: { feePayer: feePayer.addr.toString() } }] }))
    }
    if (url.endsWith('/v2/transactions/params')) {
      return new Response(JSON.stringify({ 'last-round': 900, 'genesis-id': 'mainnet-v1.0', 'genesis-hash': MAINNET.slice('algorand:'.length), 'min-fee': 1000 }))
    }
    const paid = (init?.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE']
    if (!paid) return new Response(JSON.stringify(challenge(amount)), { status: 402 })
    return new Response(JSON.stringify({ tool: 'risk_check', agentId: '#5', decision: 'DENY', risk: 'high', reasons: ['revoked'] }))
  }
  return { fetch, hits }
}

async function connect(config: TrustMcpConfig) {
  const server = buildTrustMcpServer({ baseUrl: 'https://oracle.test', ...config })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return client
}

const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text)

test('the server lists the free quote and the five paid trust tools', async () => {
  const client = await connect({ fetch: world('50000').fetch })
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), ['agent_batch_audit', 'agent_passport', 'price_quote', 'reputation_score', 'risk_check', 'verify_agent'])
})

test('price_quote reads the live price from the 402 without paying', async () => {
  const w = world('50000')
  const client = await connect({ fetch: w.fetch })
  const r = await client.callTool({ name: 'price_quote', arguments: { tool: 'risk_check' } })
  const body = text(r)
  assert.equal(body.priceUsd, 0.05)
  assert.equal(body.withinCap, true)
  assert.equal(body.payerConfigured, false)
  assert.ok(!w.hits.some((u) => u.endsWith('/supported')), 'a quote never touches the payment path')
})

test('without a mnemonic a paid tool returns its price and says how to enable payment', async () => {
  const client = await connect({ fetch: world('50000').fetch })
  const r = await client.callTool({ name: 'risk_check', arguments: { agentId: '#5' } })
  assert.equal(r.isError, true)
  const body = text(r)
  assert.match(body.error, /A_IDENTITY_ALGORAND_MNEMONIC/)
  assert.equal(body.price.usd, 0.05)
})

test('a price above the cap is refused before signing, and a price within it is paid and answered', async () => {
  const mnemonic = algosdk.secretKeyToMnemonic(buyer.sk)
  const capped = world('50000')
  const refusedClient = await connect({ fetch: capped.fetch, mnemonic, maxUsdPerCall: 0.01 })
  const refused = await refusedClient.callTool({ name: 'risk_check', arguments: { agentId: '#5' } })
  assert.equal(refused.isError, true)
  assert.match(text(refused).error, /above this server's per-call cap/)
  assert.ok(!capped.hits.some((u) => u.endsWith('/supported')), 'nothing was prepared for signing')

  const open = world('50000')
  const payingClient = await connect({ fetch: open.fetch, mnemonic, maxUsdPerCall: 0.1 })
  const answered = await payingClient.callTool({ name: 'risk_check', arguments: { agentId: '#5', amountUsd: 40 } })
  assert.equal(answered.isError, undefined)
  assert.equal(text(answered).decision, 'DENY')
})

test('configuration comes from the environment, and a nonsense cap falls back to the default', () => {
  const c = configFromEnv({ A_IDENTITY_ALGORAND_MNEMONIC: ' words ', A_IDENTITY_MAX_USD_PER_CALL: 'lots' })
  assert.equal(c.mnemonic, 'words')
  assert.equal(c.maxUsdPerCall, undefined)
  assert.equal(configFromEnv({ A_IDENTITY_MAX_USD_PER_CALL: '2' }).maxUsdPerCall, 2)
})
