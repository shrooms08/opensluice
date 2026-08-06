import type {
  Lp,
  LpDTO,
  LpEarningRowDTO,
  LpExposureRowDTO,
  LpHistoryRowDTO,
  LpLiquidity,
  LpLiquidityDTO,
  MarketplaceEntryDTO,
  PublicSwapDTO,
  PublicSwapLegDTO,
  Quote,
  QuoteDTO,
  Swap,
  SwapDTO,
  SwapDirection,
  SwapLeg,
  SwapLegDTO,
  WebhookDeliveryDTO,
} from "@opensluice/shared";
import type { WebhookDelivery } from "./db/repo";
import type { BookEntry } from "./domain/lps";

/**
 * Swap id as LPs see it: enough to correlate legs of one swap, useless as a
 * capability — the full id IS the user's bearer token for the public page.
 */
export function truncateSwapRef(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function toLpDTO(lp: Lp): LpDTO {
  return {
    id: lp.id,
    name: lp.name,
    status: lp.status,
    createdAt: lp.createdAt,
    updatedAt: lp.updatedAt,
  };
}

export function toMarketplaceEntryDTO(entry: BookEntry, bestRate: boolean): MarketplaceEntryDTO {
  return {
    lpId: entry.lpId,
    name: entry.lpName,
    availableSats: entry.availableSats.toString(),
    feeBps: entry.feeBps,
    feeFixedSats: entry.feeFixedSats.toString(),
    minSats: entry.minSats.toString(),
    maxSats: entry.maxSats.toString(),
    estSeconds: entry.estSeconds,
    updatedAt: entry.updatedAt,
    bestRate,
  };
}

// ---- LP-scoped serializers ---------------------------------------------------

export function toLpLiquidityDTO(liquidity: LpLiquidity): LpLiquidityDTO {
  return {
    direction: liquidity.direction,
    capacitySats: liquidity.capacitySats.toString(),
    feeBps: liquidity.feeBps,
    feeFixedSats: liquidity.feeFixedSats.toString(),
    minSats: liquidity.minSats.toString(),
    maxSats: liquidity.maxSats.toString(),
    estSeconds: liquidity.estSeconds,
    updatedAt: liquidity.updatedAt,
  };
}

export function toLpExposureRowDTO(
  leg: SwapLeg,
  direction: SwapDirection,
  confirmations: number | null,
): LpExposureRowDTO {
  return {
    swapRef: truncateSwapRef(leg.swapId),
    direction,
    amountSats: leg.amountSats.toString(),
    feeSats: leg.feeSats.toString(),
    status: leg.status,
    confirmations,
    createdAt: leg.createdAt,
  };
}

export function toLpEarningRowDTO(leg: SwapLeg, direction: SwapDirection): LpEarningRowDTO {
  return {
    swapRef: truncateSwapRef(leg.swapId),
    direction,
    amountSats: leg.amountSats.toString(),
    feeSats: leg.feeSats.toString(),
    // Settled legs always carry the stamp; ?? 0 satisfies the narrower DTO.
    settledAt: leg.settledAt ?? 0,
  };
}

export function toLpHistoryRowDTO(leg: SwapLeg, direction: SwapDirection): LpHistoryRowDTO {
  return {
    swapRef: truncateSwapRef(leg.swapId),
    direction,
    amountSats: leg.amountSats.toString(),
    feeSats: leg.feeSats.toString(),
    status: leg.status,
    error: leg.error,
    needsManualResolution: leg.needsManualResolution,
    createdAt: leg.createdAt,
    settledAt: leg.settledAt,
  };
}

export function toQuoteDTO(quote: Quote): QuoteDTO {
  return {
    quoteId: quote.id,
    direction: quote.direction,
    amountSats: quote.amountSats.toString(),
    legs: quote.legs.map((l) => ({
      lpId: l.lpId,
      lpName: l.lpName,
      amountSats: l.amountSats.toString(),
      feeSats: l.feeSats.toString(),
      estSeconds: l.estSeconds,
    })),
    totalFeeSats: quote.totalFeeSats.toString(),
    totalReceiveSats: (quote.amountSats - quote.totalFeeSats).toString(),
    estSeconds: quote.estSeconds,
    expiresAt: quote.expiresAt,
  };
}

export function toSwapLegDTO(swap: Swap, leg: SwapLeg, lpName: string): SwapLegDTO {
  return {
    id: leg.id,
    lpId: leg.lpId,
    lpName,
    status: leg.status,
    amountSats: leg.amountSats.toString(),
    feeSats: leg.feeSats.toString(),
    receiveSats: (leg.amountSats - leg.feeSats).toString(),
    estSeconds: leg.estSeconds,
    payChain: swap.direction === "swap_in" ? "onchain" : "offchain",
    payTo: leg.depositAddress,
    payoutTxId: leg.payoutTxId,
    payoutTransferId: leg.payoutTransferId,
    error: leg.error,
    needsManualResolution: leg.needsManualResolution,
    settledAt: leg.settledAt,
  };
}

export function toSwapDTO(swap: Swap, legs: SwapLeg[], lpNames: Map<string, string>): SwapDTO {
  return {
    id: swap.id,
    quoteId: swap.quoteId,
    direction: swap.direction,
    status: swap.status,
    amountSats: swap.amountSats.toString(),
    totalFeeSats: swap.totalFeeSats.toString(),
    totalReceiveSats: (swap.amountSats - swap.totalFeeSats).toString(),
    destination: swap.destination,
    webhookUrl: swap.webhookUrl,
    error: swap.error,
    legs: legs.map((leg) => toSwapLegDTO(swap, leg, lpNames.get(leg.lpId) ?? leg.lpId)),
    createdAt: swap.createdAt,
    updatedAt: swap.updatedAt,
    expiresAt: swap.expiresAt,
    completedAt: swap.completedAt,
  };
}

/**
 * Serialization for the unauthenticated swap page. Strict allowlist — add a
 * field here only if the person holding the swap link may see it. LP ids and
 * names, webhook URLs, quote ids, raw engine errors, and operator flags must
 * never pass through.
 */
export function toPublicSwapDTO(
  swap: Swap,
  legs: SwapLeg[],
  opts: { devSimulate: boolean; confirmations: Map<string, number | null> },
): PublicSwapDTO {
  const publicLegs: PublicSwapLegDTO[] = legs.map((leg, index) => ({
    index,
    status: leg.status,
    amountSats: leg.amountSats.toString(),
    feeSats: leg.feeSats.toString(),
    receiveSats: (leg.amountSats - leg.feeSats).toString(),
    estSeconds: leg.estSeconds,
    payChain: swap.direction === "swap_in" ? "onchain" : "offchain",
    payTo: leg.depositAddress,
    payoutTxId: leg.payoutTxId,
    payoutTransferId: leg.payoutTransferId,
    confirmations: opts.confirmations.get(leg.id) ?? null,
  }));
  return {
    id: swap.id,
    direction: swap.direction,
    status: swap.status,
    amountSats: swap.amountSats.toString(),
    totalFeeSats: swap.totalFeeSats.toString(),
    totalReceiveSats: (swap.amountSats - swap.totalFeeSats).toString(),
    destination: swap.destination,
    legs: publicLegs,
    createdAt: swap.createdAt,
    expiresAt: swap.expiresAt,
    completedAt: swap.completedAt,
    devSimulate: opts.devSimulate,
  };
}

export function toWebhookDeliveryDTO(delivery: WebhookDelivery): WebhookDeliveryDTO {
  return {
    id: delivery.id,
    swapId: delivery.swapId,
    url: delivery.url,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}
