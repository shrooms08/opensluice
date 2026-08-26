/**
 * TachiSettlementAdapter — scaffold for the real Tachi + Bitcoin integration.
 *
 * Constructible so the factory stays total, but init() refuses to run:
 * ADAPTER_MODE=tachi is a spec, not a live path. INTEGRATION.md carries the
 * method-by-method mapping, what Tachi's docs answer today, and the open
 * questions each remaining method depends on.
 */
import {
  NotImplementedError,
  type AdapterConfig,
  type OffchainEvent,
  type OnchainEvent,
  type SettlementAdapter,
} from "./types";

export class TachiSettlementAdapter implements SettlementAdapter {
  readonly capabilities = {
    onchainReal: false,
    offchainReal: false,
    label: "tachi-stub",
    chainId: null,
  } as const;

  readonly mode = "tachi" as const;

  constructor(private readonly config: AdapterConfig) {
    void this.config;
  }

  async init(): Promise<void> {
    throw new NotImplementedError(
      "ADAPTER_MODE=tachi is a documented integration scaffold, not a live adapter. " +
        "The on-chain leg needs a watch-only Bitcoin wallet (or Tachi's hosted RPC) and " +
        "the off-chain leg needs receiver-side VTXO detection, which is still open. " +
        "See INTEGRATION.md for the plan. Run with ADAPTER_MODE=mock.",
    );
  }

  async createOnchainDepositAddress(_ref: string): Promise<{ address: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md");
  }

  async pollOnchain(_cursor: string | null): Promise<{ events: OnchainEvent[]; nextCursor: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md");
  }

  async sendOnchain(_params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
  }): Promise<{ txId: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md");
  }

  async createOffchainAddress(_ref: string): Promise<{ address: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md");
  }

  async pollOffchain(_cursor: string | null): Promise<{ events: OffchainEvent[]; nextCursor: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md");
  }

  async sendOffchain(_params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
  }): Promise<{ transferId: string }> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md");
  }

  async watchAddress(_chain: "onchain" | "offchain", _address: string): Promise<void> {
    throw new NotImplementedError("tachi adapter: see INTEGRATION.md");
  }
}
