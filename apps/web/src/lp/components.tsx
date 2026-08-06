import type { ReactNode } from "react";
import type { LegStatus, SwapDirection } from "../shared/types";

export const MOCK_CONFIRMATION_TARGET = 3;

/**
 * LP surfaces speak the precise dialect: leg statuses appear verbatim, with
 * live confirmation counts on on-chain legs. No softening — LPs are pricing
 * timelock exposure and deserve the real words.
 */
export function LegStatusPill({
  status,
  confirmations,
}: {
  status: LegStatus;
  confirmations?: number | null;
}) {
  const confs =
    confirmations !== null && confirmations !== undefined
      ? ` ${Math.min(confirmations, MOCK_CONFIRMATION_TARGET)}/${MOCK_CONFIRMATION_TARGET}`
      : "";
  return (
    <span className={`pill pill-solid-${status}`}>
      {status.replace("_", " ")}
      {confs}
    </span>
  );
}

/** Directions in LP terms — the precise engine vocabulary, not user softening. */
export function directionLabel(direction: SwapDirection): string {
  return direction === "swap_in" ? "swap-in" : "swap-out";
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Age of an in-flight leg: `12 s`, `4 m`, `2 h 05 m`. */
export function formatAge(createdAt: number, now: number = Date.now()): string {
  const total = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} m`;
}

/** v2 empty state: oversized ghost title + sentence-case sub (on white sheet). */
export function EmptyState({ title = "Nothing yet", children }: { title?: string; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <p className="empty-sub">{children}</p>
    </div>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onPage,
}: {
  total: number;
  limit: number;
  offset: number;
  onPage: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="pager">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="pager-btns">
        <button
          type="button"
          className="pager-btn"
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - limit))}
        >
          Prev
        </button>
        <button
          type="button"
          className="pager-btn"
          disabled={to >= total}
          onClick={() => onPage(offset + limit)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
