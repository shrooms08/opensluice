import { CopyButton } from "../shared/CopyButton";
import { Countdown } from "../shared/Countdown";
import {
  buildPaymentUri,
  formatBtc,
  formatFeePct,
  formatSats,
  truncateAddress,
  truncateId,
} from "../shared/format";
import { Qr } from "../shared/Qr";
import type { PublicSwap, PublicSwapLeg } from "../shared/types";

export type ProgressViewState =
  | "loading"
  | "notfound"
  | "awaiting"
  | "settling"
  | "completed"
  | "expired"
  | "partial"
  | "failed";

export function deriveView(swap: PublicSwap | null, notFound: boolean): ProgressViewState {
  if (notFound) return "notfound";
  if (!swap) return "loading";
  switch (swap.status) {
    case "pending":
    case "funding":
      return "awaiting";
    case "settling":
      return "settling";
    case "completed":
      return "completed";
    case "expired":
      return "expired";
    case "partially_funded":
      return "partial";
    case "failed":
      return "failed";
  }
}

interface Chip {
  label: string;
  tone: "gray" | "amber" | "green" | "red";
}

const MOCK_CONFIRMATION_TARGET = 3;

/**
 * Plain words only: confirmations get counted, never explained in
 * block-science terms. "timelock"/"vault" are banned on this surface.
 */
export function legChip(leg: PublicSwapLeg): Chip {
  const confirming = (fallback: string): string => {
    if (leg.confirmations !== null && leg.confirmations >= 1) {
      const n = Math.min(leg.confirmations, MOCK_CONFIRMATION_TARGET);
      return `CONFIRMING (${n}/${MOCK_CONFIRMATION_TARGET})`;
    }
    return fallback;
  };
  switch (leg.status) {
    case "pending":
      return { label: "WAITING", tone: "gray" };
    case "seen":
      return { label: confirming("SEEN"), tone: "amber" };
    case "confirmed":
      return { label: "CONFIRMED", tone: "green" };
    case "committed":
      return { label: "RECEIVED", tone: "green" };
    case "broadcasting":
      return { label: confirming("SENDING"), tone: "amber" };
    case "settled":
      return { label: "SETTLED", tone: "green" };
    case "failed":
      return { label: "FAILED", tone: "red" };
    case "expired":
      return { label: "EXPIRED", tone: "gray" };
  }
}

export interface ProgressViewProps {
  swap: PublicSwap | null;
  notFound: boolean;
  onPayLeg?: (index: number) => void;
  payingLeg?: number | null;
}

export function ProgressView({ swap, notFound, onPayLeg, payingLeg }: ProgressViewProps) {
  const view = deriveView(swap, notFound);

  if (view === "notfound") {
    return (
      <div className="pg-empty">
        <div className="pg-empty-mark">OpenSluice</div>
        <div className="pg-empty-title">Not found</div>
        <div className="pg-empty-sub">
          Check the link — swaps are only
          <br />
          reachable by their exact address.
        </div>
      </div>
    );
  }

  if (view === "loading") {
    return (
      <div className="pg-loading">
        <div className="ot-spinner" />
        <span>LOADING</span>
      </div>
    );
  }

  const s = swap!;
  switch (view) {
    case "awaiting":
    case "settling":
      return <LiveSwap swap={s} view={view} onPayLeg={onPayLeg} payingLeg={payingLeg} />;
    case "completed":
      return <Completed swap={s} />;
    case "expired":
      return <Expired swap={s} />;
    case "partial":
      return <PartiallyFunded swap={s} />;
    case "failed":
      return <Failed swap={s} />;
  }
}

function ReceiveHeader({ swap, chipLabel, tone }: { swap: PublicSwap; chipLabel: string; tone: "live" | "green" }) {
  return (
    <header className="pg-head">
      <div>
        <div className="pg-receive-label">You receive</div>
        <div className="pg-receive mono">
          {formatSats(swap.totalReceiveSats)} <span className="unit">sats</span>
        </div>
        <div className="pg-dest mono" title={swap.destination}>
          → {truncateAddress(swap.destination)}
        </div>
      </div>
      {tone === "live" ? (
        <span className="live-chip">
          <span className="dot" />
          {chipLabel}
        </span>
      ) : (
        <span className="live-chip is-green">
          <span className="dot" />
          {chipLabel}
        </span>
      )}
    </header>
  );
}

