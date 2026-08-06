import { randomBytes } from "node:crypto";
import {
  DEFAULT_BLOCK_TIME_MS,
  DEFAULT_OFFCHAIN_COMMIT_MS,
  MOCK_CONFIRMATIONS,
  type AdapterConfig,
  type OffchainEvent,
  type OnchainEvent,
  type SettlementAdapter,
} from "./types";

const BECH32M_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

interface MockTx {
  txId: string;
  toAddress: string;
  amountSats: bigint;
  seenAtHeight: number;
  observedAt: number;
  /** Highest confirmation count already reported (progress events). */
  lastReportedConfirmations: number;
  confirmedEmitted: boolean;
}

interface MockTransfer {
  transferId: string;
  toAddress: string;
  amountSats: bigint;
  /** Wall-clock instant the transfer commits; the event is appended on the first poll after. */
  commitsAt: number;
  observedAt: number;
  emitted: boolean;
}

/**
 * Cursors are monotonically increasing sequence numbers over an append-only
 * event log, one log per chain. Every observable change (on-chain: seen then
 * confirmed; off-chain: committed) is a separate event, so a caller at cursor
 * N always learns about later promotions without rescanning.
 */
interface LogEntry<E> {
  seq: number;
  event: E;
}

/**
 * In-memory stand-in for Bitcoin (on-chain) + Tachi (off-chain). Deterministic
 * enough for tests, lossy enough to be obviously not production. The mock is
 * the NETWORK, not a wallet: sends always succeed — LP solvency is the
 * gateway's lp_ledger's job, not the adapter's.
 */
export class MockSettlementAdapter implements SettlementAdapter {
  readonly mode = "mock" as const;

  #initialized = false;
  #addressCounter = 0;

  #onchainSeq = 0;
  #onchainLog: LogEntry<OnchainEvent>[] = [];
  #txs = new Map<string, MockTx>();
  #watchedOnchain = new Set<string>();

  #offchainSeq = 0;
  #offchainLog: LogEntry<OffchainEvent>[] = [];
  #pendingTransfers: MockTransfer[] = [];
  #watchedOffchain = new Set<string>();

  /** Per-address ledgers: what each address has received (confirmed/committed). */
  #onchainBalances = new Map<string, bigint>();
  #offchainBalances = new Map<string, bigint>();

  /** Blocks mined via advanceBlocks(); wall-clock blocks are added on top. */
  #manualBlocks = 0;
  readonly #genesisAt = Date.now();
  readonly #blockTimeMs: number;
  readonly #offchainCommitMs: number;

  constructor(config: Pick<AdapterConfig, "mockBlockTimeMs" | "mockOffchainCommitMs"> = {}) {
    this.#blockTimeMs = config.mockBlockTimeMs ?? DEFAULT_BLOCK_TIME_MS;
    this.#offchainCommitMs = config.mockOffchainCommitMs ?? DEFAULT_OFFCHAIN_COMMIT_MS;
  }

  async init(): Promise<void> {
    this.#initialized = true;
  }

  async close(): Promise<void> {
    this.#initialized = false;
  }

  // ---- on-chain leg ---------------------------------------------------------

  async createOnchainDepositAddress(ref: string): Promise<{ address: string }> {
    this.#assertInitialized();
    return { address: this.#mintAddress("mockbtc1q", ref) };
  }

  async pollOnchain(cursor: string | null): Promise<{ events: OnchainEvent[]; nextCursor: string }> {
    this.#assertInitialized();
    this.#promoteConfirmed();

    const from = parseCursor(cursor);
    const fresh = this.#onchainLog.filter(
      (e) => e.seq > from && this.#watchedOnchain.has(e.event.toAddress),
    );
    // Advance past everything we looked at, watched or not — events for
    // unwatched addresses are never coming back.
    const last = this.#onchainLog.length > 0
      ? this.#onchainLog[this.#onchainLog.length - 1]!.seq
      : from;
    return { events: fresh.map((e) => ({ ...e.event })), nextCursor: String(last) };
  }

