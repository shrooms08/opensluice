import { formatSats } from "../shared/format";
import type { Marketplace, MarketplaceEntry } from "../shared/types";

function summarize(entries: MarketplaceEntry[]): { total: bigint; bestBps: number | null } {
  let total = 0n;
  let bestBps: number | null = null;
  for (const e of entries) {
    total += BigInt(e.availableSats);
    if (BigInt(e.availableSats) > 0n && (bestBps === null || e.feeBps < bestBps)) {
      bestBps = e.feeBps;
    }
  }
  return { total, bestBps };
}

/** Compact public liquidity book, linking to the full /market page. */
export function MarketplaceStrip({ market }: { market: Marketplace | null }) {
  if (!market) return null;

  const rows: Array<{ label: string; entries: MarketplaceEntry[] }> = [
    { label: "On-chain → balance", entries: market.swapIn },
    { label: "Balance → on-chain", entries: market.swapOut },
  ];

  return (
    <section className="strip" aria-label="Live liquidity">
      <div className="strip-head">
        <span className="strip-caption">LIQUIDITY BOOK</span>
        <a className="strip-link mono" href="/market">
          View marketplace →
        </a>
      </div>
      {rows.map(({ label, entries }) => {
        const { total, bestBps } = summarize(entries);
        const providers = entries.filter((e) => BigInt(e.availableSats) > 0n).length;
        return (
          <div className="strip-row" key={label}>
            <span className="strip-dir">{label}</span>
            {providers > 0 ? (
              <span className="strip-facts mono">
                {formatSats(total.toString())} sats · {providers}{" "}
                {providers === 1 ? "provider" : "providers"}
                {bestBps !== null ? ` · from ${(bestBps / 100).toFixed(2)}%` : ""}
              </span>
            ) : (
              <span className="strip-facts mono is-empty">no liquidity right now</span>
            )}
          </div>
        );
      })}
    </section>
  );
}