function LiveSwap({
  swap,
  view,
  onPayLeg,
  payingLeg,
}: {
  swap: PublicSwap;
  view: "awaiting" | "settling";
  onPayLeg?: (index: number) => void;
  payingLeg?: number | null;
}) {
  const multi = swap.legs.length > 1;
  return (
    <div className="pg-card">
      <ReceiveHeader
        swap={swap}
        chipLabel={view === "awaiting" ? "AWAITING PAYMENT" : "FINALIZING"}
        tone={view === "awaiting" ? "live" : "green"}
      />
      {view === "awaiting" && (
        <>
          {multi && (
            <div className="pg-multi-note">
              Your swap is routed across {swap.legs.length} providers — pay each part below to the
              exact amount.
            </div>
          )}
          <div className="pg-count">
            <Countdown expiresAt={swap.expiresAt} createdAt={swap.createdAt} label="Pay within" />
          </div>
        </>
      )}
      <div className="pg-legs">
        {swap.legs.map((leg) => (
          <LegCard
            key={leg.index}
            swap={swap}
            leg={leg}
            compactQr={multi}
            onPayLeg={onPayLeg}
            paying={payingLeg === leg.index}
          />
        ))}
      </div>
      <Foot swap={swap} />
    </div>
  );
}

function LegCard({
  swap,
  leg,
  compactQr,
  onPayLeg,
  paying,
}: {
  swap: PublicSwap;
  leg: PublicSwapLeg;
  compactQr: boolean;
  onPayLeg?: (index: number) => void;
  paying: boolean;
}) {
  const chip = legChip(leg);
  const showInstructions = leg.status === "pending";
  const showDev = swap.devSimulate && showInstructions && Boolean(onPayLeg);

  return (
    <section className="leg-card">
      <div className="leg-head">
        <span className="leg-title">
          {swap.legs.length > 1 ? `Part ${leg.index + 1} · ` : ""}
          <span className="mono">{formatSats(leg.amountSats)} sats</span>
        </span>
        <span className={`status-chip is-${chip.tone}`}>{chip.label}</span>
      </div>

      {showInstructions && (
        <>
          <div className="leg-qr">
            <Qr
              value={buildPaymentUri(leg.payChain, leg.payTo, leg.amountSats)}
              size={compactQr ? "compact" : "default"}
            />
          </div>
          <div className="leg-hint">
            Send exactly <span className="mono strong">{formatSats(leg.amountSats)} sats</span>{" "}
            {leg.payChain === "onchain" ? "on-chain" : "from your balance"} to:
          </div>
          <div className="leg-addr">
            <span className="leg-addr-text mono">{leg.payTo}</span>
            <CopyButton text={leg.payTo} />
          </div>
          {showDev && (
            <button
              type="button"
              className="dev-btn leg-dev"
              disabled={paying}
              onClick={() => onPayLeg?.(leg.index)}
            >
              <span className="dev-chip">DEV</span>
              {paying ? "Simulating…" : "Simulate this payment"}
            </button>
          )}
        </>
      )}

      {!showInstructions && (
        <div className="leg-refs mono">
          {leg.status === "seen" && leg.payChain === "onchain" && (
            <span>Payment received — waiting for the network to confirm.</span>
          )}
          {leg.payoutTxId && (
            <span className="leg-ref">
              payout {truncateId(leg.payoutTxId)} <CopyButton text={leg.payoutTxId} />
            </span>
          )}
          {leg.payoutTransferId && (
            <span className="leg-ref">
              transfer {truncateId(leg.payoutTransferId)} <CopyButton text={leg.payoutTransferId} />
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Completed({ swap }: { swap: PublicSwap }) {
  return (
    <div className="pg-card is-settled">
      <header className="pg-head">
        <span className="pg-done-label">SWAP COMPLETE</span>
      </header>
      <div className="pg-settle">
        <div className="pg-mega">Swapped</div>
        <div className="pg-settle-amt mono">
          {formatSats(swap.totalReceiveSats)} <span className="unit">sats</span>
        </div>
        <div className="pg-settle-btc mono">{formatBtc(swap.totalReceiveSats)} BTC</div>
        <div className="pg-dest mono">→ {truncateAddress(swap.destination)}</div>
      </div>
      <div className="pg-rows">
        <div className="row">
          <span>Total fee</span>
          <span className="value">
            {formatSats(swap.totalFeeSats)} sats · {formatFeePct(swap.totalFeeSats, swap.amountSats)}
          </span>
        </div>
        {swap.legs.map((leg) => {
          const ref = leg.payoutTxId ?? leg.payoutTransferId;
          if (!ref) return null;
          return (
            <div className="row" key={leg.index}>
              <span>
                {swap.legs.length > 1 ? `Part ${leg.index + 1} ` : ""}
                {leg.payoutTxId ? "payout tx" : "transfer"}
              </span>
              <span className="value pg-ref">
                {truncateId(ref)} <CopyButton text={ref} />
              </span>
            </div>
          );
        })}
      </div>
      <a className="btn-secondary pg-again" href="/">
        New swap
      </a>
      <Foot swap={swap} />
    </div>
  );
}

function Expired({ swap }: { swap: PublicSwap }) {
  return (
    <div className="pg-card is-quiet">
      <header className="pg-head">
        <span className="status-chip is-gray">EXPIRED</span>
      </header>
      <div className="pg-expired-hero">Expired</div>
      <div className="pg-struck mono">{formatSats(swap.amountSats)} sats</div>
      <div className="pg-note-text">
        No payment arrived within the window, so nothing moved and the rate was released. Start a
        new swap whenever you're ready.
      </div>
      <a className="btn-secondary pg-again" href="/">
        New swap
      </a>
      <Foot swap={swap} />
    </div>
  );
}

function PartiallyFunded({ swap }: { swap: PublicSwap }) {
  const paid = swap.legs.filter((l) => l.status !== "expired" && l.status !== "pending");
  return (
    <div className="pg-card">
      <header className="pg-head">
        <span className="status-chip is-amber">NEEDS ATTENTION</span>
      </header>
      <div className="pg-partial-hero">Partly received</div>
      <div className="well-amber pg-partial-well">
        Part of your payment arrived after the window closed. Your sats are safe — contact the
        operator with this swap id to settle or refund.
      </div>
      <div className="pg-rows">
        {swap.legs.map((leg) => (
          <div className="row" key={leg.index}>
            <span>
              Part {leg.index + 1} · {formatSats(leg.amountSats)} sats
            </span>
            <span className="value">{legChip(leg).label}</span>
          </div>
        ))}
        {paid.length === 0 && (
          <div className="row">
            <span>Received</span>
            <span className="value">nothing credited yet</span>
          </div>
        )}
      </div>
      <Foot swap={swap} />
    </div>
  );
}

function Failed({ swap }: { swap: PublicSwap }) {
  return (
    <div className="pg-card">
      <header className="pg-head">
        <span className="status-chip is-red">FAILED</span>
      </header>
      <div className="pg-failed-hero">Swap failed</div>
      <div className="well-red pg-failed-well">
        Something went wrong finishing this swap after your payment arrived. Your sats are
        accounted for — contact the operator with this swap id to resolve it.
      </div>
      <div className="pg-rows">
        {swap.legs.map((leg) => (
          <div className="row" key={leg.index}>
            <span>
              Part {leg.index + 1} · {formatSats(leg.amountSats)} sats
            </span>
            <span className="value">{legChip(leg).label}</span>
          </div>
        ))}
      </div>
      <Foot swap={swap} />
    </div>
  );
}

function Foot({ swap }: { swap: PublicSwap }) {
  return (
    <div className="pg-foot mono">
      <span>{truncateId(swap.id)}</span>
      <span>OpenSluice</span>
    </div>
  );
}
