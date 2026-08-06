import { MockSettlementAdapter } from "./mock";
import { TachiSettlementAdapter } from "./tachi";
import { type AdapterConfig, type SettlementAdapter } from "./types";

/**
 * Single construction point for settlement adapters. Nothing outside this
 * package may know which implementation is in play.
 */
export function createAdapter(config: AdapterConfig): SettlementAdapter {
  switch (config.mode) {
    case "mock":
      return new MockSettlementAdapter(config);
    case "tachi":
      return new TachiSettlementAdapter(config);
    default: {
      const exhaustive: never = config.mode;
      throw new Error(`unknown adapter mode: ${String(exhaustive)}`);
    }
  }
}
