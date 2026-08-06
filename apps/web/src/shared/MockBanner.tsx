/**
 * Honest mock-mode marker (OpenTill's pattern): a slim persistent footer bar
 * shown while the gateway reports `adapterMode: "mock"` on /healthz, absent
 * when settlement is real. Presentational only.
 */
export function MockBanner({ adapterMode }: { adapterMode: string | null }) {
  if (adapterMode !== "mock") return null;
  return (
    <div className="mock-banner" role="status">
      <span className="mock-dot" />
      <span className="mono">Mock settlement mode — no real Bitcoin moves</span>
    </div>
  );
}
