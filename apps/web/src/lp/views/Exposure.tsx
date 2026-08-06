import { useState } from "react";
import { formatSats } from "../../shared/format";
import type { LpExposure } from "../../shared/types";
import { api } from "../api";
import { directionLabel, EmptyState, formatAge, LegStatusPill } from "../components";
import { usePolling } from "../usePolling";

export function Exposure() {
  const [exposure, setExposure] = useState<LpExposure | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePolling(async () => {
    try {
      setExposure(await api.exposure());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="view">
      <div className="view-head">
        <h1 className="view-title">Exposure</h1>
        {exposure && exposure.rows.length > 0 && (
          <span className="view-fact mono">
            {formatSats(exposure.totalLockedSats)} sats locked in flight
          </span>
        )}
      </div>
      {error && <p className="banner-error">{error}</p>}
      <ExposureView exposure={exposure} />
    </div>
  );
}

export function ExposureView({ exposure }: { exposure: LpExposure | null }) {
  if (exposure === null) {
    return (
      <div className="skel-rows">
        <div className="skel" style={{ width: "40%" }} />
        <div className="skel" style={{ width: "85%" }} />
      </div>
    );
  }

  return (
    <section className="sheet">
      <div className="sheet-head">
        <h2 className="sheet-title">In-flight legs</h2>
      </div>
      {exposure.rows.length === 0 ? (
        <EmptyState title="No open exposure">
          No open exposure — your capital is idle.
        </EmptyState>
      ) : (
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Swap</th>
                <th>Direction</th>
                <th className="num">Locked</th>
                <th>Status</th>
                <th className="num">Age</th>
              </tr>
            </thead>
            <tbody>
              {exposure.rows.map((row) => (
                <tr key={`${row.swapRef}-${row.createdAt}-${row.amountSats}`}>
                  <td className="mono dim">{row.swapRef}</td>
                  <td>{directionLabel(row.direction)}</td>
                  <td className="num">{formatSats(row.amountSats)}</td>
                  <td>
                    <LegStatusPill status={row.status} confirmations={row.confirmations} />
                  </td>
                  <td className="num dim">{formatAge(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
