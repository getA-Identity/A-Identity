/**
 * Circle Gateway batched x402 rail (Nanopayments). Import from here.
 *
 * The buyer signs an EIP-3009 authorization against Gateway's GatewayWalletBatched domain
 * and pays no gas; Gateway credits the seller and batches the on-chain settlement. Nothing
 * is recorded or served until the transfer is read back from Gateway's own transfers API.
 * Chain-generic: any registry chain that declares a `gateway` gets the rail.
 */
export * from './facilitator.js'
export * from './rail.js'
