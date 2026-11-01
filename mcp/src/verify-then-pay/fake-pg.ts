/**
 * A Postgres-shaped pool for the vtp_flows statements in storage.ts, for tests only. It holds
 * rows and applies what the database would: the primary key on flow_id, the WHERE of each
 * statement (an UPDATE that matches no row returns no row), and the unique index on the payment's
 * transaction hash (an UPDATE that would duplicate one throws error 23505).
 *
 * A statement it does not recognize throws, so rewording a query in storage.ts fails the tests
 * instead of passing against a fake that no longer means the same thing. Rows go through JSON
 * both ways, as jsonb does, so nothing leans on sharing an object with the store.
 */
import type { VtpFlowRecord } from '../storage.js'

type Row = VtpFlowRecord
type Query = { text: string; params: unknown[] }

const copy = (r: Row): Row => JSON.parse(JSON.stringify(r)) as Row

export function fakeVtpPool() {
  const rows = new Map<string, Row>()
  const sql: Query[] = []

  const txOf = (r: Row) => r.payment?.txHash

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    sql.push({ text, params })
    if (text.startsWith('CREATE')) return { rows: [] }

    if (text === 'INSERT INTO vtp_flows (flow_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (flow_id) DO NOTHING RETURNING flow_id') {
      const id = params[0] as string
      if (rows.has(id)) return { rows: [] }
      rows.set(id, JSON.parse(params[1] as string) as Row)
      return { rows: [{ flow_id: id }] }
    }

    if (text === "UPDATE vtp_flows SET data = data || $2::jsonb WHERE flow_id = $1 AND data->>'outcome' = ANY($3::text[]) RETURNING data") {
      const id = params[0] as string
      const cur = rows.get(id)
      if (!cur || !(params[2] as string[]).includes(cur.outcome)) return { rows: [] }
      const next = { ...cur, ...(JSON.parse(params[1] as string) as Partial<Row>) }
      const tx = txOf(next)
      if (tx !== undefined && [...rows].some(([other, r]) => other !== id && txOf(r) === tx)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "vtp_flows_payment_tx"'), { code: '23505' })
      }
      rows.set(id, next)
      return { rows: [{ data: copy(next) }] }
    }

    if (text === 'SELECT data FROM vtp_flows WHERE flow_id = $1') {
      const r = rows.get(params[0] as string)
      return { rows: r ? [{ data: copy(r) }] : [] }
    }

    if (text === "SELECT flow_id FROM vtp_flows WHERE data->'payment'->>'txHash' = $1 LIMIT 1") {
      const hit = [...rows].find(([, r]) => txOf(r) === params[0])
      return { rows: hit ? [{ flow_id: hit[0] }] : [] }
    }

    const ordered = () => [...rows.values()].sort((a, b) => (a.createdAt === b.createdAt ? (a.flowId < b.flowId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))

    if (text === "SELECT data FROM vtp_flows WHERE data->>'vault' = $1 AND data->>'payee' = $2 AND data->>'amount' = $3 AND data->>'outcome' = ANY($4::text[]) ORDER BY data->>'createdAt' ASC, flow_id ASC") {
      const [vault, payee, amount, outcomes] = params as [string, string, string, string[]]
      return { rows: ordered().filter((r) => r.vault === vault && r.payee === payee && r.amount === amount && outcomes.includes(r.outcome)).map((r) => ({ data: copy(r) })) }
    }

    if (text === "SELECT data FROM vtp_flows ORDER BY data->>'createdAt' ASC, flow_id ASC") {
      return { rows: ordered().map((r) => ({ data: copy(r) })) }
    }

    throw new Error(`fake-pg does not know this statement: ${text}`)
  }

  return { query, rows, sql }
}
