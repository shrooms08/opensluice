/**
 * TachiRealSettlementAdapter — real off-chain settlement against a Tachi
 * daemon, written against the live responses in docs/tachi-smoke-output.md.
 *
 * WHAT IS REAL (proven on tachi-regtest-1, see the smoke record):
 *  - off-chain addresses: a fresh BIP-84 key per ref, encoded P2TR;
 *  - off-chain detection: `getAddressVtxos` polling over watched addresses,
 *    reported as `committed` only once the ledger has committed them;
 *  - off-chain sends: a plain key→key ledger TRANSFER, broadcast with
 *    `broadcastTxSync`, accepted ONLY when `result.code === 0` AND the tx is
 *    seen committed in a block;
 *  - LP funding: the same transfer primitive, operator float → LP account.
 *
 * WHAT IS SIMULATED (the honest boundary — quoted in INTEGRATION.md):
 *  - every Bitcoin L1 leg. Tachi's team states that a vault is the only vessel
 *    for L1 entry/exit and that on-the-fly exit from Tachi to L1 has no
 *    cryptographic support yet. So `createOnchainDepositAddress`, `pollOnchain`
 *    and `sendOnchain` delegate to an embedded MockSettlementAdapter and say so
 *    on every call. `capabilities.onchainReal` is false, and that flag — not
 *    hardcoded copy — is what the gateway, the UI banner and the docs read.
 *
 * The consequence for swap directions:
 *  - swap_out: the user's payment to the LP is a REAL off-chain transfer; the
 *    LP's L1 payout to the user is simulated.
 *  - swap_in: the user's L1 deposit is simulated; the LP's payout to the user
 *    is a REAL off-chain transfer.
 * Either way the leg that moves value inside Tachi is real.
 */
