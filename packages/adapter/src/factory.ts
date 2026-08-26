import { MockSettlementAdapter } from "./mock";
import { TachiSettlementAdapter } from "./tachi";
import { TachiRealSettlementAdapter } from "./tachi-real";
import { type AdapterConfig, type SettlementAdapter } from "./types";

/**
 * Single construction point for settlement adapters. Nothing outside this
 * package may know which implementation is in play — callers read
 * `adapter.capabilities` instead.
 */
export function createAdapter(config: AdapterConfig): SettlementAdapter {
  switch (config.mode) {
    case "mock":
      return new MockSettlementAdapter(config);
    case "tachi":
      // With real Tachi config present, settle off-chain for real. Without it,
      // the documented stub still refuses to boot rather than pretending.
      return config.tachi
        ? new TachiRealSettlementAdapter(config.tachi)
        : new TachiSettlementAdapter(config);
    default: {
      const exhaustive: never = config.mode;
      throw new Error(`unknown adapter mode: ${String(exhaustive)}`);
    }
  }
}
