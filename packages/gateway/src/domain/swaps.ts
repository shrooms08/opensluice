import {
  SWAP_FUNDING_WINDOW_MS,
  type LegStatus,
  type Quote,
  type Swap,
  type SwapLeg,
  type SwapStatus,
} from "@opensluice/shared";
import type { OffchainEvent, OnchainEvent, SettlementAdapter } from "@opensluice/adapter";
import type { LegEvent, Repo } from "../db/repo";
import type { SwapEventBus } from "../events";
import { availableSats, chainForDirection } from "./lps";
import {
  SWAP_TRANSITIONS,
  assertLegTransition,
  assertSwapTransition,
  canTransitionSwap,
  isSwapTerminal,
} from "./state-machine";

export interface ServiceContext {
  repo: Repo;
  adapter: SettlementAdapter;
  events: SwapEventBus;
}

export class SwapNotFoundError extends Error {
  constructor(id: string) {
    super(`swap ${id} not found`);
    this.name = "SwapNotFoundError";
  }
}

export class QuoteNotFoundError extends Error {
  constructor(id: string) {
    super(`quote ${id} not found`);
    this.name = "QuoteNotFoundError";
  }
}

export class QuoteExpiredError extends Error {
  constructor(id: string) {
    super(`quote ${id} has expired — request a fresh one`);
    this.name = "QuoteExpiredError";
  }
}

export class QuoteAlreadyAcceptedError extends Error {
  constructor(id: string) {
    super(`quote ${id} was already accepted`);
    this.name = "QuoteAlreadyAcceptedError";
  }
}

/** The book moved between quoting and accepting; the quote no longer routes. */
export class QuoteStaleError extends Error {
  constructor(quoteId: string, detail: string) {
    super(`quote ${quoteId} is no longer executable: ${detail}`);
    this.name = "QuoteStaleError";
  }
}

type SwapPatch = Parameters<Repo["updateSwap"]>[1];
type LegPatch = Parameters<Repo["updateLeg"]>[1];

/**
 * The only sanctioned way to change swap.status. Validates against the
 * transition map, persists, and publishes on the event bus — synchronously,
 * so subscribers that write (the webhook enqueuer) join the caller's open
 * SQLite transaction.
 */
export function transitionSwap(
  ctx: ServiceContext,
  swap: Swap,
  to: SwapStatus,
  patch: Omit<SwapPatch, "status"> = {},
  now: number = Date.now(),
): Swap {
  assertSwapTransition(swap.status, to, swap.id);
  const stamped: SwapPatch = { ...patch, status: to };
  if (to === "completed" && swap.completedAt === null) stamped.completedAt = now;
  ctx.repo.updateSwap(swap.id, stamped, now);

  const updated = ctx.repo.getSwap(swap.id);
  if (!updated) throw new SwapNotFoundError(swap.id);

  ctx.events.publish({ kind: "transition", swap: updated, from: swap.status, to, at: now });
  return updated;
}

/**
 * The only sanctioned way to change leg.status. Direction picks the machine.
 * Publishes an `updated` event so live views (SSE) see leg movement even when
 * the aggregate status stays put.
 */
export function transitionLeg(
  ctx: ServiceContext,
  swap: Swap,
  leg: SwapLeg,
  to: LegStatus,
  patch: Omit<LegPatch, "status"> = {},
  now: number = Date.now(),
): SwapLeg {
  assertLegTransition(swap.direction, leg.status, to, leg.id);
  ctx.repo.updateLeg(leg.id, { ...patch, status: to }, now);
  const freshSwap = ctx.repo.getSwap(swap.id);
  if (freshSwap) ctx.events.publish({ kind: "updated", swap: freshSwap, at: now });
  return ctx.repo.getLeg(leg.id)!;
}

/** Publish a leg-visible change that moved no state machine (confirmation ticks). */
export function publishSwapUpdated(ctx: ServiceContext, swapId: string, now: number): void {
  const swap = ctx.repo.getSwap(swapId);
  if (swap) ctx.events.publish({ kind: "updated", swap, at: now });
}

// ---- quote acceptance -------------------------------------------------------

export interface AcceptedSwap {
  swap: Swap;
  legs: SwapLeg[];
}

