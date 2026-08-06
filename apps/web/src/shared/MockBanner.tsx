/**
 * Honest mock-mode marker (OpenTill's pattern): a slim persistent footer bar
 * shown while the gateway reports `adapterMode: "mock"` on /healthz, absent
 * when settlement is real. Presentational only.
 *
 * The design file pairs this with a "round #482 · next commitment in 04:12"
 * readout. That is deliberately NOT implemented: OpenSluice has no round or
 * commitment cycle, and inventing one would imply mechanics the engine does
 * not have.
 */
export function MockBanner({ adapterMode }: { adapterMode: string | null }) {
  if (adapterMode !== "mock") return null;
  return (
    <div className="mock-banner" role="status">
      <span className="mock-tag">MOCK</span>
      <span className="mono">
        Mock settlement mode — no real Bitcoin moves. See INTEGRATION.md
      </span>
    </div>
  );
}
