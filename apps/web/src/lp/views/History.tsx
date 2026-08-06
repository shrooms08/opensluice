import { useState } from "react";
import { formatSats } from "../../shared/format";
import type { LpHistory } from "../../shared/types";
import { api } from "../api";
import { directionLabel, EmptyState, fmtDate, LegStatusPill, Pager } from "../components";
import { usePolling } from "../usePolling";

const PAGE_SIZE = 25;

type Filter = "all" | "settled" | "failed";

export function History() {
  const [history, setHistory] = useState<LpHistory | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  usePolling(async () => {
    try {
      setHistory(
        await api.history({
          status: filter === "all" ? undefined : filter,
          limit: PAGE_SIZE,
          offset,
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [filter, offset]);

  const pickFilter = (next: Filter) => {
    setFilter(next);
    setOffset(0);
  };

  return (
    <div className="view">
      <div className="view-head">
        <h1 className="view-title">History</h1>
      </div>
      {error && <p className="banner-error">{error}</p>}
      <div className="chips">
        {(["all", "settled", "failed"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={filter === f ? "chip is-active" : "chip"}
            onClick={() => pickFilter(f)}
          >
            {f === "all" ? "All" : f === "settled" ? "Settled" : "Failed"}
          </button>
        ))}
      </div>
      <HistoryView history={history} onPage={setOffset} />
    </div>
  );
}

export function HistoryView({
  history,
  onPage,
}: {
  history: LpHistory | null;
  onPage?: (offset: number) => void;
}) {
  if (history === null) {
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
        <h2 className="sheet-title">Closed legs</h2>
      </div>
      {history.rows.length === 0 ? (
        <EmptyState>Settled and failed legs land here, fee by fee.</EmptyState>
      ) : (
        <>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Swap</th>
                  <th>Direction</th>
                  <th className="num">Amount</th>
                  <th className="num">Fee</th>
                  <th>Status</th>
                  <th className="num hide-sm">Closed</th>
                </tr>
              </thead>
              <tbody>
                {history.rows.map((row) => (
                  <tr key={`${row.swapRef}-${row.createdAt}-${row.amountSats}`}>
                    <td className="mono dim">{row.swapRef}</td>
                    <td>{directionLabel(row.direction)}</td>
                    <td className="num">{formatSats(row.amountSats)}</td>
                    <td className={row.status === "settled" ? "num paid-green" : "num dim"}>
                      {row.status === "settled" ? formatSats(row.feeSats) : "—"}
                    </td>
                    <td>
                      <LegStatusPill status={row.status} />
                      {row.needsManualResolution && (
                        <span className="late-chip">manual</span>
                      )}
                    </td>
                    <td className="num dim hide-sm">
                      {fmtDate(row.settledAt ?? row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {onPage && (
            <Pager
              total={history.total}
              limit={history.limit}
              offset={history.offset}
              onPage={onPage}
            />
          )}
        </>
      )}
    </section>
  );
}
