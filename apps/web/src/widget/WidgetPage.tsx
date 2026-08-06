import { useCallback, useEffect, useRef, useState } from "react";
import { Wordmark } from "../App";
import { formatBtc, formatSats } from "../shared/format";
import type { Limits, Marketplace, Quote, SwapDirection } from "../shared/types";
import { MarketplaceStrip } from "./MarketplaceStrip";
import { QuotePanel, type QuotePanelState } from "./QuotePanel";

const DEBOUNCE_MS = 400;

interface DirectionCard {
  value: SwapDirection;
  title: string;
  sub: string;
}

/** Plain-language cards — the words for what the network actually does. */
const DIRECTIONS: DirectionCard[] = [
  {
    value: "swap_in",
    title: "On-chain → Instant balance",
    sub: "Send Bitcoin, get balance that spends in seconds",
  },
  {
    value: "swap_out",
    title: "Balance → On-chain",
    sub: "Send balance, get Bitcoin back on-chain",
  },
];

export function WidgetPage() {
  const [direction, setDirection] = useState<SwapDirection>("swap_in");
  const [amountRaw, setAmountRaw] = useState("");
  const [destination, setDestination] = useState("");
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [market, setMarket] = useState<Marketplace | null>(null);
  const [quoteState, setQuoteState] = useState<QuotePanelState>({ kind: "idle" });
  const [accepting, setAccepting] = useState(false);
  // Bumping the nonce forces a re-quote (expiry, 409s); the note rides along.
  const [requote, setRequote] = useState<{ nonce: number; note: string | null }>({
    nonce: 0,
    note: null,
  });
  const quoteRun = useRef(0);

  const refreshBook = useCallback(async () => {
    try {
      const [limitsRes, marketRes] = await Promise.all([
        fetch("/api/limits"),
        fetch("/api/marketplace"),
      ]);
      if (limitsRes.ok) setLimits((await limitsRes.json()) as Limits);
      if (marketRes.ok) setMarket((await marketRes.json()) as Marketplace);
    } catch {
      /* the widget still works; quoting reports liquidity problems itself */
    }
  }, []);

  useEffect(() => {
    void refreshBook();
  }, [refreshBook]);

  const dirLimits = limits ? (direction === "swap_in" ? limits.swapIn : limits.swapOut) : null;

  // Debounced live quoting. Client-side bounds first, then the router decides.
  useEffect(() => {
    const run = ++quoteRun.current;
    if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) === 0n) {
      setQuoteState({ kind: "idle" });
      return;
    }
    if (dirLimits && BigInt(dirLimits.minSats) > 0n && BigInt(amountRaw) < BigInt(dirLimits.minSats)) {
      setQuoteState({ kind: "below_min", minSats: dirLimits.minSats });
      return;
    }
    setQuoteState({ kind: "loading" });

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch("/api/quotes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ direction, amountSats: amountRaw }),
          });
          if (quoteRun.current !== run) return; // stale response
          if (res.status === 201) {
            const quote = (await res.json()) as Quote;
            setQuoteState({ kind: "quote", quote, note: requote.note });
          } else if (res.status === 409) {
            const body = (await res.json()) as { maxRoutableSats?: string };
            setQuoteState({ kind: "insufficient", maxRoutableSats: body.maxRoutableSats ?? "0" });
          } else {
            setQuoteState({ kind: "insufficient", maxRoutableSats: "0" });
          }
        } catch {
          if (quoteRun.current === run) setQuoteState({ kind: "idle" });
        }
      })();
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // requote.note intentionally read at fetch time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountRaw, direction, dirLimits?.minSats, requote.nonce]);

  const onAmountInput = (value: string) => {
    setAmountRaw(value.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 15));
  };

  const onExpired = useCallback(() => {
    setRequote((r) => ({ nonce: r.nonce + 1, note: null }));
  }, []);

  const accept = async () => {
    if (quoteState.kind !== "quote") return;
    const dest = destination.trim();
    if (!dest) {
      setDestinationError(
        direction === "swap_in"
          ? "Enter the balance address that should receive the funds."
          : "Enter the Bitcoin address that should receive the funds.",
      );
      return;
    }
    setDestinationError(null);
    setAccepting(true);
    try {
      const res = await fetch("/api/swaps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId: quoteState.quote.quoteId, destination: dest }),
      });
      if (res.status === 201) {
        const swap = (await res.json()) as { id: string };
        window.location.assign(`/swap/${swap.id}`);
        return;
      }
      if (res.status === 409) {
        const body = (await res.json()) as { error: string };
        const note =
          body.error === "quote_stale"
            ? "Rates updated — liquidity changed"
            : "Rates updated — the previous quote expired";
        setRequote((r) => ({ nonce: r.nonce + 1, note }));
        void refreshBook();
      }
    } finally {
      setAccepting(false);
    }
  };

  const maxRoutable = dirLimits?.maxRoutableSats ?? "0";
  const canAccept = quoteState.kind === "quote" && !accepting;

  return (
    <div className="wp">
      <header className="wp-head">
        <Wordmark />
        <span className="live-chip is-static">
          <span className="dot" />
          LIVE RATES
        </span>
      </header>

      <main className="wp-main">
        <h1 className="wp-title">Move Bitcoin in and out of instant balance</h1>

        <div className="wp-directions" role="radiogroup" aria-label="Swap direction">
          {DIRECTIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              role="radio"
              aria-checked={direction === d.value}
              className={direction === d.value ? "dir-card is-active" : "dir-card"}
              onClick={() => setDirection(d.value)}
            >
              <span className="dir-title">{d.title}</span>
              <span className="dir-sub">{d.sub}</span>
            </button>
          ))}
        </div>

        <div className="wp-amount">
          <div className="wp-amount-head">
            <label htmlFor="amount">You send</label>
            {BigInt(maxRoutable || "0") > 0n && (
              <button
                type="button"
                className="btn-inverse"
                onClick={() => onAmountInput(maxRoutable)}
              >
                MAX
              </button>
            )}
          </div>
          <input
            id="amount"
            className="wp-amount-input mono"
            inputMode="numeric"
            autoComplete="off"
            placeholder="0"
            value={amountRaw ? formatSats(amountRaw) : ""}
            onChange={(e) => onAmountInput(e.target.value)}
          />
          <div className="wp-amount-btc mono">
            {amountRaw ? `${formatBtc(amountRaw)} BTC` : " "}
          </div>
        </div>

        <QuotePanel state={quoteState} direction={direction} onExpired={onExpired} />

        <div className="wp-dest">
          <label htmlFor="destination">
            {direction === "swap_in" ? "Receive to balance address" : "Receive to Bitcoin address"}
          </label>
          <input
            id="destination"
            className={destinationError ? "ot-input mono is-error" : "ot-input mono"}
            autoComplete="off"
            spellCheck={false}
            placeholder={direction === "swap_in" ? "tachi1p…" : "bc1q…"}
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              if (destinationError) setDestinationError(null);
            }}
          />
          {destinationError && <div className="field-error">{destinationError}</div>}
        </div>

        <button
          type="button"
          className="btn-primary wp-accept"
          disabled={!canAccept}
          onClick={() => void accept()}
        >
          {accepting ? "Locking rate…" : "Get this rate"}
        </button>

        <MarketplaceStrip market={market} />
      </main>

      <footer className="wp-foot mono">
        Rates come from independent liquidity providers · quotes hold for 60 s
      </footer>
    </div>
  );
}