/**
 * Accepting a quote is the moment capacity LOCKS. Deposit addresses are
 * derived first (adapter IO stays outside the transaction), then one SQLite
 * transaction re-validates the quote against the live book and creates the
 * swap + legs. From commit on, every leg amount counts against its LP's
 * available capacity until the leg settles or dies.
 */
export async function acceptQuote(
  ctx: ServiceContext,
  params: { quoteId: string; destination: string; webhookUrl: string | null },
  now: number = Date.now(),
): Promise<AcceptedSwap> {
  const quote = ctx.repo.getQuote(params.quoteId);
  if (!quote) throw new QuoteNotFoundError(params.quoteId);
  if (quote.status === "accepted") throw new QuoteAlreadyAcceptedError(quote.id);
  if (now >= quote.expiresAt) throw new QuoteExpiredError(quote.id);

  // The user pays each leg on the chain opposite to where they receive.
  const payChain = quote.direction === "swap_in" ? "onchain" : "offchain";
  const addresses: string[] = [];
  for (const leg of quote.legs) {
    const ref = `${quote.id}:${leg.lpId}`;
    const { address } =
      payChain === "onchain"
        ? await ctx.adapter.createOnchainDepositAddress(ref)
        : await ctx.adapter.createOffchainAddress(ref);
    await ctx.adapter.watchAddress(payChain, address);
    addresses.push(address);
  }

  return ctx.repo.db.transaction(() => {
    const fresh = ctx.repo.getQuote(quote.id)!;
    if (fresh.status === "accepted") throw new QuoteAlreadyAcceptedError(quote.id);

    // Re-validate: the quote locked nothing, so the book may have moved.
    for (const leg of quote.legs) {
      const lp = ctx.repo.getLp(leg.lpId);
      if (!lp || lp.status !== "active") {
        throw new QuoteStaleError(quote.id, `LP ${leg.lpId} is no longer active`);
      }
      const liquidity = ctx.repo.getLiquidity(leg.lpId, quote.direction);
      if (!liquidity) {
        throw new QuoteStaleError(quote.id, `LP ${leg.lpId} withdrew its ${quote.direction} offer`);
      }
      const available = availableSats(ctx.repo, leg.lpId, liquidity);
      if (available < leg.amountSats) {
        throw new QuoteStaleError(
          quote.id,
          `LP ${leg.lpId} has ${available} sats available, leg needs ${leg.amountSats}`,
        );
      }
    }

    const swap = ctx.repo.insertSwap(
      {
        quoteId: quote.id,
        direction: quote.direction,
        amountSats: quote.amountSats,
        totalFeeSats: quote.totalFeeSats,
        destination: params.destination,
        webhookUrl: params.webhookUrl,
        expiresAt: now + SWAP_FUNDING_WINDOW_MS,
      },
      now,
    );

    const legs = quote.legs.map((leg, i) =>
      ctx.repo.insertLeg(
        {
          swapId: swap.id,
          lpId: leg.lpId,
          amountSats: leg.amountSats,
          feeSats: leg.feeSats,
          estSeconds: leg.estSeconds,
          depositAddress: addresses[i]!,
        },
        now,
      ),
    );

    ctx.repo.markQuoteAccepted(quote.id, now);
    return { swap, legs };
  })();
}

// ---- aggregate status -------------------------------------------------------

const LADDER: readonly SwapStatus[] = ["pending", "funding", "settling", "completed"];

/** Where the swap should sit given its legs. Only the happy-path ladder. */
function deriveSwapTarget(legs: SwapLeg[]): SwapStatus {
  if (legs.every((l) => l.status === "settled")) return "completed";
  if (legs.every((l) => l.status !== "pending" && l.status !== "expired")) return "settling";
  if (legs.some((l) => l.status !== "pending")) return "funding";
  return "pending";
}

/**
 * Walk the swap toward the state its legs imply, one legal transition at a
 * time (pending can jump straight to settling; completed always passes
 * through settling). No-op on terminal swaps and on failure paths — those
 * are driven explicitly where the failure happens.
 */
