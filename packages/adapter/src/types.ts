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
 * Both legs of a swap, one contract. Poll + cursor on each chain; addresses
 * must be watched before their events are reported. Modeled on OpenTill's
 * TachiAdapter: the mock is the shipping mode, "tachi" is a documented stub.
 */
export interface SettlementAdapter {
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

export interface AdapterConfig {
  mode: AdapterMode;
  /**
   * Wall-clock length of one mock block, ms. Tests pass a huge value and
   * drive the chain with advanceBlocks() instead, so nothing races.
   */
  mockBlockTimeMs?: number;
  /** How long a mock off-chain transfer takes to commit, ms. */
  mockOffchainCommitMs?: number;
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
