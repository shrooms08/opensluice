import { useEffect, useState } from "react";
import { LogoLockup } from "../shared/Logo";
import { formatEstimate, formatSats } from "../shared/format";
import type { Marketplace, MarketplaceEntry, SwapDirection } from "../shared/types";
import { usePolling } from "../lp/usePolling";

/** Plain-language direction labels — this page is a user surface. */
const TABS: Array<{ value: SwapDirection; label: string }> = [
  { value: "swap_in", label: "On-chain → Instant" },
  { value: "swap_out", label: "Balance → On-chain" },
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
        <a className="mk-brand" href="/" aria-label="OpenSluice home">
          <LogoLockup size={24} />
        </a>
        <nav className="mk-nav">
          <a href="/">Swap</a>
          <span className="is-current">Marketplace</span>
        </nav>
      </header>

      <main className="mk-main">
        <div className="mk-title-row">
          <div>
            <h1 className="mk-title">Who's providing liquidity right now</h1>
            <div className="mk-live mono">
              <span className="dot" />
              live · refreshes every few seconds
            </div>
          </div>
          <div className="mk-tabs" role="tablist" aria-label="Direction">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={direction === tab.value}
                className={direction === tab.value ? "mk-tab is-active" : "mk-tab"}
                onClick={() => setDirection(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="banner-error">{error}</p>}

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

export function rateLabel(entry: MarketplaceEntry): string {
  return entry.feeFixedSats === "0"
    ? `${entry.feeBps} bps`
    : `${entry.feeBps} bps + ${formatSats(entry.feeFixedSats)}`;
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
      <div className="mk-sheet is-empty">
        <div className="mk-empty-title">The book is empty</div>
        <p className="mk-empty-sub">
          No providers are quoting this direction right now. Liquidity usually returns within the
          hour — or bring your own.
        </p>
        {/* Repo-relative on purpose: the LP guide lives in the README, and
            registration is an operator curl, not a self-serve signup flow. */}
        <a className="btn-primary mk-become" href="README.md#the-lp-guide">
          Become a provider
        </a>
      </div>
    );
  }

  const total = live.reduce((sum, e) => sum + BigInt(e.availableSats), 0n);
  const best = live.find((e) => e.bestRate) ?? null;

  return (
    <>
      <div className="mk-totals">
        <div className="mk-total">
          <span className="mk-total-label">Total available</span>
          <span className="mk-total-value">
            {formatSats(total.toString())} <span className="unit">sats</span>
          </span>
        </div>
        <div className="mk-total">
          <span className="mk-total-label">Best rate</span>
          <span className="mk-total-value is-accent">{best ? rateLabel(best) : "—"}</span>
        </div>
        <div className="mk-total">
          <span className="mk-total-label">Providers quoting</span>
          <span className="mk-total-value">{live.length}</span>
        </div>
      </div>

      <div className="mk-sheet">
        <div className="mk-row mk-row-head">
          <span>PROVIDER</span>
          <span className="num">AVAILABLE</span>
          <span className="num">RATE</span>
          <span className="num">MIN — MAX</span>
          <span className="num">EST. TIME</span>
        </div>
        {live.map((entry) => (
          <div className={entry.bestRate ? "mk-row is-best" : "mk-row"} key={entry.lpId}>
            <span className="mk-provider">
              <span className="mk-name">{entry.name}</span>
              {entry.bestRate && <span className="mk-best-tag">BEST RATE</span>}
            </span>
            <span className="num mk-avail">{formatSats(entry.availableSats)}</span>
            <span className="num mk-rate">{rateLabel(entry)}</span>
            <span className="num mk-dim">
              {formatSats(entry.minSats)} — {formatSats(entry.maxSats)}
            </span>
            <span className="num mk-dim">{formatEstimate(entry.estSeconds)}</span>
          </div>
        ))}
        <p className="mk-blended">
          Large swaps route across several providers automatically — you always get the blended
          best rate.
        </p>
      </div>
    </>
  );
}
