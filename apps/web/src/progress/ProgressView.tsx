import { confirmingLabel } from "../shared/confirmations";
import { CopyButton } from "../shared/CopyButton";
import { Countdown } from "../shared/Countdown";
import { LogoLockup } from "../shared/Logo";
import {
  buildPaymentUri,
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

/**
 * Plain words only: confirmations get counted, never explained in
 * block-science terms. "timelock"/"vault" are banned on this surface. The
 * count target comes from the shared confirmation constant so this ladder and
 * the quote panel's arrival promise cannot drift apart.
 */
export function legChip(leg: PublicSwapLeg): Chip {
  const confirming = (fallback: string): string =>
    leg.confirmations !== null && leg.confirmations >= 1
      ? confirmingLabel(leg.confirmations)
      : fallback;
  switch (leg.status) {
    case "pending":
      return { label: "WAITING", tone: "gray" };
    case "seen":
      return { label: confirming("PAYMENT SEEN"), tone: "amber" };
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

/** A leg the user has already paid — it no longer needs instructions. */
function isFunded(leg: PublicSwapLeg): boolean {
  return leg.status !== "pending" && leg.status !== "expired";
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
      <div className="pg-card is-centered">
        <div className="pg-ghost-hero">No swap here</div>
        <div className="pg-note-text">
          This link doesn't match any swap. Check the address bar for typos.
        </div>
        <a className="btn-secondary pg-again" href="/">
          Go to OpenSluice
        </a>
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
      return <Funding swap={s} onPayLeg={onPayLeg} payingLeg={payingLeg} />;
    case "settling":
      return <Settling swap={s} />;
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

function CardHead({ swap }: { swap: PublicSwap }) {
  return (
    <header className="pg-head">
      <LogoLockup size={18} />
      <span className="pg-id mono">{truncateId(swap.id)}</span>
    </header>
  );
}

function Funding({
  swap,
  onPayLeg,
  payingLeg,
}: {
  swap: PublicSwap;
  onPayLeg?: (index: number) => void;
  payingLeg?: number | null;
}) {
  const multi = swap.legs.length > 1;
  const funded = swap.legs.filter(isFunded).length;
  // Exactly one card is live at a time: the first part still awaiting payment.
  const liveIndex = swap.legs.findIndex((l) => !isFunded(l));

  return (
    <div className="pg-card">
      <CardHead swap={swap} />

      {multi ? (
        <div className="pg-multi-note">
          {funded === 0
            ? `Your swap is routed across ${swap.legs.length} providers — send each part to its own address. Order doesn't matter.`
            : funded === swap.legs.length - 1
              ? `${funded === 1 ? "One part" : `${funded} parts`} in — one to go.`
              : `${funded} of ${swap.legs.length} parts in.`}
        </div>
      ) : (
        <div className="pg-send-exactly">
          <div className="pg-send-label">SEND EXACTLY</div>
          <div className="pg-send-amount">
            <span className="mono">{formatSats(swap.legs[0]!.amountSats)}</span>{" "}
            <span className="unit">sats</span>
          </div>
        </div>
      )}

      <div className="pg-legs">
        {swap.legs.map((leg) => (
          <LegCard
            key={leg.index}
            swap={swap}
            leg={leg}
            live={leg.index === liveIndex}
            multi={multi}
            onPayLeg={onPayLeg}
            paying={payingLeg === leg.index}
          />
        ))}
      </div>

      <div className="pg-progress-row mono">
        <span>
          {multi ? `${funded} of ${swap.legs.length} parts funded` : "Waiting for your payment"}
        </span>
      </div>
      <div className="pg-count">
        <Countdown
          expiresAt={swap.expiresAt}
          createdAt={swap.createdAt}
          label="Pay within"
          urgentBelowMs={5 * 60 * 1000}
          criticalBelowMs={60 * 1000}
        />
      </div>
    </div>
  );
}

function LegCard({
  swap,
  leg,
  live,
  multi,
  onPayLeg,
  paying,
}: {
  swap: PublicSwap;
  leg: PublicSwapLeg;
  live: boolean;
  multi: boolean;
  onPayLeg?: (index: number) => void;
  paying: boolean;
}) {
  const chip = legChip(leg);
  const showInstructions = leg.status === "pending";
  const showDev = swap.devSimulate && showInstructions && Boolean(onPayLeg);
  const partLabel = multi ? `PART ${leg.index + 1} OF ${swap.legs.length}` : null;

  // Funded parts, and parts queued behind the live one, collapse to a row.
  if (!live) {
    return (
      <section className="leg-row">
        <div>
          {partLabel && <div className="leg-part">{partLabel}</div>}
          <div className="leg-row-amt mono">
            {formatSats(leg.amountSats)} <span className="unit">sats</span>
          </div>
        </div>
        {showInstructions ? (
          <span className="pill-next">UP NEXT</span>
        ) : (
          <span className={`status-chip is-${chip.tone}`}>{chip.label}</span>
        )}
      </section>
    );
  }

  return (
    <section className="leg-card is-live">
      <div className="leg-head">
        {partLabel ? (
          <span className="leg-part is-accent">{partLabel}</span>
        ) : (
          <span className="leg-part is-accent">THIS PAYMENT</span>
        )}
        <span className={`status-chip is-${chip.tone}`}>{chip.label}</span>
      </div>

      {multi && (
        <div className="leg-amount mono">
          {formatSats(leg.amountSats)} <span className="unit">sats</span>
        </div>
      )}

      {showInstructions && (
        <>
          <div className="leg-addr">
            <span className="leg-addr-text mono">{leg.payTo}</span>
            <CopyButton text={leg.payTo} />
          </div>
          <div className="leg-qr">
            <Qr
              value={buildPaymentUri(leg.payChain, leg.payTo, leg.amountSats)}
              size={multi ? "compact" : "default"}
            />
          </div>
          <div className="leg-hint">
            {leg.payChain === "onchain" ? "Send on-chain" : "Send from your balance"} — exact amount
            only.
          </div>
          {showDev && (
            <button
              type="button"
              className="dev-btn leg-dev"
              disabled={paying}
              onClick={() => onPayLeg?.(leg.index)}
            >
              <span className="dev-chip">DEV</span>
              {paying ? "SIMULATING…" : "SIMULATE PAYMENT"}
            </button>
          )}
        </>
      )}

      {!showInstructions && leg.status === "seen" && leg.payChain === "onchain" && (
        <div className="leg-hint">Payment received — waiting for the network to confirm.</div>
      )}
    </section>
  );
}

function Settling({ swap }: { swap: PublicSwap }) {
  return (
    <div className="pg-card is-centered">
      <div className="ot-spinner is-small" />
      <div className="pg-settling-title">Moving your funds…</div>
      <div className="pg-note-text mono">
        {swap.legs.length > 1 ? `All ${swap.legs.length} parts confirmed.` : "Payment confirmed."}
        <br />
        This usually takes a few seconds.
      </div>
    </div>
  );
}

function Completed({ swap }: { swap: PublicSwap }) {
  const refs = swap.legs
    .map((leg) => ({ leg, ref: leg.payoutTxId ?? leg.payoutTransferId }))
    .filter((r): r is { leg: PublicSwapLeg; ref: string } => r.ref !== null);

  return (
    <div className="pg-card is-centered is-settled">
      <div className="pg-money-shot">
        <div className="pg-mega">Swapped</div>
        <div className="pg-settle-amt">
          <span className="mono">{formatSats(swap.totalReceiveSats)}</span>{" "}
          <span className="unit">sats received</span>
        </div>
        <div className="pg-settle-fee mono">
          fee {formatSats(swap.totalFeeSats)} sats ·{" "}
          {formatFeePct(swap.totalFeeSats, swap.amountSats)}
        </div>
        <div className="pg-dest mono">→ {truncateAddress(swap.destination)}</div>
        {refs.length > 0 && (
          <div className="pg-receipt">
            {refs.map(({ leg, ref }) => (
              <div className="pg-receipt-row mono" key={leg.index}>
                <span>{swap.legs.length > 1 ? `Part ${leg.index + 1}` : "Payout"}</span>
                <span className="pg-ref">
                  {truncateId(ref)} <CopyButton text={ref} />
                </span>
              </div>
            ))}
          </div>
        )}
        <a className="btn-primary pg-again" href="/">
          New swap
        </a>
      </div>
    </div>
  );
}

function Expired({ swap }: { swap: PublicSwap }) {
  return (
    <div className="pg-card is-centered">
      <div className="pg-ghost-hero is-quiet">Expired</div>
      <div className="pg-note-text">
        Nothing arrived within 15 minutes, so the rate was released. Nothing left your wallet.
      </div>
      <div className="pg-struck mono">{formatSats(swap.amountSats)} sats</div>
      <a className="btn-primary pg-again" href="/">
        Start a new swap
      </a>
    </div>
  );
}

/**
 * Honest partial-funding copy. The design file offers "Continue with N" and
 * says the paid parts "will be swapped at the quoted rate" — neither is true
 * of this engine: `partially_funded` is terminal, the received sats are booked
 * as stranded credits, and only an operator can resolve them (GAPS.md). We
 * answer "where is my money" truthfully instead of promising a path that does
 * not exist.
 */
function PartiallyFunded({ swap }: { swap: PublicSwap }) {
  const funded = swap.legs.filter(isFunded);
  const missed = swap.legs.filter((l) => !isFunded(l));
  const sum = (legs: PublicSwapLeg[]) =>
    legs.reduce((t, l) => t + BigInt(l.amountSats), 0n).toString();

  return (
    <div className="pg-card">
      <CardHead swap={swap} />
      <span className="pg-terminal-chip is-amber">PARTIALLY FUNDED</span>
      <div className="pg-terminal-title">
        {funded.length} of {swap.legs.length} parts arrived in time
      </div>
      <div className="pg-note-text">
        The window closed before every part arrived, so this swap stopped. What you did send is
        recorded and held — it has not been swapped and has not been lost. Contact the operator
        with the swap id below to have it settled or returned.
      </div>
      <div className="pg-rows">
        <div className="row">
          <span>Received and held</span>
          <span className="value is-green mono">{formatSats(sum(funded))} sats</span>
        </div>
        <div className="row">
          <span>Never sent</span>
          <span className="value is-amber mono">{formatSats(sum(missed))} sats</span>
        </div>
      </div>
      <Foot swap={swap} />
    </div>
  );
}

/**
 * Honest failure copy. The design file promises an automatic refund with a
 * `rfnd_` reference; this engine has no refund path at all — a failed send
 * books the deposit as a stranded credit and flags it for manual resolution
 * (GAPS.md). Telling a user their money is already on its way back would be
 * the one lie this surface must never tell.
 */
function Failed({ swap }: { swap: PublicSwap }) {
  return (
    <div className="pg-card">
      <CardHead swap={swap} />
      <span className="pg-terminal-chip is-red">SWAP FAILED</span>
      <div className="pg-terminal-title">Your funds are accounted for</div>
      <div className="pg-note-text">
        A provider couldn't complete its part after your payment arrived. Every sat you sent is
        recorded against this swap and held — nothing was consumed by the failure. Returning it
        needs a person: contact the operator with the swap id below.
      </div>
      <div className="pg-rows">
        {swap.legs.map((leg) => (
          <div className="row" key={leg.index}>
            <span>
              {swap.legs.length > 1 ? `Part ${leg.index + 1} · ` : ""}
              {formatSats(leg.amountSats)} sats
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
      <span className="pg-ref">
        {truncateId(swap.id)} <CopyButton text={swap.id} />
      </span>
      <a href="/">OpenSluice</a>
    </div>
  );
}
