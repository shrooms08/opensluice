import { formatSats } from "../shared/format";
import type { Marketplace, MarketplaceEntry, SwapDirection } from "../shared/types";

function summarize(entries: MarketplaceEntry[]): {
  total: bigint;
  providers: number;
  bestBps: number | null;
} {
  let total = 0n;
  let providers = 0;
  let bestBps: number | null = null;
  for (const e of entries) {
    if (BigInt(e.availableSats) <= 0n) continue;
    total += BigInt(e.availableSats);
    providers += 1;
    if (bestBps === null || e.feeBps < bestBps) bestBps = e.feeBps;
  }
  return { total, providers, bestBps };
}

/**
 * The trust line under the widget: live dot, what the book can actually cover
 * in the direction being quoted, and the way through to the public book.
 */
export function MarketplaceStrip({
  market,
  direction = "swap_in",
}: {
  market: Marketplace | null;
  direction?: SwapDirection;
}) {
  if (!market) return null;

  const { total, providers, bestBps } = summarize(
    direction === "swap_in" ? market.swapIn : market.swapOut,
  );

  return (
    <section className="strip" aria-label="Live liquidity">
      {providers > 0 ? (
        <>
          <span className="strip-live mono">
            <span className="dot" />
            {formatSats(total.toString())} sats available
          </span>
          <span className="strip-facts mono">
            {bestBps !== null ? `best ${bestBps} bps · ` : ""}
            <a href="/market">
              {providers} {providers === 1 ? "provider" : "providers"}
            </a>
          </span>
        </>
      ) : (
        <>
          <span className="strip-live mono is-empty">
            <span className="dot" />
            no liquidity in this direction right now
          </span>
          <span className="strip-facts mono">
            <a href="/market">View the book</a>
          </span>
        </>
      )}
    </section>
  );
}