  async sendOnchain(params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
  }): Promise<{ txId: string }> {
    this.#assertInitialized();
    if (params.amountSats <= 0n) throw new RangeError("send amount must be positive");
    const txId = `mocktx_${randomBytes(16).toString("hex")}`;
    this.#recordOnchainTx(txId, params.toAddress, params.amountSats);
    return { txId };
  }

  // ---- off-chain leg --------------------------------------------------------

  async createOffchainAddress(ref: string): Promise<{ address: string }> {
    this.#assertInitialized();
    return { address: this.#mintAddress("mocktachi1p", ref) };
  }

  async pollOffchain(cursor: string | null): Promise<{ events: OffchainEvent[]; nextCursor: string }> {
    this.#assertInitialized();
    this.#commitDueTransfers();

    const from = parseCursor(cursor);
    const fresh = this.#offchainLog.filter(
      (e) => e.seq > from && this.#watchedOffchain.has(e.event.toAddress),
    );
    const last = this.#offchainLog.length > 0
      ? this.#offchainLog[this.#offchainLog.length - 1]!.seq
      : from;
    return { events: fresh.map((e) => ({ ...e.event })), nextCursor: String(last) };
  }

  async sendOffchain(params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
  }): Promise<{ transferId: string }> {
    this.#assertInitialized();
    if (params.amountSats <= 0n) throw new RangeError("send amount must be positive");
    const transferId = `mockxfer_${randomBytes(16).toString("hex")}`;
    this.#queueTransfer(transferId, params.toAddress, params.amountSats);
    return { transferId };
  }

  async watchAddress(chain: "onchain" | "offchain", address: string): Promise<void> {
    (chain === "onchain" ? this.#watchedOnchain : this.#watchedOffchain).add(address);
  }

  // ---- test-only surface ----------------------------------------------------

  /**
   * TEST/DEV ONLY. A user pays `address` on-chain: the tx is `seen`
   * immediately and `confirmed` after MOCK_CONFIRMATIONS mock blocks.
   */
  simulateOnchainDeposit(address: string, amountSats: bigint): { txId: string } {
    this.#assertInitialized();
    const txId = `mocktx_${randomBytes(16).toString("hex")}`;
    this.#recordOnchainTx(txId, address, amountSats);
    return { txId };
  }

  /**
   * TEST/DEV ONLY. A user pays `address` off-chain: the transfer commits
   * ~mockOffchainCommitMs later (immediately when configured as 0).
   */
  simulateOffchainPayment(address: string, amountSats: bigint): { transferId: string } {
    this.#assertInitialized();
    const transferId = `mockxfer_${randomBytes(16).toString("hex")}`;
    this.#queueTransfer(transferId, address, amountSats);
    return { transferId };
  }

  /** TEST/DEV ONLY. Mine `n` blocks instantly. Confirmations surface on the next poll. */
  advanceBlocks(n: number): void {
    this.#manualBlocks += n;
  }

  /** Current mock chain height: wall-clock blocks plus manually mined ones. */
  blockHeight(): number {
    return this.#manualBlocks + Math.floor((Date.now() - this.#genesisAt) / this.#blockTimeMs);
  }

  /** TEST ONLY. What an address has received (confirmed on-chain / committed off-chain). */
  addressBalance(chain: "onchain" | "offchain", address: string): bigint {
    const book = chain === "onchain" ? this.#onchainBalances : this.#offchainBalances;
    return book.get(address) ?? 0n;
  }

  // ---- internals ------------------------------------------------------------

  #recordOnchainTx(txId: string, toAddress: string, amountSats: bigint): void {
    const now = Date.now();
    const tx: MockTx = {
      txId,
      toAddress,
      amountSats,
      seenAtHeight: this.blockHeight(),
      observedAt: now,
      lastReportedConfirmations: 0,
      confirmedEmitted: false,
    };
    this.#txs.set(txId, tx);
    this.#appendOnchain({
      eventId: `moe_${randomBytes(12).toString("hex")}`,
      txId,
      toAddress,
      amountSats,
      status: "seen",
      confirmations: 0,
      observedAt: now,
    });
  }

  #promoteConfirmed(): void {
    const height = this.blockHeight();
    for (const tx of this.#txs.values()) {
      if (tx.confirmedEmitted) continue;
      const confirmations = height - tx.seenAtHeight;
      if (confirmations >= MOCK_CONFIRMATIONS) {
        tx.confirmedEmitted = true;
        this.#credit(this.#onchainBalances, tx.toAddress, tx.amountSats);
        this.#appendOnchain({
          eventId: `moe_${randomBytes(12).toString("hex")}`,
          txId: tx.txId,
          toAddress: tx.toAddress,
          amountSats: tx.amountSats,
          status: "confirmed",
          confirmations,
          observedAt: Date.now(),
        });
      } else if (confirmations > tx.lastReportedConfirmations) {
        // Confirmation progress: still `seen`, but with a higher count, so a
        // live view can say "confirming (2/3)". Consumers dedupe by txId.
        tx.lastReportedConfirmations = confirmations;
        this.#appendOnchain({
          eventId: `moe_${randomBytes(12).toString("hex")}`,
          txId: tx.txId,
          toAddress: tx.toAddress,
          amountSats: tx.amountSats,
          status: "seen",
          confirmations,
          observedAt: Date.now(),
        });
      }
    }
  }

  #queueTransfer(transferId: string, toAddress: string, amountSats: bigint): void {
    const now = Date.now();
    this.#pendingTransfers.push({
      transferId,
      toAddress,
      amountSats,
      commitsAt: now + this.#offchainCommitMs,
      observedAt: now,
      emitted: false,
    });
  }

  #commitDueTransfers(): void {
    const now = Date.now();
    for (const t of this.#pendingTransfers) {
      if (t.emitted || now < t.commitsAt) continue;
      t.emitted = true;
      this.#credit(this.#offchainBalances, t.toAddress, t.amountSats);
      this.#appendOffchain({
        eventId: `mfe_${randomBytes(12).toString("hex")}`,
        transferId: t.transferId,
        toAddress: t.toAddress,
        amountSats: t.amountSats,
        status: "committed",
        observedAt: t.observedAt,
      });
    }
    this.#pendingTransfers = this.#pendingTransfers.filter((t) => !t.emitted);
  }

  #appendOnchain(event: OnchainEvent): void {
    this.#onchainSeq += 1;
    this.#onchainLog.push({ seq: this.#onchainSeq, event });
  }

  #appendOffchain(event: OffchainEvent): void {
    this.#offchainSeq += 1;
    this.#offchainLog.push({ seq: this.#offchainSeq, event });
  }

  #credit(book: Map<string, bigint>, address: string, amountSats: bigint): void {
    book.set(address, (book.get(address) ?? 0n) + amountSats);
  }

  #mintAddress(prefix: string, ref: string): string {
    this.#addressCounter += 1;
    // Not a real bech32m encoding — just something that looks the part and is
    // unique per call. `ref` is folded in so mock addresses stay traceable.
    const entropy = Array.from(randomBytes(18))
      .map((b) => BECH32M_ALPHABET[b % BECH32M_ALPHABET.length])
      .join("");
    const tag = ref.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6);
    return `${prefix}${entropy}${tag}${this.#addressCounter.toString(36)}`;
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new Error("MockSettlementAdapter.init() must be awaited before use");
    }
  }
}

function parseCursor(cursor: string | null): number {
  if (cursor === null || cursor === "") return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
