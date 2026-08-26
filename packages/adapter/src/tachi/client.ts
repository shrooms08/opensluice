/**
 * Thin wrappers over @tachibtc/tachi-sdk-ts that enforce the SDK's own trap:
 * "a resolved promise is not success" — CometBFT calls report failure inside
 * an HTTP 200 via `result.code` / `result.log`, and the Bitcoin RPC proxy
 * reports it via a non-null `error`. Booking an unsettled payment is the worst
 * bug available to this codebase, so both checks live here and nowhere else.
 */
import { TachiClient, type CometRPCResponse } from "@tachibtc/tachi-sdk-ts";

export interface BroadcastVerdict {
  code: number;
  log: string;
  /** Lowercase hex CometBFT tx hash. */
  hash: string;
}

export class TachiBroadcastError extends Error {
  readonly code: number;
  readonly log: string;
  constructor(code: number, log: string) {
    super(`tachi broadcast rejected: code=${code} log=${JSON.stringify(log)}`);
    this.name = "TachiBroadcastError";
    this.code = code;
    this.log = log;
  }
}

export function makeClient(baseUrl: string, apiKey?: string): TachiClient {
  if (!apiKey) return new TachiClient({ baseUrl });
  // The SDK has no headers option; inject X-Api-Key through a fetch wrapper.
  const fetchWithKey: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Api-Key", apiKey);
    return fetch(input, { ...init, headers });
  };
  return new TachiClient({ baseUrl, fetch: fetchWithKey });
}

/** Read the CometBFT verdict out of a broadcast response; throw unless code === 0. */
export function assertBroadcastOk(res: CometRPCResponse): BroadcastVerdict {
  const r = (res?.result ?? {}) as { code?: number; log?: string; hash?: string };
  const code = typeof r.code === "number" ? r.code : -1;
  const log = typeof r.log === "string" ? r.log : "";
  const hash = typeof r.hash === "string" ? r.hash.toLowerCase() : "";
  if (code !== 0 || !hash) throw new TachiBroadcastError(code, log || "missing hash");
  return { code, log, hash };
}
