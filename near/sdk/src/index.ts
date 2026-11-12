// A-Identity Guard for NEAR: public SDK surface.
//
//   engine   pure verdict engine (no I/O): snapshot -> signals -> decision, digests, replay
//   collect  read-only data collection pinned to a block (JSON-RPC, indexers, registries)
//   chain    vault and registry clients on near-api-js, outcome parsing, settlement proof, keys
//   guard    verifyThenPay: check the payee, then pay, ask the owner, or record the refusal

export * from "./engine/index.ts";
export * from "./collect/index.ts";
export { keyFromSecret, KeyError, loadKey, type LoadedKey, type LoadKeyOptions } from "./chain/keys.ts";
export {
  eventsFrom,
  parseEventLine,
  parseOutcome,
  payOutcomeOf,
  proveSettlement,
  TxPendingError,
  vaultEventFor,
  waitFinal,
  type NearEvent,
  type PayOutcome,
  type PayStatus,
  type ReceiptAction,
  type ReceiptView,
  type Settlement,
  type SettlementCheck,
  type TxOutcome,
} from "./chain/outcome.ts";
export { prepare, refusedAtValidation, send, viewFunction, type Call, type ConnectorAction, type Executed, type Links, type Pending, type Prepared, type Rejected, type SendResult } from "./chain/send.ts";
export {
  AGENT_METHODS,
  checkAmount,
  MAX_TEXT_BYTES,
  ONE_YOCTO,
  toUnits,
  truncateBytes,
  VAULT_GAS_TGAS,
  VaultArgumentError,
  vaultClient,
  type AgentKeyView,
  type CallResult,
  type HeldPayment,
  type PayCallResult,
  type VaultClient,
  type VaultClientOptions,
  type VaultConfig,
} from "./chain/vault.ts";
export {
  checkVerdictInput,
  ORACLE_METHODS,
  REGISTRY_GAS_TGAS,
  REGISTRY_LIMITS,
  REPORT_DEPOSIT,
  RegistryArgumentError,
  registryClient,
  verdictInputFromDecision,
  type CheckView,
  type RegistryClient,
  type RegistryClientOptions,
  type ReportView,
  type VerdictInput,
  type VerdictView,
} from "./chain/registry.ts";
export { guardReason, routeFor, snapshotMismatch, verifyThenPay, type GuardResult, type GuardVerdict, type Route, type VerdictSource, type VerifyThenPayOptions } from "./guard.ts";
export { SDK_VERSION } from "./version.ts";
