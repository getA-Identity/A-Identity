/**
 * verify-then-pay on Arc Mainnet, the hosted half. Import from here.
 *
 * Buy A-Identity's risk_check through Circle Gateway, check the answer, and hand back the
 * exact vault call to send, or the owner hand-off, or nothing. The server never signs: every
 * answer is executed: false, and a flow becomes executed only when the server reads the
 * payment's receipt from every RPC itself. See core.ts for the order and receipt.ts for the
 * proof.
 */
export * from './context.js'
export * from './reads.js'
export * from './verdict.js'
export * from './prepare.js'
export * from './core.js'
export * from './receipt.js'
export * from './season.js'
