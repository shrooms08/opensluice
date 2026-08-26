// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MockBanner, settlementNotice } from "../src/shared/MockBanner";

afterEach(cleanup);

/**
 * The banner must describe what the adapter actually settles, from the
 * adapter's own flags. These cases are the contract: no mode string is ever
 * hardcoded in the component.
 */
describe("settlement banner is capability-driven", () => {
  it("mock mode: says nothing real moves", () => {
    render(<MockBanner capabilities={{ onchainReal: false, offchainReal: false, label: "mock", chainId: null }} />);
    expect(screen.getByText("MOCK")).toBeDefined();
    expect(screen.getByText(/Mock settlement mode — no real Bitcoin moves/)).toBeDefined();
  });

  it("tachi-partial: names the live chain and admits the simulated L1 legs", () => {
    render(
      <MockBanner
        capabilities={{ onchainReal: false, offchainReal: true, label: "tachi-regtest-1", chainId: "tachi-regtest-1" }}
      />,
    );
    expect(screen.getByText("PARTIAL")).toBeDefined();
    expect(
      screen.getByText("Off-chain settlement live on tachi-regtest-1 · L1 legs simulated. See INTEGRATION.md"),
    ).toBeDefined();
  });

  it("fully real settlement renders no bar at all", () => {
    const { container } = render(
      <MockBanner capabilities={{ onchainReal: true, offchainReal: true, label: "tachi-main", chainId: "tachi-main" }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing before /healthz answers", () => {
    const { container } = render(<MockBanner capabilities={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("the inverse case is described correctly too", () => {
    expect(settlementNotice({ onchainReal: true, offchainReal: false, label: "x", chainId: "chain-x" })).toEqual({
      tone: "partial",
      text: "On-chain settlement live on chain-x · off-chain legs simulated. See INTEGRATION.md",
    });
  });

  it("falls back to the label when no chain id is known yet", () => {
    expect(settlementNotice({ onchainReal: false, offchainReal: true, label: "tachi-regtest", chainId: null })?.text).toContain(
      "tachi-regtest",
    );
  });
});
