import { useEffect, useRef } from "react";
import { Countdown, useNow } from "../shared/Countdown";
import { formatEstimate, formatFeePct, formatSats } from "../shared/format";
import type { Quote, SwapDirection } from "../shared/types";

/** Everything the live quote panel can show. Exported for render tests. */
export type QuotePanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "quote"; quote: Quote; note: string | null }
  | { kind: "insufficient"; maxRoutableSats: string }
  | { kind: "below_min"; minSats: string };

const QUOTE_TTL_MS = 60_000;

export interface QuotePanelProps {
  state: QuotePanelState;
  direction: SwapDirection;
  /** Called once when the shown quote's 60s window runs out (auto-refresh). */
  onExpired?: (quoteId: string) => void;
}

/**
 * THE screen that answers "clear fee, timing, and liquidity availability":
 * receive hero, fee in sats + effective %, honest time estimate, and the
 * route — one quiet row for a single LP, stacked rows under a caption for a
 * split — with the 60s countdown bar driving auto-refresh.
 */
export function QuotePanel({ state, direction, onExpired }: QuotePanelProps) {
  const now = useNow();
  const expiredFired = useRef<string | null>(null);

  const quote = state.kind === "quote" ? state.quote : null;
  useEffect(() => {
    if (!quote || !onExpired) return;
    if (now < quote.expiresAt) return;
    if (expiredFired.current === quote.quoteId) return;
    expiredFired.current = quote.quoteId;
    onExpired(quote.quoteId);
  }, [now, quote, onExpired]);

  if (state.kind === "idle") {
    return (
      <div className="qp qp-idle">
        <span>Enter an amount to see the live rate</span>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="qp qp-idle" aria-busy="true">
        <div className="ot-spinner is-small" />
        <span>Finding the best route…</span>
      </div>
    );
  }

  if (state.kind === "below_min") {
    return (
      <div className="qp qp-error" role="alert">
        Minimum swap is <span className="mono strong">{formatSats(state.minSats)} sats</span> right
        now.
      </div>
    );
  }

  if (state.kind === "insufficient") {
    const max = state.maxRoutableSats;
    return (
      <div className="qp qp-error" role="alert">
        {BigInt(max) > 0n ? (
          <>
            Not enough liquidity for that amount — up to{" "}
            <span className="mono strong">{formatSats(max)} sats</span> available right now.
          </>
        ) : (
          <>No liquidity available in this direction right now. Try again shortly.</>
        )}
      </div>
    );
  }

  const q = state.quote;
  const split = q.legs.length > 1;
  const receiveLabel = direction === "swap_in" ? "You receive (balance)" : "You receive (on-chain)";

  return (
    <div className="qp qp-live" aria-live="polite">
      {state.note && <div className="qp-note">{state.note}</div>}
      <div className="qp-receive">
        <div className="qp-receive-label">{receiveLabel}</div>
        <div className="qp-hero mono">{formatSats(q.totalReceiveSats)}</div>
        <div className="qp-hero-unit">sats</div>
      </div>
      <div className="qp-rows">
        <div className="qp-row">
          <span>You send</span>
          <span className="mono">{formatSats(q.amountSats)} sats</span>
        </div>
        <div className="qp-row">
          <span>Total fee</span>
          <span className="mono">
            {formatSats(q.totalFeeSats)} sats · {formatFeePct(q.totalFeeSats, q.amountSats)}
          </span>
        </div>
        <div className="qp-row">
          <span>Estimated time</span>
          <span className="mono">{formatEstimate(q.estSeconds)}</span>
        </div>
      </div>
      <div className="qp-route">
        {split ? (
          <>
            <div className="qp-route-caption">
              Routed across {q.legs.length} providers for the best rate
            </div>
            {q.legs.map((leg) => (
              <div className="qp-route-row" key={leg.lpId}>
                <span className="qp-route-lp">{leg.lpName}</span>
                <span className="mono">{formatSats(leg.amountSats)} sats</span>
                <span className="mono qp-route-fee">fee {formatSats(leg.feeSats)}</span>
              </div>
            ))}
          </>
        ) : (
          <div className="qp-route-row is-single">
            <span className="qp-route-lp">via {q.legs[0]!.lpName}</span>
            <span className="mono qp-route-fee">fee {formatSats(q.legs[0]!.feeSats)} sats</span>
          </div>
        )}
      </div>
      <div className="qp-count">
        <Countdown
          expiresAt={q.expiresAt}
          createdAt={q.expiresAt - QUOTE_TTL_MS}
          label="Rate locked for"
          urgentBelowMs={10_000}
        />
      </div>
    </div>
  );
}
