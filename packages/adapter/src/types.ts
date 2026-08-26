/** A deposit observed on the on-chain leg. Emitted `seen` first, `confirmed` later. */
export interface OnchainEvent {
  /** Unique per emission — the `seen` and `confirmed` events of one tx have different ids. */
  eventId: string;
  txId: string;
  toAddress: string;
  amountSats: bigint;
  status: "seen" | "confirmed";
  confirmations: number;
  /** unix ms */
  observedAt: number;
}

/** A transfer observed on the off-chain (Tachi) leg. Off-chain is instant: one `committed` event. */
export interface OffchainEvent {
  eventId: string;
  transferId: string;
  toAddress: string;
  amountSats: bigint;
  status: "committed";
  /** unix ms */
  observedAt: number;
}

/**
 * What an adapter can actually settle. The point of this object is that no
 * other layer gets to guess: the gateway surfaces it on /healthz, the UI banner
 * renders from it, and the docs quote it. An adapter that simulates one leg has
 * to say so here, in one place, rather than being described accurately in a
 * README and inaccurately in a banner.
 */
export interface AdapterCapabilities {
  /** True when the on-chain (Bitcoin L1) leg moves real value. */
  onchainReal: boolean;
  /** True when the off-chain (Tachi ledger) leg moves real value. */
  offchainReal: boolean;
  /** Short human label for the mode, e.g. "mock" or "tachi-regtest-1". */
  label: string;
  /** Chain id reported by the daemon once connected; null in mock mode. */
  chainId: string | null;
}

/**
 * Both legs of a swap, one contract. Poll + cursor on each chain; addresses
 * must be watched before their events are reported. Two implementations ship:
 * the mock (the test/demo/CI adapter, and the only fully-simulated one) and the
 * real Tachi adapter (real off-chain settlement, simulated L1 — see its
 * capabilities and INTEGRATION.md).
 */
export interface SettlementAdapter {
  /** Static description of what this adapter really settles. */
  readonly capabilities: AdapterCapabilities;
  init(): Promise<void>;
  // on-chain leg
  createOnchainDepositAddress(ref: string): Promise<{ address: string }>;
  pollOnchain(cursor: string | null): Promise<{ events: OnchainEvent[]; nextCursor: string }>;
  sendOnchain(params: { toAddress: string; amountSats: bigint; ref: string }): Promise<{ txId: string }>;
  // off-chain leg (instant)
  createOffchainAddress(ref: string): Promise<{ address: string }>;
  pollOffchain(cursor: string | null): Promise<{ events: OffchainEvent[]; nextCursor: string }>;
  sendOffchain(params: { toAddress: string; amountSats: bigint; ref: string }): Promise<{ transferId: string }>;
  watchAddress(chain: "onchain" | "offchain", address: string): Promise<void>;
  /** Release any timers/sockets held by the adapter. */
  close?(): Promise<void>;
}

export type AdapterMode = "mock" | "tachi";

export interface TachiAdapterConfig {
  rpcUrl: string;
  network: "regtest" | "signet";
  mnemonic: string;
  statePath: string;
  apiKey?: string;
  /** Opt in to the WebSocket watch() supplement; polling stays authoritative. */
  useWatch?: boolean;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface AdapterConfig {
  mode: AdapterMode;
  /**
   * Wall-clock length of one mock block, ms. Tests pass a huge value and
   * drive the chain with advanceBlocks() instead, so nothing races.
   */
  mockBlockTimeMs?: number;
  /** How long a mock off-chain transfer takes to commit, ms. */
  mockOffchainCommitMs?: number;
  /** Required when mode === "tachi". */
  tachi?: TachiAdapterConfig;
}

export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

/** Blocks a deposit needs before the mock reports it `confirmed`. */
export const MOCK_CONFIRMATIONS = 3;

export const DEFAULT_BLOCK_TIME_MS = 2_000;
export const DEFAULT_OFFCHAIN_COMMIT_MS = 1_000;

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
