import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, type ServerData } from '../server.js'
import { MCP_TOOL_NAMES, toolInputSchema, verifyThenPayInput } from '../mcp-tool-schemas.js'
import { getChainById } from '../chains/index.js'

/**
 * verify_then_pay over MCP: registered only when the HTTP entry injects its hook (the stdio
 * entry has no Gateway rail to sell through), described from the registry, and passing its
 * arguments, the payment included, to the hook untouched.
 */
const arc = getChainById('arc-mainnet')!

async function connect(data: ServerData): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = buildServer(data)
  await server.connect(serverSide)
  const client = new Client({ name: 'vtp-test', version: '0.0.0' })
  await client.connect(clientSide)
  return client
}

test('the two tools exist only when the hook is injected, and hand their arguments to it unchanged', async () => {
  const bare = await connect({})
  const bareNames = (await bare.listTools()).tools.map((t) => t.name)
  assert.ok(!bareNames.includes('verify_then_pay') && !bareNames.includes('verify_then_pay_receipt'))
  await bare.close()

  const runs: unknown[] = []
  const receipts: unknown[] = []
  const client = await connect({
    verifyThenPay: {
      run: async (input) => {
        runs.push(input)
        return { tool: 'verify_then_pay', stage: 'payment_required', executed: false }
      },
      receipt: async (input) => {
        receipts.push(input)
        return { tool: 'verify_then_pay_receipt', verified: false }
      },
    },
  })
  const tools = (await client.listTools()).tools
  const vtp = tools.find((t) => t.name === 'verify_then_pay')
  const rec = tools.find((t) => t.name === 'verify_then_pay_receipt')
  assert.ok(vtp && rec)
  assert.deepEqual(Object.keys((vtp.inputSchema as { properties: object }).properties).sort(), Object.keys(verifyThenPayInput).sort())
  // Described from the registry, never typed out.
  assert.ok(vtp.description?.includes(arc.name) && vtp.description.includes(arc.caip2))
  assert.match(vtp.description ?? '', /executed:false/)

  const args = { vault: '0x' + 'a1'.repeat(20), payee: '0x' + 'd4'.repeat(20), amount: '250000', payment: 'eyJ4NDAyVmVyc2lvbiI6Mn0=', payOnWarn: true }
  const out = (await client.callTool({ name: 'verify_then_pay', arguments: args })) as { content: { text: string }[] }
  assert.deepEqual(runs, [args])
  assert.equal(JSON.parse(out.content[0].text).executed, false)

  await client.callTool({ name: 'verify_then_pay_receipt', arguments: { flowId: '0x' + 'ab'.repeat(32), txHash: '0x' + 'c1'.repeat(32) } })
  assert.deepEqual(receipts, [{ flowId: '0x' + 'ab'.repeat(32), txHash: '0x' + 'c1'.repeat(32) }])
  await client.close()
})

test('the published input schemas take a real call, refuse an unknown argument, and name the registry USDC', () => {
  assert.ok(MCP_TOOL_NAMES.includes('verify_then_pay') && MCP_TOOL_NAMES.includes('verify_then_pay_receipt'))
  const schema = toolInputSchema('verify_then_pay')!
  assert.equal(schema.safeParse({ vault: '0x' + 'a1'.repeat(20), payee: '0x' + 'd4'.repeat(20), amount: '250000' }).success, true)
  assert.equal(schema.safeParse({ vault: '0x' + 'a1'.repeat(20), payee: '0x' + 'd4'.repeat(20), amount: '250000', memo: true }).success, false, 'no Memo wrapper in this version')
  assert.equal(schema.safeParse({ vault: '0x' + 'a1'.repeat(20), payee: '0x' + 'd4'.repeat(20), amount: '250000', payOnWarn: 'yes' }).success, false)
  assert.equal(toolInputSchema('verify_then_pay_receipt')!.safeParse({ flowId: '0x' + 'ab'.repeat(32), txHash: '0x' + 'c1'.repeat(32) }).success, true)
  assert.ok(verifyThenPayInput.vault.description?.includes(arc.contracts.usdc as string))
  assert.ok(verifyThenPayInput.payeeAgentId.description?.includes(`${arc.caip2}:8004/<n>`))
})
