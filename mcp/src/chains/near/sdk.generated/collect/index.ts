// GENERATED FILE: do not edit.
// Source: near/sdk/src/collect/index.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

export { collectSnapshot, CollectError, type CollectOptions } from "./snapshot.js";
export { NETWORKS, explorerAccountUrl, explorerTxUrl, archivalTxCurl, type NetworkConfig } from "./networks.js";
export {
  createReader,
  executionKind,
  headersFromEnv,
  RpcAnswerError,
  RpcUnavailableError,
  type FetchLike,
  type FetchResponseLike,
  type ReaderOptions,
  type RpcCallOptions,
  type RpcReader,
} from "./rpc.js";
export { createHttpClient, type HttpClient, type HttpClientOptions, type HttpRequest } from "./http.js";
export { argsBase64, createRecorder, type Recorder } from "./recorder.js";
export { callParams } from "./views.js";
