/** Wire shapes of the public gateway surface, mirrored locally (no cross-repo imports). */

export type SwapDirection = "swap_in" | "swap_out";

export type SwapStatus =
  | "pending"
  | "funding"
  | "settling"
  | "completed"
  | "expired"
  | "partially_funded"
  | "failed";

export type LegStatus =
  | "pending"
  | "seen"
  | "confirmed"
  | "committed"
  | "broadcasting"
  | "settled"
  | "failed"
  | "expired";

export interface PublicSwapLeg {
  index: number;
  status: LegStatus;
  amountSats: string;
  feeSats: string;
  receiveSats: string;
  estSeconds: number;
  payChain: "onchain" | "offchain";
  payTo: string;
  payoutTxId: string | null;
  payoutTransferId: string | null;
  confirmations: number | null;
}

export interface PublicSwap {
  id: string;
  direction: SwapDirection;
  status: SwapStatus;
  amountSats: string;
  totalFeeSats: string;
  totalReceiveSats: string;
  destination: string;
  legs: PublicSwapLeg[];
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
  devSimulate: boolean;
}

export interface QuoteLeg {
  lpId: string;
  lpName: string;
  amountSats: string;
  feeSats: string;
  estSeconds: number;
}

export interface Quote {
  quoteId: string;
  direction: SwapDirection;
  amountSats: string;
  legs: QuoteLeg[];
  totalFeeSats: string;
  totalReceiveSats: string;
  estSeconds: number;
  expiresAt: number;
}

export interface MarketplaceEntry {
  lpId: string;
  name: string;
  availableSats: string;
  feeBps: number;
  feeFixedSats: string;
  minSats: string;
  maxSats: string;
  estSeconds: number;
  updatedAt: number;
  /** Server-computed: the entry the router would drain first in this direction. */
  bestRate: boolean;
}

export interface Marketplace {
  swapIn: MarketplaceEntry[];
  swapOut: MarketplaceEntry[];
  generatedAt: number;
}

// ---- LP dashboard wire shapes (per-LP key auth) ------------------------------

export interface LpLiquidityConfig {
  direction: SwapDirection;
  capacitySats: string;
  feeBps: number;
  feeFixedSats: string;
  minSats: string;
  maxSats: string;
  estSeconds: number;
  updatedAt: number;
}

export interface LpMe {
  id: string;
  name: string;
  status: "active" | "paused";
  createdAt: number;
  liquidity: {
    swapIn: LpLiquidityConfig | null;
    swapOut: LpLiquidityConfig | null;
  };
}

export interface LpBalances {
  onchainSats: string;
  offchainSats: string;
  locked: {
    swapIn: string;
    swapOut: string;
  };
}

export interface LpExposureRow {
  swapRef: string;
  direction: SwapDirection;
  amountSats: string;
  feeSats: string;
  status: LegStatus;
  confirmations: number | null;
  createdAt: number;
}

export interface LpExposure {
  rows: LpExposureRow[];
  totalLockedSats: string;
}

export interface LpEarningRow {
  swapRef: string;
  direction: SwapDirection;
  amountSats: string;
  feeSats: string;
  settledAt: number;
}

export interface LpEarnings {
  totalFeesSats: string;
  rows: LpEarningRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface LpHistoryRow {
  swapRef: string;
  direction: SwapDirection;
  amountSats: string;
  feeSats: string;
  status: LegStatus;
  error: string | null;
  needsManualResolution: boolean;
  createdAt: number;
  settledAt: number | null;
}

export interface LpHistory {
  rows: LpHistoryRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface DirectionLimits {
  minSats: string;
  maxRoutableSats: string;
}

export interface Limits {
  swapIn: DirectionLimits;
  swapOut: DirectionLimits;
}
