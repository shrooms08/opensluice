import { QUOTE_TTL_MS, type Quote, type SwapDirection } from "@opensluice/shared";
import type { Repo } from "../db/repo";
import { buildBook } from "./lps";
import { routeQuote } from "./router";

export type QuoteOutcome =
  | { ok: true; quote: Quote }
  | { ok: false; maxRoutableSats: bigint };

/**
 * Price a swap against the live book. Quotes LOCK NOTHING — they are a
 * snapshot with a 60s shelf life, re-validated at acceptance.
 */
export function createQuote(
  repo: Repo,
  params: { direction: SwapDirection; amountSats: bigint },
  now: number = Date.now(),
): QuoteOutcome {
  const book = buildBook(repo, params.direction);
  const route = routeQuote(book, params.amountSats);
  if (!route.ok) return { ok: false, maxRoutableSats: route.maxRoutableSats };

  const quote = repo.insertQuote(
    {
      direction: params.direction,
      amountSats: params.amountSats,
      totalFeeSats: route.totalFeeSats,
      estSeconds: route.estSeconds,
      legs: route.legs,
      expiresAt: now + QUOTE_TTL_MS,
    },
    now,
  );
  return { ok: true, quote };
}
