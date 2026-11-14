/**
 * x402 `exact` on near:testnet: our own relayer, @x402/near's verification in process, and a
 * payment counted only once the token's own ft_transfer receipt proves it. Import from here.
 */
export * from './rail.js'
export * from './proof.js'
export { relayerFromEnv, NEAR_X402_RELAYER_ACCOUNT_ENV, NEAR_X402_RELAYER_KEY_ENV, type NearRelayer, type NearTxResult } from './relay.js'