export function advanceSwap(ctx: ServiceContext, swapId: string, now: number): Swap {
  let swap = ctx.repo.getSwap(swapId);
  if (!swap) throw new SwapNotFoundError(swapId);
  if (isSwapTerminal(swap.status)) return swap;

  const legs = ctx.repo.listLegsForSwap(swapId);
  if (legs.some((l) => l.status === "failed")) return swap;

  const target = deriveSwapTarget(legs);
  const targetIdx = LADDER.indexOf(target);

  while (swap.status !== target) {
    const reachable = SWAP_TRANSITIONS[swap.status]
      .filter((s) => LADDER.includes(s) && LADDER.indexOf(s) <= targetIdx)
      .sort((a, b) => LADDER.indexOf(b) - LADDER.indexOf(a))[0];
    if (!reachable) break;
    swap = transitionSwap(ctx, swap, reachable, {}, now);
  }
  return swap;
}

// ---- settlement event application (inside the poll transaction) -------------

/** Engine-side sends to perform once the poll transaction has committed. */
export interface LegAction {
  kind: "send_offchain" | "send_onchain";
  legId: string;
}

interface DepositSums {
  /** On-chain value seen in the mempool but not yet confirmed. */
  seenSats: bigint;
  /** Value at final stage: confirmed (on-chain) or committed (off-chain). */
  finalSats: bigint;
}

/** Per-tx aggregation of a leg's deposit events; a confirm supersedes its seen. */
function depositSums(events: LegEvent[]): DepositSums {
  const byTx = new Map<string, LegEvent>();
  for (const e of events) {
    if (e.kind !== "deposit") continue;
    const prior = byTx.get(e.txRef);
    if (!prior || prior.status === "seen") byTx.set(e.txRef, e);
  }
  let seenSats = 0n;
  let finalSats = 0n;
  for (const e of byTx.values()) {
    if (e.status === "seen") seenSats += e.amountSats;
    else finalSats += e.amountSats;
  }
  return { seenSats, finalSats };
}

/**
 * Apply one on-chain event. MUST run inside the poller's transaction.
 * Idempotent on eventId. Returns sends to perform after commit.
 */
export function applyOnchainEvent(
  ctx: ServiceContext,
  event: OnchainEvent,
  now: number,
): LegAction[] {
  if (ctx.repo.hasLegEvent(event.eventId)) return [];

  // Our own payout confirming (swap_out LP -> user)?
  const payoutLeg = ctx.repo.findLegByPayoutTxId(event.txId);
  if (payoutLeg) {
    ctx.repo.insertLegEvent(
      {
        eventId: event.eventId,
        legId: payoutLeg.id,
        chain: "onchain",
        kind: "payout",
        txRef: event.txId,
        amountSats: event.amountSats,
        status: event.status,
        confirmations: event.confirmations,
        observedAt: event.observedAt,
      },
      now,
    );
    if (event.status === "confirmed" && payoutLeg.status === "broadcasting") {
      const swap = ctx.repo.getSwap(payoutLeg.swapId)!;
      settleLeg(ctx, swap, payoutLeg, { payoutConfirmed: true }, now);
    } else {
      publishSwapUpdated(ctx, payoutLeg.swapId, now);
    }
    return [];
  }

  // A user deposit to a swap_in leg?
  const leg = ctx.repo.findLegByDepositAddress(event.toAddress);
  if (!leg) return [];
  const swap = ctx.repo.getSwap(leg.swapId)!;
  if (swap.direction !== "swap_in") return [];

  ctx.repo.insertLegEvent(
    {
      eventId: event.eventId,
      legId: leg.id,
      chain: "onchain",
      kind: "deposit",
      txRef: event.txId,
      amountSats: event.amountSats,
      status: event.status,
      confirmations: event.confirmations,
      observedAt: event.observedAt,
    },
    now,
  );

  // Money arriving after the swap died is recorded but never credited (GAPS.md).
  if (isSwapTerminal(swap.status)) return [];

  const sums = depositSums(ctx.repo.listEventsForLeg(leg.id));
  let current = ctx.repo.getLeg(leg.id)!;
  const actions: LegAction[] = [];
  let moved = false;

  if (current.status === "pending" && sums.seenSats + sums.finalSats >= current.amountSats) {
    current = transitionLeg(ctx, swap, current, "seen", {}, now);
    moved = true;
  }
  if (current.status === "seen" && sums.finalSats >= current.amountSats) {
    current = transitionLeg(ctx, swap, current, "confirmed", {}, now);
    actions.push({ kind: "send_offchain", legId: current.id });
    moved = true;
  }
  advanceSwap(ctx, swap.id, now);
  // Confirmation ticks that moved nothing still matter to live views.
  if (!moved) publishSwapUpdated(ctx, swap.id, now);
  return actions;
}

