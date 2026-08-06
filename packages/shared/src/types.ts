export const SWAP_DIRECTIONS = ["swap_in", "swap_out"] as const;
export type SwapDirection = (typeof SWAP_DIRECTIONS)[number];

export const SWAP_STATUSES = [
  "pending",
  "funding",
  "settling",
  "completed",
  "expired",
  "partially_funded",
  "failed",
] as const;
export type SwapStatus = (typeof SWAP_STATUSES)[number];

/**
 * Union of leg statuses across both directions. Which of these a leg may
 * actually visit depends on the swap direction — see the per-direction
 * transition maps in the gateway's state machine.
 */
export const LEG_STATUSES = [
  "pending",
  "seen",
  "confirmed",
  "committed",
  "broadcasting",
  "settled",
  "failed",
  "expired",
] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

export const LP_STATUSES = ["active", "paused"] as const;
export type LpStatus = (typeof LP_STATUSES)[number];

export const LEDGER_CHAINS = ["onchain", "offchain"] as const;
export type LedgerChain = (typeof LEDGER_CHAINS)[number];

/** Every way sats can move through an LP's mock ledger. */
export const LEDGER_ENTRY_TYPES = [
  "fund",
  "swap_in_deposit",
  "swap_in_payout",
  "swap_out_deposit",
  "swap_out_payout",
  "stranded_deposit",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

// ---- domain models (bigint sats) -------------------------------------------

export interface Lp {
  id: string;
  name: string;
  status: LpStatus;
  createdAt: number;
  updatedAt: number;
}

/** One row per lp × direction: the LP's offer for that side of the book. */
export interface LpLiquidity {
  lpId: string;
  direction: SwapDirection;
  /** Declared ceiling on the user-side amount this LP will route, in sats. */
  capacitySats: bigint;
  feeBps: number;
  feeFixedSats: bigint;
  minSats: bigint;
  maxSats: bigint;
  estSeconds: number;
  updatedAt: number;
}

export interface LpLedgerEntry {
  id: string;
  lpId: string;
  chain: LedgerChain;
  swapId: string | null;
  legId: string | null;
  entryType: LedgerEntryType;
  /** Signed: credits positive, debits negative. */
  amountSats: bigint;
  createdAt: number;
}

export interface QuoteLeg {
  lpId: string;
  lpName: string;
  amountSats: bigint;
  feeSats: bigint;
  estSeconds: number;
}

export interface Quote {
  id: string;
  direction: SwapDirection;
  amountSats: bigint;
  totalFeeSats: bigint;
  estSeconds: number;
  legs: QuoteLeg[];
  status: "active" | "accepted";
  createdAt: number;
  expiresAt: number;
}

export interface Swap {
  id: string;
  quoteId: string;
  direction: SwapDirection;
  status: SwapStatus;
  amountSats: bigint;
  totalFeeSats: bigint;
  /** Where the user receives: off-chain address (swap_in) or on-chain address (swap_out). */
  destination: string;
  webhookUrl: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Funding deadline — the user must have paid every leg by then. */
  expiresAt: number;
  completedAt: number | null;
}

export interface SwapLeg {
  id: string;
  swapId: string;
  lpId: string;
  amountSats: bigint;
  feeSats: bigint;
  estSeconds: number;
  status: LegStatus;
  /** Where the user pays this leg: on-chain (swap_in) or off-chain (swap_out) address. */
  depositAddress: string;
  payoutTxId: string | null;
  payoutTransferId: string | null;
  error: string | null;
  /** Set when user funds are held with no automatic path forward (see GAPS.md). */
  needsManualResolution: boolean;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

// ---- wire shapes (bigints become decimal strings) --------------------------

export interface LpDTO {
  id: string;
  name: string;
  status: LpStatus;
  createdAt: number;
  updatedAt: number;
}

/** Returned exactly once, at registration. The key is never shown again. */
export interface RegisteredLpDTO extends LpDTO {
  apiKey: string;
}

export interface MarketplaceEntryDTO {
  lpId: string;
  name: string;
  /** Capacity net of in-flight locks and the LP's funded ledger balance. */
  availableSats: string;
  feeBps: number;
  feeFixedSats: string;
  minSats: string;
  maxSats: string;
  estSeconds: number;
  updatedAt: number;
  /**
   * True on the entry the router would drain first in this direction: lowest
   * (feeBps, feeFixedSats, estSeconds) among providers with availability —
   * the same ordering the split allocator uses. At most one per direction.
   */
  bestRate: boolean;
}

export interface MarketplaceDTO {
  swapIn: MarketplaceEntryDTO[];
  swapOut: MarketplaceEntryDTO[];
  generatedAt: number;
}

export interface QuoteLegDTO {
  lpId: string;
  lpName: string;
  amountSats: string;
  feeSats: string;
  estSeconds: number;
}

export interface QuoteDTO {
  quoteId: string;
  direction: SwapDirection;
  amountSats: string;
  legs: QuoteLegDTO[];
  totalFeeSats: string;
  totalReceiveSats: string;
  estSeconds: number;
  expiresAt: number;
}

export interface SwapLegDTO {
  id: string;
  lpId: string;
  lpName: string;
  status: LegStatus;
  amountSats: string;
  feeSats: string;
  receiveSats: string;
  estSeconds: number;
  /** Payment instruction: the chain the user pays on, and where. */
  payChain: LedgerChain;
  payTo: string;
  payoutTxId: string | null;
  payoutTransferId: string | null;
  error: string | null;
  needsManualResolution: boolean;
  settledAt: number | null;
}

export interface SwapDTO {
  id: string;
  quoteId: string;
  direction: SwapDirection;
  status: SwapStatus;
  amountSats: string;
  totalFeeSats: string;
  totalReceiveSats: string;
  destination: string;
  webhookUrl: string | null;
  error: string | null;
  legs: SwapLegDTO[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  completedAt: number | null;
}

/**
 * What the unauthenticated swap page may see about a leg. The swap id is the
 * bearer capability for this view; LP identity, operator metadata, and raw
 * engine errors must NEVER appear here.
 */
export interface PublicSwapLegDTO {
  /** Position in the swap's leg list — the handle the dev pay-leg route uses. */
  index: number;
  status: LegStatus;
  amountSats: string;
  feeSats: string;
  receiveSats: string;
  estSeconds: number;
  /** Payment instruction: the chain the user pays on, and where. */
  payChain: LedgerChain;
  payTo: string;
  /** Settlement refs, once they exist (receipt rows). */
  payoutTxId: string | null;
  payoutTransferId: string | null;
  /** On-chain deposit confirmation progress (0..N); null until seen / off-chain. */
  confirmations: number | null;
}

/** Strict public allowlist for the swap page. Add a field only if a user may see it. */
export interface PublicSwapDTO {
  id: string;
  direction: SwapDirection;
  status: SwapStatus;
  amountSats: string;
  totalFeeSats: string;
  totalReceiveSats: string;
  destination: string;
  legs: PublicSwapLegDTO[];
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
  /** True when the env-guarded public simulate routes are live (demo buttons). */
  devSimulate: boolean;
}

export interface DirectionLimitsDTO {
  /** Smallest amount any active LP will take right now. "0" when the book is empty. */
  minSats: string;
  /** Largest amount currently routable (≤ MAX_ROUTE_LEGS legs). */
  maxRoutableSats: string;
}

export interface LimitsDTO {
  swapIn: DirectionLimitsDTO;
  swapOut: DirectionLimitsDTO;
}

export interface WebhookPayload {
  swapId: string;
  direction: SwapDirection;
  previousStatus: SwapStatus | null;
  status: SwapStatus;
  amountSats: string;
  totalFeeSats: string;
  timestamp: number;
}

// ---- LP-scoped wire shapes (per-LP key auth) --------------------------------
// Every field here is the calling LP's own data. Swap ids are TRUNCATED refs:
// the full id is the user's bearer capability for the public swap page and
// must not leak to LPs.

export interface LpLiquidityDTO {
  direction: SwapDirection;
  capacitySats: string;
  feeBps: number;
  feeFixedSats: string;
  minSats: string;
  maxSats: string;
  estSeconds: number;
  updatedAt: number;
}

export interface LpMeDTO {
  id: string;
  name: string;
  status: LpStatus;
  createdAt: number;
  liquidity: {
    swapIn: LpLiquidityDTO | null;
    swapOut: LpLiquidityDTO | null;
  };
}

export interface LpBalancesDTO {
  /** Signed sum of the LP's ledger rows per chain — what it actually holds. */
  onchainSats: string;
  offchainSats: string;
  /** User-side sats locked by in-flight legs, per direction (timelock exposure). */
  locked: {
    swapIn: string;
    swapOut: string;
  };
}

/** One in-flight leg holding this LP's capacity. */
export interface LpExposureRowDTO {
  swapRef: string;
  direction: SwapDirection;
  /** User-side amount locked against this LP until the leg settles or dies. */
  amountSats: string;
  feeSats: string;
  status: LegStatus;
  /** On-chain deposit confirmation progress; null until seen / off-chain legs. */
  confirmations: number | null;
  createdAt: number;
}

export interface LpExposureDTO {
  rows: LpExposureRowDTO[];
  totalLockedSats: string;
}

export interface LpEarningRowDTO {
  swapRef: string;
  direction: SwapDirection;
  amountSats: string;
  feeSats: string;
  settledAt: number;
}

export interface LpEarningsDTO {
  /** Lifetime fees from settled legs — matches the LP's ledger rows exactly. */
  totalFeesSats: string;
  rows: LpEarningRowDTO[];
  total: number;
  limit: number;
  offset: number;
}

export interface LpHistoryRowDTO {
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

export interface LpHistoryDTO {
  rows: LpHistoryRowDTO[];
  total: number;
  limit: number;
  offset: number;
}

export interface WebhookDeliveryDTO {
  id: string;
  swapId: string;
  url: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
