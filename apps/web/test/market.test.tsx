// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketBook } from "../src/market/MarketPage";
import type { MarketplaceEntry } from "../src/shared/types";

afterEach(cleanup);

const NOW = Date.now();

const entries: MarketplaceEntry[] = [
  { lpId: "a", name: "Fjord Liquidity", availableSats: "60000", feeBps: 10, feeFixedSats: "0", minSats: "1000", maxSats: "60000", estSeconds: 60, updatedAt: NOW, bestRate: true },
  { lpId: "b", name: "Meridian Bridge", availableSats: "80000", feeBps: 25, feeFixedSats: "10", minSats: "1000", maxSats: "80000", estSeconds: 90, updatedAt: NOW, bestRate: false },
  { lpId: "c", name: "Dry Dock", availableSats: "0", feeBps: 5, feeFixedSats: "0", minSats: "1", maxSats: "1", estSeconds: 5, updatedAt: NOW, bestRate: false },
];

describe("marketplace book", () => {
  it("totals header: total available, provider count, best rate", () => {
    render(<MarketBook entries={entries} />);
    expect(screen.getByText("140 000 sats")).toBeDefined(); // dry providers excluded
    expect(screen.getByText("Providers")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("Best rate")).toBeDefined();
    expect(screen.getAllByText("0.10%").length).toBeGreaterThan(0);
  });

  it("emphasizes the best-rate row and hides dry providers", () => {
    const { container } = render(<MarketBook entries={entries} />);
    const best = container.querySelector(".mk-row.is-best")!;
    expect(best.textContent).toContain("Fjord Liquidity");
    expect(screen.getByText("BEST RATE")).toBeDefined();
    expect(screen.queryByText("Dry Dock")).toBeNull();
    // Row facts: rate with fixed part, min–max, honest est. time.
    expect(screen.getByText("0.25% + 10 sats")).toBeDefined();
    expect(screen.getByText("1 000–80 000")).toBeDefined();
    expect(screen.getByText("~90 s")).toBeDefined();
  });

  it("empty state when no provider quotes the direction", () => {
    render(<MarketBook entries={[]} />);
    expect(screen.getByText("No liquidity right now")).toBeDefined();
  });

  it("stays jargon-free — /market is a user surface", () => {
    const { container } = render(<MarketBook entries={entries} />);
    expect(container.textContent).not.toMatch(/timelock|vault|vtxo/i);
  });
});
