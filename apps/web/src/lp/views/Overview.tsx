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

  return (
    <OverviewView
      me={me}
      balances={balances}
      earnings={earnings}
      error={error}
    />
  );
}

/** Percent locked/capacity for a utilization line; capacity 0 reads as 0%. */
function utilizationPct(lockedSats: string, capacitySats: string): number {
  const capacity = BigInt(capacitySats);
  if (capacity === 0n) return 0;
  const pct = Number((BigInt(lockedSats) * 1000n) / capacity) / 10;
  return Math.min(100, pct);
}

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
      label: "Swap-in",
      locked: balances?.locked.swapIn ?? "0",
      capacity: me?.liquidity.swapIn?.capacitySats ?? null,
    },
    {
      key: "swap_out" as const,
      label: "Swap-out",
      locked: balances?.locked.swapOut ?? "0",
      capacity: me?.liquidity.swapOut?.capacitySats ?? null,
    },
  ];

  return (
    <div className="view">
      <div className="view-head">
        <h1 className="view-title">{me ? me.name : "Overview"}</h1>
        {me?.status === "paused" && <span className="pill pill-solid-failed">paused</span>}
      </div>

      {error && <p className="banner-error">{error}</p>}

      {/* The earned-orange rule: the hero goes orange only once fees exist. */}
      <div className={hasEarned ? "hero-card is-orange" : "hero-card is-dark is-zero"}>
        <div className="hero-label">Fees earned · lifetime</div>
        <div className="hero-value">
          {earnings ? formatSats(totalFees) : "—"} <span className="unit">sats</span>
        </div>
        {hasEarned ? (
          <div className="hero-sub">
            across {earnings!.total} settled {earnings!.total === 1 ? "leg" : "legs"} · booked in
            your ledger
          </div>
        ) : (
          <div className="hero-sub is-prose">
            Nothing earned yet — the card turns orange with your first settled leg.
          </div>
        )}
      </div>

      {/* Two-figure balance treatment: hero figure per chain, locked as the
          secondary line. Off-chain is the LP's Tachi vault balance — the side
          that fronts swap-ins and carries the timelock exposure. */}
      <div className="bal-grid">
        <div className="stat-card">
          <p className="stat-label">On-chain balance</p>
          <p className="stat-value big">
            {balances ? formatSats(balances.onchainSats) : "—"} <span className="stat-unit">sats</span>
          </p>
          <p className="stat-sub">
            {balances && balances.locked.swapOut !== "0"
              ? `${formatSats(balances.locked.swapOut)} sats locked by in-flight swap-outs`
              : "fronts swap-outs · nothing locked"}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Off-chain balance · Tachi vault</p>
          <p className="stat-value big">
            {balances ? formatSats(balances.offchainSats) : "—"} <span className="stat-unit">sats</span>
          </p>
          <p className="stat-sub">
            {balances && balances.locked.swapIn !== "0"
              ? `${formatSats(balances.locked.swapIn)} sats locked by in-flight swap-ins`
              : "fronts swap-ins · nothing locked"}
          </p>
        </div>
      </div>

      <section className="util">
        <div className="util-caption">Utilization · locked / declared capacity</div>
        {utilization.map((u) => (
          <div className="util-row" key={u.key}>
            <span className="util-dir">{u.label}</span>
            {u.capacity === null ? (
              <span className="util-facts mono is-empty">no offer published</span>
            ) : (
              <>
                <div className="util-track">
                  <div
                    className="util-fill"
                    style={{ width: `${utilizationPct(u.locked, u.capacity)}%` }}
                  />
                </div>
                <span className="util-facts mono">
                  {formatSats(u.locked)} / {formatSats(u.capacity)} sats ·{" "}
                  {utilizationPct(u.locked, u.capacity).toFixed(1)}%
                </span>
              </>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
