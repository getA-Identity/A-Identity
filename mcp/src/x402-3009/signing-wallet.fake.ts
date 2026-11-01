/**
 * A signing client that never touches a network, for tests of the settlement engine. A real
 * signed send knows its hash because it hashes what it signed, so this one does too, and a test
 * reads the hash with keccak256 of the bytes it chose.
 */
import { keccak256, type Hex } from 'viem'

export function fakeSigningWallet(
  raw: Hex = '0x02',
  over: { onSend?: () => void | Promise<void>; onPrepare?: () => void | Promise<void>; nonce?: number } = {},
) {
  return {
    prepareTransactionRequest: async (req: Record<string, unknown>) => {
      await over.onPrepare?.()
      return { ...req, ...(over.nonce !== undefined ? { nonce: over.nonce } : {}) }
    },
    signTransaction: async () => raw,
    sendRawTransaction: async () => {
      await over.onSend?.()
      return keccak256(raw)
    },
  }
}
