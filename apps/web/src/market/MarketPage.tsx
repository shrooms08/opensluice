import { useEffect, useState } from "react";
import { Wordmark } from "../App";
import { formatEstimate, formatSats } from "../shared/format";
import type { Marketplace, MarketplaceEntry, SwapDirection } from "../shared/types";
import { usePolling } from "../lp/usePolling";

/** Plain-language direction labels — this page is a user surface. */
const TABS: Array<{ value: SwapDirection; label: string }> = [
  { value: "swap_in", label: "On-chain → balance" },
  { value: "swap_out", label: "Balance → on-chain" },
];

export function MarketPage() {
  const [market, setMarket] = useState<Marketplace | null>(null);
  const [direction, setDirection] = useState<SwapDirection>("swap_in");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "OpenSluice — Marketplace";
  }, []);

  usePolling(async () => {
    try {
      const res = await fetch("/api/marketplace");
      if (!res.ok) throw new Error(`marketplace failed (${res.status})`);
      setMarket((await res.json()) as Marketplace);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="mk">
      <header className="mk-head">
        <Wordmark />
        <a className="btn-secondary mk-swap-link" href="/">
          Swap →
        </a>
      </header>
      <main className="mk-main">
        <div className="mk-title-row">
          <h1 className="mk-title">The liquidity book</h1>
          <span className="live-chip">
            <span className="dot" />
            LIVE
          </span>
        </div>
        <p className="mk-sub">
          Every provider quoting right now, refreshed every few seconds. Rates come from
          independent liquidity providers competing for your swap.
        </p>

        {error && <p className="banner-error">{error}</p>}

        <div className="mk-tabs" role="tablist" aria-label="Direction">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={direction === tab.value}
              className={direction === tab.value ? "chip is-active" : "chip"}
              onClick={() => setDirection(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <MarketBook
          entries={
            market === null ? null : direction === "swap_in" ? market.swapIn : market.swapOut
          }
        />
      </main>
      <footer className="mk-foot mono">
        Anyone can provide liquidity — operators register providers via the API
      </footer>
    </div>
  );
}

function rateLabel(entry: MarketplaceEntry): string {
  const pct = (entry.feeBps / 100).toFixed(2);
  return entry.feeFixedSats === "0" ? `${pct}%` : `${pct}% + ${formatSats(entry.feeFixedSats)} sats`;
}

export function MarketBook({ entries }: { entries: MarketplaceEntry[] | null }) {
  if (entries === null) {
    return (
      <div className="skel-rows">
        <div className="skel" style={{ width: "60%" }} />
        <div className="skel" style={{ width: "85%" }} />
        <div className="skel" style={{ width: "70%" }} />
      </div>
    );
  }

  const live = entries.filter((e) => BigInt(e.availableSats) > 0n);
  if (live.length === 0) {
    return (
      <div className="mk-empty">
        <div className="mk-empty-title">No liquidity right now</div>
        <p className="mk-empty-sub">
          No provider is quoting this direction at the moment. Check back shortly — the book
          refreshes live.
        </p>
      </div>
    );
  }

  const total = live.reduce((sum, e) => sum + BigInt(e.availableSats), 0n);
  const best = live.find((e) => e.bestRate) ?? null;

  return (
    <>
      <div className="mk-totals">
        <div className="mk-total">
          <span className="mk-total-label">Available now</span>
          <span className="mk-total-value mono">{formatSats(total.toString())} sats</span>
        </div>
        <div className="mk-total">
          <span className="mk-total-label">Providers</span>
          <span className="mk-total-value mono">{live.length}</span>
        </div>
        <div className="mk-total">
          <span className="mk-total-label">Best rate</span>
          <span className="mk-total-value mono">{best ? rateLabel(best) : "—"}</span>
        </div>
      </div>

      <div className="mk-book" role="list">
        {live.map((entry) => (
          <div
            role="listitem"
            key={entry.lpId}
            className={entry.bestRate ? "mk-row is-best" : "mk-row"}
          >
            <div className="mk-row-name">
              {entry.name}
              {entry.bestRate && <span className="mk-best-tag">BEST RATE</span>}
            </div>
            <div className="mk-row-facts">
              <span className="mk-fact">
                <span className="mk-fact-label">available</span>
                <span className="mono">{formatSats(entry.availableSats)} sats</span>
              </span>
              <span className="mk-fact">
                <span className="mk-fact-label">rate</span>
                <span className="mono">{rateLabel(entry)}</span>
              </span>
              <span className="mk-fact">
                <span className="mk-fact-label">per swap</span>
                <span className="mono">
                  {formatSats(entry.minSats)}–{formatSats(entry.maxSats)}
                </span>
              </span>
              <span className="mk-fact">
                <span className="mk-fact-label">est. time</span>
                <span className="mono">{formatEstimate(entry.estSeconds)}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
