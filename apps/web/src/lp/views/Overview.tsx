import { useState } from "react";
import { formatSats } from "../../shared/format";
import type { LpBalances, LpEarnings, LpMe } from "../../shared/types";
import { api } from "../api";
import { usePolling } from "../usePolling";

export function Overview() {
  const [me, setMe] = useState<LpMe | null>(null);
  const [balances, setBalances] = useState<LpBalances | null>(null);
  const [earnings, setEarnings] = useState<LpEarnings | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePolling(async () => {
    try {
      const [m, b, e] = await Promise.all([api.me(), api.balances(), api.earnings({ limit: 1 })]);
      setMe(m);
      setBalances(b);
      setEarnings(e);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return <OverviewView me={me} balances={balances} earnings={earnings} error={error} />;
}

/** Percent locked/capacity for a utilization bar; capacity 0 reads as 0%. */
export function utilizationPct(lockedSats: string, capacitySats: string): number {
  const capacity = BigInt(capacitySats);
  if (capacity === 0n) return 0;
  const pct = Number((BigInt(lockedSats) * 1000n) / capacity) / 10;
  return Math.min(100, pct);
}

/** Near cap is a prompt to add liquidity, not an error — so amber, not red. */
const NEAR_CAP_PCT = 85;

export function OverviewView({
  me,
  balances,
  earnings,
  error,
}: {
  me: LpMe | null;
  balances: LpBalances | null;
  earnings: LpEarnings | null;
  error?: string | null;
}) {
  const totalFees = earnings?.totalFeesSats ?? "0";
  const hasEarned = totalFees !== "0";

  const utilization = [
    {
      key: "swap_in" as const,
      label: "Utilization · on-chain → instant",
      locked: balances?.locked.swapIn ?? "0",
      capacity: me?.liquidity.swapIn?.capacitySats ?? null,
    },
    {
      key: "swap_out" as const,
      label: "Utilization · instant → on-chain",
      locked: balances?.locked.swapOut ?? "0",
      capacity: me?.liquidity.swapOut?.capacitySats ?? null,
    },
  ];

  const quoting = Boolean(me?.status === "active" && (me.liquidity.swapIn || me.liquidity.swapOut));

  return (
    <div className="view">
      <div className="view-head">
        <h1 className="view-title">Overview</h1>
        {me && (
          <span className={quoting ? "live-chip is-green" : "live-chip is-static"}>
            <span className="dot" />
            {me.status === "paused"
              ? "paused — not quoting"
              : quoting
                ? "quoting live in the book"
                : "no offer published"}
          </span>
        )}
      </div>

      {error && <p className="banner-error">{error}</p>}

      <div className="lp-hero-grid">
        {/* The earned-orange rule: solid orange because it is > 0, dark at zero. */}
        <div className={hasEarned ? "hero-card is-orange" : "hero-card is-dark is-zero"}>
          <div className="hero-label">Fees earned · lifetime</div>
          <div className="hero-value">
            {earnings ? formatSats(totalFees) : "—"} <span className="unit">sats</span>
          </div>
          {hasEarned ? (
            <div className="hero-sub">
              {earnings!.total} {earnings!.total === 1 ? "leg" : "legs"} served · booked in your
              ledger
            </div>
          ) : (
            <div className="hero-sub is-prose">
              Nothing earned yet — the card turns orange with your first settled leg.
            </div>
          )}
        </div>

        <div className="hero-card is-dark">
          <div className="hero-label">Off-chain ledger</div>
          <div className="hero-value is-sm">
            {balances ? formatSats(balances.offchainSats) : "—"} <span className="unit">sats</span>
          </div>
          <div className="hero-sub">
            {balances && balances.locked.swapIn !== "0"
              ? `${formatSats(balances.locked.swapIn)} locked in vault commitments`
              : "instant side · quotable"}
          </div>
        </div>

        <div className="hero-card is-dark">
          <div className="hero-label">On-chain</div>
          <div className="hero-value is-sm">
            {balances ? formatSats(balances.onchainSats) : "—"} <span className="unit">sats</span>
          </div>
          <div className="hero-sub">
            {balances && balances.locked.swapOut !== "0"
              ? `${formatSats(balances.locked.swapOut)} locked against in-flight swap-outs`
              : "settled · fronts swap-outs"}
          </div>
        </div>
      </div>

      <div className="util-grid">
        {utilization.map((u) => {
          const pct = u.capacity === null ? 0 : utilizationPct(u.locked, u.capacity);
          const nearCap = pct >= NEAR_CAP_PCT;
          return (
            <div className="util-card" key={u.key}>
              <div className="util-head">
                <span className="util-label">{u.label}</span>
                <span className={nearCap ? "util-pct is-amber" : "util-pct"}>
                  {u.capacity === null ? "—" : `${pct.toFixed(0)}%`}
                </span>
              </div>
              <div className="util-track">
                <div
                  className={nearCap ? "util-fill is-amber" : "util-fill"}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="util-foot mono">
                {u.capacity === null ? (
                  <span>no offer published</span>
                ) : (
                  <>
                    <span>{formatSats(u.locked)} locked in-flight</span>
                    <span>
                      capacity {formatSats(u.capacity)}
                      {nearCap ? " · near cap" : ""}
                    </span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
