// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketBook } from "../src/market/MarketPage";
import type { MarketplaceEntry } from "../src/shared/types";

afterEach(cleanup);

const NOW = Date.now();

const entries: MarketplaceEntry[] = [
  { lpId: "a", name: "Penstock", availableSats: "60000", feeBps: 10, feeFixedSats: "0", minSats: "1000", maxSats: "60000", estSeconds: 60, updatedAt: NOW, bestRate: true },
  { lpId: "b", name: "Headwater", availableSats: "80000", feeBps: 25, feeFixedSats: "10", minSats: "1000", maxSats: "80000", estSeconds: 90, updatedAt: NOW, bestRate: false },
  { lpId: "c", name: "Dry Dock", availableSats: "0", feeBps: 5, feeFixedSats: "0", minSats: "1", maxSats: "1", estSeconds: 5, updatedAt: NOW, bestRate: false },
];

describe("marketplace book", () => {
  it("totals header: total available, best rate, provider count", () => {
    render(<MarketBook entries={entries} />);
    expect(screen.getByText("Total available")).toBeDefined();
    expect(screen.getByText("140 000")).toBeDefined(); // dry providers excluded
    expect(screen.getByText("Best rate")).toBeDefined();
    expect(screen.getByText("Providers quoting")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
  });

  it("emphasizes the best-rate row with the filled orange chip; hides dry providers", () => {
    const { container } = render(<MarketBook entries={entries} />);
    const best = container.querySelector(".mk-row.is-best")!;
    expect(best.textContent).toContain("Penstock");
    expect(screen.getByText("BEST RATE")).toBeDefined();
    // Only one row may carry the emphasis.
    expect(container.querySelectorAll(".mk-row.is-best")).toHaveLength(1);
    expect(screen.queryByText("Dry Dock")).toBeNull();
  });

  it("provider rows carry rate, min–max and honest est. time", () => {
    render(<MarketBook entries={entries} />);
    // "10 bps" twice on purpose: the totals header's best rate IS this row's.
    expect(screen.getAllByText("10 bps")).toHaveLength(2);
    expect(screen.getByText("25 bps + 10")).toBeDefined();
    expect(screen.getByText("1 000 — 80 000")).toBeDefined();
    expect(screen.getByText("~90 s")).toBeDefined();
  });

  it("explains blended routing — the split is the product, said plainly", () => {
    render(<MarketBook entries={entries} />);
    expect(screen.getByText(/blended best rate/)).toBeDefined();
  });

  it("empty book recruits: the void links to the LP guide", () => {
    render(<MarketBook entries={[]} />);
    expect(screen.getByText("The book is empty")).toBeDefined();
    expect(screen.getByText(/or bring your own/)).toBeDefined();
    const cta = screen.getByText("Become a provider") as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toContain("#the-lp-guide");
  });

  it("a book of only dry providers is an empty book", () => {
    render(<MarketBook entries={[entries[2]!]} />);
    expect(screen.getByText("The book is empty")).toBeDefined();
  });

  it("stays jargon-free — /market is a user surface", () => {
    const { container } = render(<MarketBook entries={entries} />);
    expect(container.textContent).not.toMatch(/timelock|vault|vtxo/i);
  });
});