/**
 * Apply one off-chain event. MUST run inside the poller's transaction.
 * Idempotent on eventId. Returns sends to perform after commit.
 */
export function applyOffchainEvent(
  ctx: ServiceContext,
  event: OffchainEvent,
  now: number,
): LegAction[] {
  if (ctx.repo.hasLegEvent(event.eventId)) return [];

  const leg = ctx.repo.findLegByDepositAddress(event.toAddress);
  if (!leg) return [];
  const swap = ctx.repo.getSwap(leg.swapId)!;
  if (swap.direction !== "swap_out") return [];

  ctx.repo.insertLegEvent(
    {
      eventId: event.eventId,
      legId: leg.id,
      chain: "offchain",
      kind: "deposit",
      txRef: event.transferId,
      amountSats: event.amountSats,
      status: "committed",
      observedAt: event.observedAt,
    },
    now,
  );

  if (isSwapTerminal(swap.status)) return [];

  const sums = depositSums(ctx.repo.listEventsForLeg(leg.id));
  let current = ctx.repo.getLeg(leg.id)!;
  const actions: LegAction[] = [];

  if (current.status === "pending" && sums.finalSats >= current.amountSats) {
    current = transitionLeg(ctx, swap, current, "committed", {}, now);
    actions.push({ kind: "send_onchain", legId: current.id });
  }
  advanceSwap(ctx, swap.id, now);
  return actions;
}

// ---- settlement + failure ---------------------------------------------------

/**
 * Terminal accounting for a leg that fully settled. Writes the double-entry
 * ledger rows: credit what the LP received from the user, debit what it paid
 * out. The rows of one leg sum to exactly the fee the LP earned.
 */
function settleLeg(
  ctx: ServiceContext,
  swap: Swap,
  leg: SwapLeg,
  detail: { payoutTransferId?: string; payoutConfirmed?: boolean },
  now: number,
): void {
  const patch: LegPatch = { settledAt: now };
  if (detail.payoutTransferId !== undefined) patch.payoutTransferId = detail.payoutTransferId;
  transitionLeg(ctx, swap, leg, "settled", patch, now);

  const payout = leg.amountSats - leg.feeSats;
  if (swap.direction === "swap_in") {
    ctx.repo.insertLedgerEntry(
      { lpId: leg.lpId, chain: "onchain", swapId: swap.id, legId: leg.id, entryType: "swap_in_deposit", amountSats: leg.amountSats },
      now,
    );
    ctx.repo.insertLedgerEntry(
      { lpId: leg.lpId, chain: "offchain", swapId: swap.id, legId: leg.id, entryType: "swap_in_payout", amountSats: -payout },
      now,
    );
  } else {
    ctx.repo.insertLedgerEntry(
      { lpId: leg.lpId, chain: "offchain", swapId: swap.id, legId: leg.id, entryType: "swap_out_deposit", amountSats: leg.amountSats },
      now,
    );
    ctx.repo.insertLedgerEntry(
      { lpId: leg.lpId, chain: "onchain", swapId: swap.id, legId: leg.id, entryType: "swap_out_payout", amountSats: -payout },
      now,
    );
  }
  advanceSwap(ctx, swap.id, now);
}

/**
 * A send failed after the user already funded the leg. The swap fails, the
 * error is recorded, and the user's deposit — which the LP holds — is written
 * to the ledger as a stranded credit so no sats vanish from the books.
 */
function failLegAfterFunding(
  ctx: ServiceContext,
  swap: Swap,
  leg: SwapLeg,
  error: string,
  now: number,
): void {
  transitionLeg(ctx, swap, leg, "failed", { error, needsManualResolution: true }, now);
  ctx.repo.insertLedgerEntry(
    {
      lpId: leg.lpId,
      chain: chainForDirection(swap.direction) === "offchain" ? "onchain" : "offchain",
      swapId: swap.id,
      legId: leg.id,
      entryType: "stranded_deposit",
      amountSats: leg.amountSats,
    },
    now,
  );
  const fresh = ctx.repo.getSwap(swap.id)!;
  if (!isSwapTerminal(fresh.status)) {
    transitionSwap(ctx, fresh, "failed", { error }, now);
  }
}

