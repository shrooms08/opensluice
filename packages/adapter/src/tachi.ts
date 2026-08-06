/**
 * TachiSettlementAdapter — scaffold for the real Tachi + Bitcoin integration.
 *
 * Constructible so the factory stays total, but init() refuses to run:
 * ADAPTER_MODE=tachi is a spec, not a live path. Gate 4 writes INTEGRATION.md
 * with the method-by-method mapping onto the @tachibtc/* SDK surface; until
 * then every question this adapter would need answered is open.
 */
import {
  NotImplementedError,
  type AdapterConfig,
  type OffchainEvent,
  type OnchainEvent,
  type SettlementAdapter,
} from "./types";

export class TachiSettlementAdapter implements SettlementAdapter {
  readonly mode = "tachi" as const;

  constructor(private readonly config: AdapterConfig) {
    void this.config;
  }

  async init(): Promise<void> {
    throw new NotImplementedError(
      "ADAPTER_MODE=tachi is a documented integration scaffold, not a live adapter. " +
        "The on-chain leg needs a watch-only Bitcoin wallet (or Tachi's hosted RPC) and " +
        "the off-chain leg needs receiver-side VTXO detection. INTEGRATION.md (Gate 4) " +
        "will carry the method-by-method plan. Run with ADAPTER_MODE=mock.",
    );
  }

  async createOnchainDepositAddress(_ref: string): Promise<{ address: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md (Gate 4)");
  }

  async pollOnchain(_cursor: string | null): Promise<{ events: OnchainEvent[]; nextCursor: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md (Gate 4)");
  }

  async sendOnchain(_params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
  }): Promise<{ txId: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md (Gate 4)");
  }

  async createOffchainAddress(_ref: string): Promise<{ address: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md (Gate 4)");
  }

  async pollOffchain(_cursor: string | null): Promise<{ events: OffchainEvent[]; nextCursor: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md (Gate 4)");
  }

  async sendOffchain(_params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
  }): Promise<{ transferId: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md (Gate 4)");
  }

  async watchAddress(_chain: "onchain" | "offchain", _address: string): Promise<void> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md (Gate 4)");
  }
}