import { getAccountNonce, waitForTachiTxCommit } from "@tachibtc/taurus-vault-core";
import type { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { MockSettlementAdapter } from "./mock";
import { assertBroadcastOk, makeClient, TachiBroadcastError } from "./tachi/client";
import { TachiKeyring, type DerivedKey } from "./tachi/keys";
import { StateStore } from "./tachi/state";
import { buildSignedTransferHex, vtxoIdFor } from "./tachi/tx";
import {
  InsufficientFundsError,
  NotImplementedError,
  type AdapterCapabilities,
  type OffchainEvent,
  type OnchainEvent,
  type SettlementAdapter,
  type TachiAdapterConfig,
} from "./types";

export { TachiBroadcastError } from "./tachi/client";
export { TachiKeyring } from "./tachi/keys";
export { buildSignedTransferHex, vtxoIdFor } from "./tachi/tx";
export type { DerivedKey } from "./tachi/keys";

/** Injectable seams so unit tests can run without a daemon. */
export interface TachiRealAdapterDeps {
  client?: TachiClient;
  nonce?: (xOnly: Buffer) => Promise<bigint>;
  waitCommit?: (hash: string) => Promise<{ committed: boolean; code: number; log: string }>;
  now?: () => number;
  /** The mock instance backing the simulated L1 legs (tests inject a frozen one). */
  l1?: MockSettlementAdapter;
}

const COMMIT_TIMEOUT_MS = 90_000;
const OPERATOR_REF = "operator";

export class TachiRealSettlementAdapter implements SettlementAdapter {
  readonly mode = "tachi" as const;

  readonly #cfg: TachiAdapterConfig;
  readonly #client: TachiClient;
  readonly #nonce: (xOnly: Buffer) => Promise<bigint>;
  readonly #waitCommit: (hash: string) => Promise<{ committed: boolean; code: number; log: string }>;
  readonly #now: () => number;
  readonly #log: (msg: string, meta?: Record<string, unknown>) => void;
  /** Simulated Bitcoin L1. Real value never touches it. */
  readonly #l1: MockSettlementAdapter;

  #keyring: TachiKeyring | null = null;
  #state: StateStore | null = null;
  #chainId: string | null = null;

  constructor(cfg: TachiAdapterConfig, deps: TachiRealAdapterDeps = {}) {
    if (!cfg?.mnemonic) throw new Error("TachiRealSettlementAdapter: mnemonic is required (OPENSLUICE_TACHI_MNEMONIC)");
    if (!cfg.rpcUrl) throw new Error("TachiRealSettlementAdapter: rpcUrl is required (OPENSLUICE_TACHI_RPC_URL)");
    this.#cfg = cfg;
    this.#client = deps.client ?? makeClient(cfg.rpcUrl, cfg.apiKey);
    this.#nonce = deps.nonce ?? ((xOnly) => getAccountNonce(xOnly, { baseUrl: cfg.rpcUrl }));
    this.#waitCommit =
      deps.waitCommit ??
      (async (hash) => {
        const st = await waitForTachiTxCommit(hash, { baseUrl: cfg.rpcUrl, overallTimeoutMs: COMMIT_TIMEOUT_MS });
        return { committed: st.committed, code: st.code, log: st.log };
      });
    this.#now = deps.now ?? (() => Date.now());
    this.#log = cfg.log ?? (() => {});
    this.#l1 = deps.l1 ?? new MockSettlementAdapter({});
  }

  get capabilities(): AdapterCapabilities {
    return {
      onchainReal: false,
      offchainReal: true,
      label: this.#chainId ?? `tachi-${this.#cfg.network}`,
      chainId: this.#chainId,
    };
  }

  // ---- lifecycle ------------------------------------------------------------

  async init(): Promise<void> {
    this.#keyring = await TachiKeyring.fromMnemonic(this.#cfg.mnemonic, this.#cfg.network);
    this.#state = new StateStore(this.#cfg.statePath, this.#cfg.network);
    await this.#l1.init();

    // The operator float (receive chain, index 0) is the coordinator's own
    // off-chain balance: it funds LP accounts and backstops payouts.
    const operator = this.#keyring.derive(0, false, OPERATOR_REF);
    if (!this.#state.findByRef(OPERATOR_REF)) {
      this.#state.update((s) => s.keys.unshift(operator));
    }

    const health = await this.#client.getHealth();
    const status = await this.#client.getStatus();
    const chainId = String((status as any)?.result?.node_info?.network ?? "");
    const height = Number((status as any)?.result?.sync_info?.latest_block_height ?? NaN);
    const catchingUp = Boolean((status as any)?.result?.sync_info?.catching_up);
    if (!chainId.startsWith(`tachi-${this.#cfg.network}`)) {
      throw new Error(
        `network=${this.#cfg.network} but the daemon at ${this.#cfg.rpcUrl} reports chain "${chainId}" — refusing to boot`,
      );
    }
    this.#chainId = chainId;

    this.#log("tachi: connected — OFF-CHAIN LEGS ARE REAL, L1 LEGS ARE SIMULATED", {
      rpcUrl: this.#cfg.rpcUrl,
      chainId,
      height,
      catchingUp,
      validators: health.validators,
      operatorAddress: operator.address,
      keys: this.#state.state.keys.length,
      watched: this.#state.state.watched.length,
      statePath: this.#cfg.statePath,
      real: "off-chain: addresses, detection, transfers (Tachi ledger)",
      simulated: "on-chain: deposit addresses, confirmations, payouts (Bitcoin L1)",
    });
  }

  async close(): Promise<void> {
    await this.#l1.close?.();
  }

  // ---- on-chain leg: SIMULATED, and it says so every time --------------------

  async createOnchainDepositAddress(ref: string): Promise<{ address: string }> {
    const out = await this.#l1.createOnchainDepositAddress(ref);
    this.#log("tachi: SIMULATED L1 deposit address (no real Bitcoin address exists)", { ref, address: out.address });
    return out;
  }

  async pollOnchain(cursor: string | null): Promise<{ events: OnchainEvent[]; nextCursor: string }> {
    const out = await this.#l1.pollOnchain(cursor);
    if (out.events.length > 0) {
      this.#log("tachi: SIMULATED L1 events", { count: out.events.length });
    }
    return out;
  }

  async sendOnchain(params: { toAddress: string; amountSats: bigint; ref: string }): Promise<{ txId: string }> {
    const out = await this.#l1.sendOnchain(params);
    this.#log("tachi: SIMULATED L1 payout — no Bitcoin moved", {
      ref: params.ref,
      toAddress: params.toAddress,
      amountSats: params.amountSats.toString(),
      simulatedTxId: out.txId,
    });
    return out;
  }

  // ---- off-chain leg: REAL ---------------------------------------------------

  /**
   * One key per ref, memoised: asking twice for the same swap leg's address
   * must return the same address, or a retried accept would orphan a payment.
   */
  async createOffchainAddress(ref: string): Promise<{ address: string }> {
    const { keyring, state } = this.#ready();
    const existing = state.findByRef(ref);
    if (existing) return { address: existing.address };

    const index = state.state.nextIndex;
    const key = keyring.derive(index, true, ref);
    state.update((s) => {
      s.nextIndex = index + 1;
      s.keys.push(key);
    });
    this.#log("tachi: real off-chain address", { ref, address: key.address, path: key.path });
    return { address: key.address };
  }

  async watchAddress(chain: "onchain" | "offchain", address: string): Promise<void> {
    if (chain === "onchain") {
      await this.#l1.watchAddress(chain, address);
      return;
    }
    const { state } = this.#ready();
    if (!state.findByAddress(address)) {
      throw new Error(`watchAddress: ${address} is not one of our off-chain keys`);
    }
    state.update((s) => {
      if (!s.watched.includes(address)) s.watched.push(address);
    });
  }

  /**
   * Cursor = a ledger-height watermark. A VTXO is reported exactly once, when
   * its commit height first exceeds the cursor.
   *
   * Deliberately NOT reported: mempool entries. OpenSluice's off-chain leg has
   * one terminal status (`committed`) which books the LP's ledger rows, so
   * emitting a pending credit would book money that can still be dropped —
   * the worst bug available here. The watch() stream shows those as
   * `state: "pending"` and the smoke record has them; they are informational.
   *
   * The next cursor is the height read at the START of the tick minus one, so a
   * block committing mid-tick is re-scanned rather than skipped.
   */
  async pollOffchain(cursor: string | null): Promise<{ events: OffchainEvent[]; nextCursor: string }> {
    const { state } = this.#ready();
    const from = parseCursor(cursor);
    const status = await this.#client.getStatus();
    const h0 = Number((status as any)?.result?.sync_info?.latest_block_height ?? NaN);
    const now = this.#now();
    const events: OffchainEvent[] = [];

    for (const address of state.state.watched) {
      const key = state.findByAddress(address);
      if (!key) continue;
      const res = await this.#client.getAddressVtxos(address, false);
      for (const v of res.vtxos) {
        if (v.height <= from) continue;
        if (v.owner.toLowerCase() !== key.xOnlyHex) continue;
        events.push({
          // Stable across restarts: the VTXO id IS the payment identity.
          eventId: `tachi:committed:${v.id}`,
          transferId: v.id,
          toAddress: address,
          amountSats: BigInt(v.amount),
          status: "committed",
          observedAt: now,
        });
      }
    }

    const nextCursor = Number.isFinite(h0) ? Math.max(from, h0 - 1) : from;
    if (events.length > 0) {
      this.#log("tachi: REAL off-chain credits detected", { count: events.length, from, to: nextCursor });
    }
    return { events, nextCursor: String(nextCursor) };
  }

  /**
   * A real ledger transfer. Returns only after the daemon reports code 0 AND
   * the transaction is committed in a block — a resolved promise is not success.
   */
  async sendOffchain(params: { toAddress: string; amountSats: bigint; ref: string }): Promise<{ transferId: string }> {
    const { hash } = await this.#transfer({ ...params, label: "payout" });
    return { transferId: hash };
  }

  /**
   * Move real off-chain value from the operator float to an LP's account.
   * This is the piece OpenTill never needed: an LP must actually hold sats
   * inside Tachi before it can front a swap. Same transfer primitive, proven in
   * the smoke run as HOP 1 (operator → LP).
   */
  async fundOffchainAccount(params: { ref: string; amountSats: bigint }): Promise<{ address: string; transferId: string }> {
    const { address } = await this.createOffchainAddress(params.ref);
    const { hash } = await this.#transfer({
      toAddress: address,
      amountSats: params.amountSats,
      ref: params.ref,
      label: "lp-funding",
    });
    return { address, transferId: hash };
  }

  /** Ledger balance of one of our refs (or the operator float). */
  async offchainBalance(ref: string = OPERATOR_REF): Promise<bigint> {
    const { state } = this.#ready();
    const key = state.findByRef(ref);
    if (!key) return 0n;
    const b = await this.#client.getBalance(key.address);
    return BigInt(b.balance_sat);
  }

  /** The operator float's address — where regtest funding must land. */
  operatorAddress(): string {
    const key = this.#ready().state.findByRef(OPERATOR_REF);
    if (!key) throw new NotImplementedError("init() must be awaited before use");
    return key.address;
  }

  /**
   * The simulated Bitcoin L1 behind this adapter. Exposed so operator dev
   * routes can drive it (mint a simulated deposit, mine simulated blocks) —
   * that is legitimate precisely because these blocks are not real.
   */
  simulatedL1(): MockSettlementAdapter {
    return this.#l1;
  }

  /** Exposed for scripts/tests: the adapter's keys (public material only). */
  keys(): readonly DerivedKey[] {
    return this.#ready().state.state.keys;
  }

  // ---- internals ------------------------------------------------------------

  async #transfer(params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
    label: string;
  }): Promise<{ hash: string; from: DerivedKey }> {
    const { keyring, state } = this.#ready();
    if (params.amountSats <= 0n) throw new RangeError("transfer amount must be positive");
    const owner = keyring.ownerFromAddress(params.toAddress);
    const fee = await this.#feeSats();
    const need = params.amountSats + fee;

    // One TachiTx has one signer, so a single key must cover amount + fee.
    // Smallest sufficient key first: leaves the operator float intact when a
    // leg key can already pay for itself.
    const funded: Array<{ key: DerivedKey; vtxos: Array<{ id: string; amount: number }>; total: bigint }> = [];
    for (const key of state.state.keys) {
      const res = await this.#client.getAddressVtxos(key.address, false);
      const spendable = res.vtxos.filter((v) => !v.spent && !v.locked);
      const total = spendable.reduce((a, v) => a + BigInt(v.amount), 0n);
      if (total > 0n) funded.push({ key, vtxos: spendable.map((v) => ({ id: v.id, amount: v.amount })), total });
    }
    const pick = funded.filter((f) => f.total >= need).sort((a, b) => (a.total < b.total ? -1 : 1))[0];
    if (!pick) {
      const grand = funded.reduce((a, f) => a + f.total, 0n);
      throw new InsufficientFundsError(
        `no single key can cover ${params.amountSats} + fee ${fee} sats ` +
          `(total ${grand} across ${funded.length} funded keys) — fund the operator float`,
      );
    }

    const inputs: Array<{ vtxoId: string; valueSats: bigint }> = [];
    let inSum = 0n;
    for (const v of [...pick.vtxos].sort((a, b) => b.amount - a.amount)) {
      inputs.push({ vtxoId: v.id, valueSats: BigInt(v.amount) });
      inSum += BigInt(v.amount);
      if (inSum >= need) break;
    }
    const change = inSum - need;
    const outputs = [{ owner, amountSats: params.amountSats }];
    if (change > 0n) outputs.push({ owner: Buffer.from(pick.key.xOnlyHex, "hex"), amountSats: change });

    const nonce = await this.#nonce(Buffer.from(pick.key.xOnlyHex, "hex"));
    const hex = await buildSignedTransferHex({
      signer: keyring.signer(pick.key),
      spenderXOnly: Buffer.from(pick.key.xOnlyHex, "hex"),
      inputs,
      outputs,
      feeSats: fee,
      nonce,
    });

    // A resolved promise is NOT success: read the CometBFT verdict, then wait
    // for the block commit — a mempool accept can still be dropped later.
    const verdict = assertBroadcastOk(await this.#client.broadcastTxSync(hex));
    const commit = await this.#waitCommit(verdict.hash);
    if (!commit.committed) throw new TachiBroadcastError(commit.code, commit.log || "not committed");

    this.#log(`tachi: REAL off-chain transfer committed (${params.label})`, {
      txId: verdict.hash,
      from: pick.key.address,
      to: params.toAddress,
      amountSats: params.amountSats.toString(),
      fee: fee.toString(),
      ref: params.ref,
      receivedVtxoId: vtxoIdFor(verdict.hash, 0),
    });
    return { hash: verdict.hash, from: pick.key };
  }

  #ready(): { keyring: TachiKeyring; state: StateStore } {
    if (!this.#keyring || !this.#state) {
      throw new NotImplementedError("TachiRealSettlementAdapter.init() must be awaited before use");
    }
    return { keyring: this.#keyring, state: this.#state };
  }

  async #feeSats(): Promise<bigint> {
    try {
      const est = await this.#client.getFeeEstimate();
      // Ledger transfers need fee >= 1 sat (fee 0 is rejected with code 8).
      return BigInt(Math.max(1, est.recommended_fee_sat || est.min_fee_sat || 1));
    } catch {
      return 1n;
    }
  }
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