/**
 * Engine-side send for a funded leg. Runs OUTSIDE the poll transaction
 * (adapter IO); each outcome commits in its own small transaction. Re-reads
 * state and no-ops unless the leg still awaits exactly this action, so a
 * replayed action is harmless.
 */
export async function performLegAction(
  ctx: ServiceContext,
  action: LegAction,
  now: number = Date.now(),
): Promise<void> {
  const leg = ctx.repo.getLeg(action.legId);
  if (!leg) return;
  const swap = ctx.repo.getSwap(leg.swapId);
  if (!swap || isSwapTerminal(swap.status)) return;

  const payout = leg.amountSats - leg.feeSats;
  const run = ctx.repo.db.transaction.bind(ctx.repo.db);

  if (action.kind === "send_offchain") {
    if (swap.direction !== "swap_in" || leg.status !== "confirmed") return;
    if (payout <= 0n) {
      run(() => failLegAfterFunding(ctx, swap, leg, "leg payout is not positive", now))();
      return;
    }
    try {
      const { transferId } = await ctx.adapter.sendOffchain({
        toAddress: swap.destination,
        amountSats: payout,
        ref: leg.id,
      });
      run(() => settleLeg(ctx, swap, leg, { payoutTransferId: transferId }, now))();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run(() => failLegAfterFunding(ctx, swap, leg, `off-chain send failed: ${message}`, now))();
    }
    return;
  }

  // send_onchain (swap_out)
  if (swap.direction !== "swap_out" || leg.status !== "committed") return;
  if (payout <= 0n) {
    run(() => failLegAfterFunding(ctx, swap, leg, "leg payout is not positive", now))();
    return;
  }
  try {
    // Watch the user's destination so the payout's confirmation events reach the poller.
    await ctx.adapter.watchAddress("onchain", swap.destination);
    const { txId } = await ctx.adapter.sendOnchain({
      toAddress: swap.destination,
      amountSats: payout,
      ref: leg.id,
    });
    run(() => {
      transitionLeg(ctx, swap, leg, "broadcasting", { payoutTxId: txId }, now);
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(() => failLegAfterFunding(ctx, swap, leg, `on-chain send failed: ${message}`, now))();
  }
}

// ---- expiry -----------------------------------------------------------------

/**
 * Sweep swaps whose funding window closed. Untouched swaps expire whole;
 * partially paid ones become `partially_funded` (terminal for Gate 1): unpaid
 * legs expire — their locks vanish with the terminal swap status — and any
 * received funds are written to the ledger as stranded credits for manual
 * resolution (GAPS.md).
 */
export function expireDueSwaps(ctx: ServiceContext, now: number = Date.now()): number {
  const due = ctx.repo.findExpirableSwaps(now);
  let changed = 0;

  for (const swap of due) {
    ctx.repo.db.transaction(() => {
      const legs = ctx.repo.listLegsForSwap(swap.id);
      const paidLegs = legs.filter((l) => l.status !== "pending" && l.status !== "expired");

      for (const leg of legs) {
        if (leg.status === "pending") {
          // Record any sub-threshold deposits before abandoning the leg.
          strandReceivedFunds(ctx, swap, leg, now);
          transitionLeg(ctx, swap, leg, "expired", {}, now);
        } else if (leg.status !== "settled") {
          // Paid but not settled at expiry: funds are in limbo — flag them.
          strandReceivedFunds(ctx, swap, leg, now);
          ctx.repo.updateLeg(leg.id, { needsManualResolution: true }, now);
        }
      }

      transitionSwap(ctx, swap, paidLegs.length > 0 ? "partially_funded" : "expired", {}, now);
      changed += 1;
    })();
  }
  return changed;
}

/** Ledger credit for whatever final-stage value a dying leg received. */
function strandReceivedFunds(ctx: ServiceContext, swap: Swap, leg: SwapLeg, now: number): void {
  const sums = depositSums(ctx.repo.listEventsForLeg(leg.id));
  if (sums.finalSats <= 0n) return;
  ctx.repo.insertLedgerEntry(
    {
      lpId: leg.lpId,
      chain: swap.direction === "swap_in" ? "onchain" : "offchain",
      swapId: swap.id,
      legId: leg.id,
      entryType: "stranded_deposit",
      amountSats: sums.finalSats,
    },
    now,
  );
  ctx.repo.updateLeg(leg.id, { needsManualResolution: true }, now);
}
