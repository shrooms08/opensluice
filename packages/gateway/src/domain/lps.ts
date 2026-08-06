import { createHash, randomBytes } from "node:crypto";
import type { LedgerChain, Lp, LpLiquidity, SwapDirection } from "@opensluice/shared";
import type { Repo } from "../db/repo";
import type { RouterLp } from "./router";

/**
 * Which chain an LP fronts from, per direction: a swap_in pays the user
 * off-chain sats; a swap_out pays the user on-chain sats.
 */
export function chainForDirection(direction: SwapDirection): LedgerChain {
  return direction === "swap_in" ? "offchain" : "onchain";
}

/** Generate a per-LP API key. Shown once at registration, hashed at rest. */
export function generateLpApiKey(): { apiKey: string; hash: string } {
  const apiKey = `slk_${randomBytes(24).toString("hex")}`;
  return { apiKey, hash: hashLpApiKey(apiKey) };
}

export function hashLpApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

/**
 * What an LP can actually take right now, in user-side sats: its declared
 * capacity capped by the funds it holds on the fronting chain, minus
 * everything locked by in-flight swaps. Never negative.
 */
export function availableSats(repo: Repo, lpId: string, liquidity: LpLiquidity): bigint {
  const balance = repo.ledgerBalance(lpId, chainForDirection(liquidity.direction));
  const ceiling = liquidity.capacitySats < balance ? liquidity.capacitySats : balance;
  const available = ceiling - repo.lockedSats(lpId, liquidity.direction);
  return available > 0n ? available : 0n;
}

export interface BookEntry extends RouterLp {
  updatedAt: number;
}

/**
 * The lpId of the entry the router would drain first: cheapest marginal rate
 * (feeBps, then fixed fee, then est. time, then lpId) among providers that
 * actually have availability. Null when the whole book is dry. Mirrors the
 * split allocator's preference so "best rate" on the marketplace is the rate
 * users actually get first.
 */
export function bestRateLpId(book: BookEntry[]): string | null {
  const live = book.filter((e) => e.availableSats > 0n);
  if (live.length === 0) return null;
  const best = [...live].sort(
    (a, b) =>
      a.feeBps - b.feeBps ||
      (a.feeFixedSats < b.feeFixedSats ? -1 : a.feeFixedSats > b.feeFixedSats ? 1 : 0) ||
      a.estSeconds - b.estSeconds ||
      a.lpId.localeCompare(b.lpId),
  )[0]!;
  return best.lpId;
}

/** The live book for one direction: every active LP's offer with availability. */
export function buildBook(repo: Repo, direction: SwapDirection): BookEntry[] {
  const entries: BookEntry[] = [];
  for (const liquidity of repo.listLiquidity(direction)) {
    const lp: Lp | null = repo.getLp(liquidity.lpId);
    if (!lp || lp.status !== "active") continue;
    entries.push({
      lpId: lp.id,
      lpName: lp.name,
      availableSats: availableSats(repo, lp.id, liquidity),
      feeBps: liquidity.feeBps,
      feeFixedSats: liquidity.feeFixedSats,
      minSats: liquidity.minSats,
      maxSats: liquidity.maxSats,
      estSeconds: liquidity.estSeconds,
      updatedAt: liquidity.updatedAt,
    });
  }
  return entries;
}
