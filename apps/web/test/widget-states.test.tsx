// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuotePanel, receiveDelta } from "../src/widget/QuotePanel";
import { MarketplaceStrip } from "../src/widget/MarketplaceStrip";
import type { Marketplace, Quote } from "../src/shared/types";

afterEach(cleanup);

const NOW = 1_780_000_000_000;

const singleQuote: Quote = {
  quoteId: "q_fixture_single",
  direction: "swap_in",
  amountSats: "100000",
  legs: [{ lpId: "lp_a", lpName: "Penstock", amountSats: "100000", feeSats: "1050", estSeconds: 45 }],
  totalFeeSats: "1050",
  totalReceiveSats: "98950",
  estSeconds: 45,
  expiresAt: NOW + 60_000,
};

const splitQuote: Quote = {
  quoteId: "q_fixture_split",
  direction: "swap_in",
  amountSats: "100000",
  legs: [
    { lpId: "lp_a", lpName: "Penstock", amountSats: "60000", feeSats: "60", estSeconds: 60 },
    { lpId: "lp_b", lpName: "Headwater", amountSats: "40000", feeSats: "110", estSeconds: 90 },
  ],
  totalFeeSats: "170",
  totalReceiveSats: "99830",
  estSeconds: 90,
  expiresAt: NOW + 60_000,
};

