import { useEffect, useState } from "react";
import { formatCountdown } from "./format";

/** Same 250ms tick OpenTill's component has always used — presentation only. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * v2 countdown: label + digits + depletion bar. Escalates by class swap only,
 * so the timer never moves position: quiet gray → amber under `urgentBelowMs`
 * → red pulse under `criticalBelowMs`. `createdAt` scales the bar.
 * `urgentBelowMs` defaults to the checkout's 2:00; the quote panel passes a
 * tighter one for its 60s window, the funding countdown passes 5:00 / 1:00.
 */
export function Countdown({
  expiresAt,
  createdAt,
  label = "Expires in",
  urgentBelowMs = 2 * 60 * 1000,
  criticalBelowMs,
}: {
  expiresAt: number;
  createdAt: number;
  label?: string;
  urgentBelowMs?: number;
  criticalBelowMs?: number;
}) {
  const now = useNow();
  const remaining = Math.max(0, expiresAt - now);
  const total = Math.max(1, expiresAt - createdAt);
  const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
  const critical = criticalBelowMs !== undefined && remaining < criticalBelowMs;
  const urgent = !critical && remaining < urgentBelowMs;

  return (
    <div className={`count${urgent ? " is-urgent" : ""}${critical ? " is-critical" : ""}`}>
      <div className="count-row">
        <span>{label}</span>
        <span className="digits">{formatCountdown(remaining)}</span>
      </div>
      <div className="count-track">
        <div className="count-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
