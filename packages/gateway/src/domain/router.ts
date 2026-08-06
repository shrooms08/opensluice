import { MAX_ROUTE_LEGS, feeForAmount } from "@opensluice/shared";

/**
 * One LP's standing in the book for a direction, as the router sees it.
 * `availableSats` is already net of in-flight locks and the LP's funded
 * ledger balance — the router core is pure and never touches the DB.
 */
export interface RouterLp {
  lpId: string;
  lpName: string;
  availableSats: bigint;
  feeBps: number;
  feeFixedSats: bigint;
  minSats: bigint;
  maxSats: bigint;
  estSeconds: number;
}

export interface RouteLeg {
  lpId: string;
  lpName: string;
  amountSats: bigint;
  feeSats: bigint;
  estSeconds: number;
}

export type RouteResult =
  | { ok: true; legs: RouteLeg[]; totalFeeSats: bigint; estSeconds: number }
  | { ok: false; maxRoutableSats: bigint };

/** Largest amount an LP can take in one leg. */
function chunkCap(lp: RouterLp): bigint {
  return lp.availableSats < lp.maxSats ? lp.availableSats : lp.maxSats;
}

function legFee(lp: RouterLp, amount: bigint): bigint {
  return feeForAmount(amount, lp.feeBps, lp.feeFixedSats);
}

/** LP is usable in a split at all: its smallest legal leg fits and pays out. */
function usableForSplit(lp: RouterLp): boolean {
  const cap = chunkCap(lp);
  return cap >= lp.minSats && cap > 0n && legFee(lp, cap) < cap;
}

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ordering for greedy allocation: cheapest marginal rate first. Ties break on
 * fixed fee, then speed, then bigger capacity (fewer legs), then lpId so the
 * same book always yields the same route.
 */
function bySplitPreference(a: RouterLp, b: RouterLp): number {
  return (
    a.feeBps - b.feeBps ||
    compareBigint(a.feeFixedSats, b.feeFixedSats) ||
    a.estSeconds - b.estSeconds ||
    compareBigint(chunkCap(b), chunkCap(a)) ||
    a.lpId.localeCompare(b.lpId)
  );
}

function toLeg(lp: RouterLp, amount: bigint): RouteLeg {
  return {
    lpId: lp.lpId,
    lpName: lp.lpName,
    amountSats: amount,
    feeSats: legFee(lp, amount),
    estSeconds: lp.estSeconds,
  };
}

function finish(legs: RouteLeg[]): RouteResult {
  const totalFeeSats = legs.reduce((s, l) => s + l.feeSats, 0n);
  const estSeconds = legs.reduce((s, l) => Math.max(s, l.estSeconds), 0);
  return { ok: true, legs, totalFeeSats, estSeconds };
}

/**
 * Deterministic best-execution routing over the live book.
 *
 * 1. Single-LP route whenever one LP covers the whole amount: lowest total
 *    fee wins; ties break on est_seconds, then larger available capacity,
 *    then lpId.
 * 2. Otherwise a split: greedy by effective fee rate (bps, then fixed),
 *    biggest chunk from the cheapest LP first, at most MAX_ROUTE_LEGS legs.
 *    A one-step rebalance keeps a leftover from being stranded below the
 *    next LP's minimum.
 * 3. Otherwise { ok: false } with the largest amount currently routable.
 *
 * Callers pre-filter to active LPs with a liquidity row for the direction.
 */
export function routeQuote(book: RouterLp[], amountSats: bigint): RouteResult {
  if (amountSats <= 0n) return { ok: false, maxRoutableSats: 0n };

  // ---- single-LP route ------------------------------------------------------
  const singles = book.filter(
    (lp) =>
      lp.availableSats >= amountSats &&
      lp.minSats <= amountSats &&
      lp.maxSats >= amountSats &&
      legFee(lp, amountSats) < amountSats,
  );
  if (singles.length > 0) {
    const best = [...singles].sort(
      (a, b) =>
        compareBigint(legFee(a, amountSats), legFee(b, amountSats)) ||
        a.estSeconds - b.estSeconds ||
        compareBigint(b.availableSats, a.availableSats) ||
        a.lpId.localeCompare(b.lpId),
    )[0]!;
    return finish([toLeg(best, amountSats)]);
  }

  // ---- split route ----------------------------------------------------------
  const usable = book.filter(usableForSplit).sort(bySplitPreference);

  const legs: Array<{ lp: RouterLp; amount: bigint }> = [];
  let remaining = amountSats;

  for (const lp of usable) {
    if (remaining <= 0n || legs.length >= MAX_ROUTE_LEGS) break;
    let take = chunkCap(lp) < remaining ? chunkCap(lp) : remaining;
    let rebalanced = 0n;

    if (take < lp.minSats) {
      // Leftover too small for this LP's minimum: pull the difference back
      // from the previous leg if that leg can spare it. One-step rebalance —
      // deeper allocation search is out of scope (GAPS.md).
      const prev = legs[legs.length - 1];
      const shortfall = lp.minSats - take;
      if (prev && prev.amount - shortfall >= prev.lp.minSats) {
        prev.amount -= shortfall;
        remaining += shortfall;
        rebalanced = shortfall;
        take = lp.minSats;
      } else {
        continue;
      }
    }

    // A chunk whose fee eats it whole would pay the user nothing: skip it
    // (and undo any rebalance done on its behalf).
    if (legFee(lp, take) >= take) {
      if (rebalanced > 0n) {
        legs[legs.length - 1]!.amount += rebalanced;
        remaining -= rebalanced;
      }
      continue;
    }

    legs.push({ lp, amount: take });
    remaining -= take;
  }

  if (remaining === 0n && legs.length > 0) {
    return finish(legs.map((l) => toLeg(l.lp, l.amount)));
  }

  // ---- insufficient ---------------------------------------------------------
  return { ok: false, maxRoutableSats: bookMaxRoutableSats(book) };
}

/**
 * Largest amount currently routable across ≤ MAX_ROUTE_LEGS legs. An upper
 * bound: min-constraint shapes can make smaller amounts unroutable (GAPS.md).
 */
export function bookMaxRoutableSats(book: RouterLp[]): bigint {
  return book
    .filter(usableForSplit)
    .map(chunkCap)
    .sort((a, b) => compareBigint(b, a))
    .slice(0, MAX_ROUTE_LEGS)
    .reduce((s, c) => s + c, 0n);
}

/** Smallest amount any usable LP will take right now; 0n on an empty book. */
export function bookMinRoutableSats(book: RouterLp[]): bigint {
  const mins = book.filter(usableForSplit).map((lp) => lp.minSats);
  if (mins.length === 0) return 0n;
  return mins.reduce((min, m) => (m < min ? m : min));
}
