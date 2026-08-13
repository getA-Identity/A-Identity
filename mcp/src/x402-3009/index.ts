/**
 * Self-facilitated EIP-3009 x402 rail. Import from here.
 *
 * The buyer signs a transferWithAuthorization and pays no gas; we broadcast it and only
 * call it settled once a receipt carries a matching Transfer log. Chain-generic: any
 * registry chain that declares an EIP-3009 settlement token gets the rail, and the
 * facilitator endpoints, for free.
 */
export * from './domain.js'
export * from './engine.js'
export * from './rail.js'
export * as facilitator from './facilitator.js'
