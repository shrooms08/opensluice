import { useEffect, useRef } from "react";
import { arrivalCopy } from "../shared/confirmations";
import { Countdown, useNow } from "../shared/Countdown";
import { formatFeePct, formatSats } from "../shared/format";
import type { Quote, SwapDirection } from "../shared/types";

/** Everything the live quote panel can show. Exported for render tests. */
export type QuotePanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "quote"; quote: Quote; note: string | null }
  | { kind: "insufficient"; maxRoutableSats: string }
  | { kind: "below_min"; minSats: string };

const QUOTE_TTL_MS = 60_000;

/**
 * Split legs share ONE hue, stepped down — a split is one orange quantity
 * divided, not three providers competing for attention.
 */
const LEG_STEPS = [
  "var(--ot-accent)",
  "var(--ot-accent-step-2)",
  "var(--ot-accent-step-3)",
] as const;

export type ReceiveDelta =
  | { kind: "same" }
  | { kind: "more" | "less"; sats: string };

/**
 * Honest requote arithmetic: what the fresh quote pays versus what the one it
 * replaced would have. Exported pure so the copy is testable in both
 * directions without driving a re-quote.
 */
export function receiveDelta(previousSats: string, nextSats: string): ReceiveDelta {
  const diff = BigInt(nextSats) - BigInt(previousSats);
  if (diff === 0n) return { kind: "same" };
  return { kind: diff > 0n ? "more" : "less", sats: (diff < 0n ? -diff : diff).toString() };
}

function deltaSentence(delta: ReceiveDelta): string | null {
  if (delta.kind === "same") return null;
  return `You'd now receive ${formatSats(delta.sats)} sats ${delta.kind}.`;
}

export interface QuotePanelProps {
  state: QuotePanelState;
  direction: SwapDirection;
  /** Called once when the shown quote's 60s window runs out (auto-refresh). */
  onExpired?: (quoteId: string) => void;
  /**
   * Receive total of the quote this one replaced, when the panel is showing an
   * auto-requote. Drives the honest delta line; null on a first quote.
   */
  previousReceiveSats?: string | null;
  /** One-tap fallback on the liquidity ceiling: quote the routable maximum. */
  onUseAmount?: (sats: string) => void;
}

/**
 * THE screen that answers "clear fee, timing, and liquidity availability":
 * receive hero, fee in sats + effective %, the arrival promise, and the route
 * — one quiet row for a single LP, a proportional bar plus stacked rows for a
 * split — with the 60s countdown bar driving auto-refresh.
 */
export function QuotePanel({
  state,
  direction,
  onExpired,
  previousReceiveSats,
  onUseAmount,
}: QuotePanelProps) {
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

  // Amber, never red: a limit is not a failure — nothing was attempted.
  if (state.kind === "below_min") {
    return (
      <div className="qp qp-limit" role="alert">
        Minimum swap is <span className="mono strong">{formatSats(state.minSats)} sats</span> right
        now.
      </div>
    );
  }

  if (state.kind === "insufficient") {
    const max = state.maxRoutableSats;
    if (BigInt(max) === 0n) {
      return (
        <div className="qp qp-limit" role="alert">
          No liquidity available in this direction right now. Try again shortly.
        </div>
      );
    }
    return (
      <div className="qp qp-limit" role="alert">
        Up to <span className="mono strong">{formatSats(max)} sats</span> available right now. More
        liquidity usually arrives within the hour.
        {onUseAmount && (
          <button type="button" className="btn-secondary qp-fallback" onClick={() => onUseAmount(max)}>
            Swap {formatSats(max)} instead
          </button>
        )}
      </div>
    );
  }

  const q = state.quote;
  const split = q.legs.length > 1;
  const total = BigInt(q.amountSats);
  const delta =
    previousReceiveSats != null
      ? deltaSentence(receiveDelta(previousReceiveSats, q.totalReceiveSats))
      : null;

  return (
    <div className="qp qp-live" aria-live="polite">
      {(state.note || delta) && (
        <div className="qp-note" role="status">
          {[state.note, delta].filter(Boolean).join(" ")}
        </div>
      )}

      <div className="qp-receive-label">You receive</div>
      <div className="qp-hero">
        <span className="mono">{formatSats(q.totalReceiveSats)}</span>{" "}
        <span className="qp-hero-unit">sats</span>
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
          <span>Arrives</span>
          <span className="mono">{arrivalCopy(direction)}</span>
        </div>
      </div>

      <div className="qp-route">
        {split ? (
          <>
            <div className="qp-route-head">
              <span className="qp-route-caption">Routed across {q.legs.length} providers</span>
              <span className="qp-route-why">for the best rate</span>
            </div>
            <div className="qp-split-bar">
              {q.legs.map((leg, i) => (
                <div
                  key={leg.lpId}
                  className="qp-split-seg"
                  style={{
                    width: `${(Number(BigInt(leg.amountSats) * 1000n / total) / 10).toFixed(1)}%`,
                    background: LEG_STEPS[i] ?? LEG_STEPS[LEG_STEPS.length - 1],
                  }}
                />
              ))}
            </div>
            {q.legs.map((leg, i) => (
              <div className="qp-route-row" key={leg.lpId}>
                <span className="qp-route-lp">
                  <span
                    className="qp-leg-dot"
                    style={{ background: LEG_STEPS[i] ?? LEG_STEPS[LEG_STEPS.length - 1] }}
                  />
                  {leg.lpName}
                </span>
                <span className="mono qp-route-fee">
                  {formatSats(leg.amountSats)} · {formatSats(leg.feeSats)} sats
                </span>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="qp-route-caption is-quiet">Route</div>
            <div className="qp-route-row">
              <span className="qp-route-lp">{q.legs[0]!.lpName}</span>
              <span className="mono qp-route-fee">
                {formatSats(q.legs[0]!.amountSats)} sats · {formatSats(q.legs[0]!.feeSats)} sats fee
              </span>
            </div>
          </>
        )}
      </div>

      <div className="qp-count">
        <Countdown
          expiresAt={q.expiresAt}
          createdAt={q.expiresAt - QUOTE_TTL_MS}
          label="Rate held for you"
          urgentBelowMs={10_000}
        />
      </div>
    </div>
  );
}