describe("QuotePanel renders every widget state from fixtures", () => {
  it("empty: prompts for an amount", () => {
    render(<QuotePanel state={{ kind: "idle" }} direction="swap_in" />);
    expect(screen.getByText("Enter an amount to see the live rate")).toBeDefined();
  });

  it("loading: routing spinner line", () => {
    render(<QuotePanel state={{ kind: "loading" }} direction="swap_in" />);
    expect(screen.getByText("Finding the best route…")).toBeDefined();
  });

  it("single-LP quote: receive hero, fee both ways, arrival promise, one quiet route row", () => {
    render(
      <QuotePanel state={{ kind: "quote", quote: singleQuote, note: null }} direction="swap_in" />,
    );
    expect(screen.getByText("98 950")).toBeDefined(); // thin-space grouping
    expect(screen.getByText("You receive")).toBeDefined();
    expect(screen.getByText("1 050 sats · 1.05%")).toBeDefined();
    expect(screen.getByText("Penstock")).toBeDefined();
    expect(screen.getByText("100 000 sats · 1 050 sats fee")).toBeDefined();
    expect(screen.queryByText(/Routed across/)).toBeNull();
    expect(screen.getByText("Rate held for you")).toBeDefined();
  });

  it("split quote: accent caption, proportional bar, one quiet row per leg", () => {
    const { container } = render(
      <QuotePanel state={{ kind: "quote", quote: splitQuote, note: null }} direction="swap_in" />,
    );
    expect(screen.getByText("Routed across 2 providers")).toBeDefined();
    expect(screen.getByText("for the best rate")).toBeDefined();
    expect(screen.getByText("Penstock")).toBeDefined();
    expect(screen.getByText("Headwater")).toBeDefined();
    expect(screen.getByText("60 000 · 60 sats")).toBeDefined();
    expect(screen.getByText("40 000 · 110 sats")).toBeDefined();
    expect(screen.getByText("170 sats · 0.17%")).toBeDefined();

    // The bar is proportional to each leg's share of the amount.
    const segs = container.querySelectorAll<HTMLElement>(".qp-split-seg");
    expect(segs).toHaveLength(2);
    expect(segs[0]!.style.width).toBe("60.0%");
    expect(segs[1]!.style.width).toBe("40.0%");
  });

  it("requote note rides on top of a fresh quote", () => {
    render(
      <QuotePanel
        state={{ kind: "quote", quote: singleQuote, note: "Rates updated — liquidity changed." }}
        direction="swap_in"
      />,
    );
    expect(screen.getByText(/Rates updated — liquidity changed\./)).toBeDefined();
  });

  it("below-min: names the actual minimum, in amber not red", () => {
    const { container } = render(
      <QuotePanel state={{ kind: "below_min", minSats: "5000" }} direction="swap_in" />,
    );
    expect(screen.getByText(/Minimum swap is/)).toBeDefined();
    expect(screen.getByText("5 000 sats")).toBeDefined();
    expect(container.querySelector(".qp-limit")).not.toBeNull();
  });

  it("insufficient with an empty book: no misleading zero, no fallback button", () => {
    render(
      <QuotePanel
        state={{ kind: "insufficient", maxRoutableSats: "0" }}
        direction="swap_in"
        onUseAmount={() => {}}
      />,
    );
    expect(screen.getByText(/No liquidity available in this direction/)).toBeDefined();
    expect(screen.queryByText(/Swap .* instead/)).toBeNull();
  });

  it("expired quote path: onExpired fires once the countdown is spent", async () => {
    let expired = 0;
    render(
      <QuotePanel
        state={{ kind: "quote", quote: { ...singleQuote, expiresAt: Date.now() - 1000 }, note: null }}
        direction="swap_in"
        onExpired={() => {
          expired += 1;
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 300)); // one useNow tick
    expect(expired).toBe(1);
  });

  it("never says timelock or vault", () => {
    const { container } = render(
      <QuotePanel state={{ kind: "quote", quote: splitQuote, note: null }} direction="swap_out" />,
    );
    expect(container.textContent).not.toMatch(/timelock|vault|vtxo/i);
  });
});

/** Part B.1 — the liquidity ceiling offers the routable number as one tap. */
describe("'Swap N instead' fallback on the liquidity ceiling", () => {
  it("names the routable maximum and offers it as an action", () => {
    render(
      <QuotePanel
        state={{ kind: "insufficient", maxRoutableSats: "390000" }}
        direction="swap_in"
        onUseAmount={() => {}}
      />,
    );
    expect(screen.getByText(/Up to/)).toBeDefined();
    expect(screen.getByText("390 000 sats")).toBeDefined();
    expect(screen.getByText(/More liquidity usually arrives within the hour/)).toBeDefined();
    expect(screen.getByText("Swap 390 000 instead")).toBeDefined();
  });

  it("tapping it hands the exact routable amount back, unformatted", () => {
    const picked: string[] = [];
    render(
      <QuotePanel
        state={{ kind: "insufficient", maxRoutableSats: "390000" }}
        direction="swap_in"
        onUseAmount={(sats) => picked.push(sats)}
      />,
    );
    fireEvent.click(screen.getByText("Swap 390 000 instead"));
    expect(picked).toEqual(["390000"]);
  });

  it("renders no action when the host passes no handler", () => {
    render(
      <QuotePanel state={{ kind: "insufficient", maxRoutableSats: "390000" }} direction="swap_in" />,
    );
    expect(screen.queryByText(/Swap .* instead/)).toBeNull();
  });
});

/** Part B.2 — a requote states the delta honestly before asking for the click. */
describe("requote delta", () => {
  it("computes the signed difference in both directions and equality", () => {
    expect(receiveDelta("99870", "99830")).toEqual({ kind: "less", sats: "40" });
    expect(receiveDelta("99830", "99870")).toEqual({ kind: "more", sats: "40" });
    expect(receiveDelta("99830", "99830")).toEqual({ kind: "same" });
  });

  it("worse rate: says how much less", () => {
    render(
      <QuotePanel
        state={{ kind: "quote", quote: splitQuote, note: "Rates updated — liquidity changed." }}
        direction="swap_in"
        previousReceiveSats="99870"
      />,
    );
    expect(screen.getByText(/You'd now receive 40 sats less\./)).toBeDefined();
  });

  it("better rate: says how much more", () => {
    render(
      <QuotePanel
        state={{ kind: "quote", quote: splitQuote, note: null }}
        direction="swap_in"
        previousReceiveSats="99790"
      />,
    );
    expect(screen.getByText(/You'd now receive 40 sats more\./)).toBeDefined();
  });

  it("unchanged rate: no delta line at all", () => {
    render(
      <QuotePanel
        state={{ kind: "quote", quote: splitQuote, note: null }}
        direction="swap_in"
        previousReceiveSats="99830"
      />,
    );
    expect(screen.queryByText(/You'd now receive/)).toBeNull();
  });

  it("first quote (nothing replaced): no delta line", () => {
    render(
      <QuotePanel
        state={{ kind: "quote", quote: splitQuote, note: null }}
        direction="swap_in"
        previousReceiveSats={null}
      />,
    );
    expect(screen.queryByText(/You'd now receive/)).toBeNull();
  });
});

describe("MarketplaceStrip", () => {
  const market: Marketplace = {
    swapIn: [
      { lpId: "a", name: "Penstock", availableSats: "60000", feeBps: 10, feeFixedSats: "0", minSats: "1", maxSats: "60000", estSeconds: 60, updatedAt: NOW, bestRate: true },
      { lpId: "b", name: "Headwater", availableSats: "80000", feeBps: 25, feeFixedSats: "10", minSats: "1", maxSats: "80000", estSeconds: 90, updatedAt: NOW, bestRate: false },
    ],
    swapOut: [],
    generatedAt: NOW,
  };

  it("shows what the quoted direction can actually cover, and links to the book", () => {
    render(<MarketplaceStrip market={market} direction="swap_in" />);
    expect(screen.getByText(/140 000 sats available/)).toBeDefined();
    expect(screen.getByText(/best 10 bps/)).toBeDefined();
    const link = screen.getByText("2 providers") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/market");
  });

  it("empty direction says so plainly, still offering the book", () => {
    render(<MarketplaceStrip market={market} direction="swap_out" />);
    expect(screen.getByText(/no liquidity in this direction right now/)).toBeDefined();
    expect(screen.getByText("View the book")).toBeDefined();
  });

  it("renders nothing before the book loads", () => {
    const { container } = render(<MarketplaceStrip market={null} />);
    expect(container.innerHTML).toBe("");
  });
});
