/**
 * Honest settlement marker (OpenTill's footer-bar pattern), driven entirely by
 * the adapter's own capability flags from /healthz. Nothing here is hardcoded
 * per mode: an adapter that starts settling L1 for real makes this bar correct
 * without anyone editing this file.
 *
 * The design file pairs this with a "round #482 · next commitment in 04:12"
 * readout. That is deliberately NOT implemented: OpenSluice has no round or
 * commitment cycle, and inventing one would imply mechanics we do not have.
 */
export interface SettlementCapabilities {
  onchainReal: boolean;
  offchainReal: boolean;
  label: string;
  chainId: string | null;
}

/** The one place mode → copy is decided. Exported so tests can pin every case. */
export function settlementNotice(
  caps: SettlementCapabilities | null,
): { tone: "mock" | "partial"; text: string } | null {
  if (!caps) return null;
  if (caps.onchainReal && caps.offchainReal) return null; // fully real: no bar
  if (!caps.onchainReal && !caps.offchainReal) {
    return { tone: "mock", text: "Mock settlement mode — no real Bitcoin moves. See INTEGRATION.md" };
  }
  const where = caps.chainId ?? caps.label;
  return {
    tone: "partial",
    text: caps.offchainReal
      ? `Off-chain settlement live on ${where} · L1 legs simulated. See INTEGRATION.md`
      : `On-chain settlement live on ${where} · off-chain legs simulated. See INTEGRATION.md`,
  };
}

export function MockBanner({ capabilities }: { capabilities: SettlementCapabilities | null }) {
  const notice = settlementNotice(capabilities);
  if (!notice) return null;
  return (
    <div className="mock-banner" role="status">
      <span className="mock-tag">{notice.tone === "mock" ? "MOCK" : "PARTIAL"}</span>
      <span className="mono">{notice.text}</span>
    </div>
  );
}
