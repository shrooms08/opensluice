// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QuotePanel } from "../src/widget/QuotePanel";
import { MarketplaceStrip } from "../src/widget/MarketplaceStrip";
import type { Marketplace, Quote } from "../src/shared/types";

afterEach(cleanup);

const NOW = 1_780_000_000_000;

const singleQuote: Quote = {
  quoteId: "q_fixture_single",
  direction: "swap_in",
  amountSats: "100000",
  legs: [
    { lpId: "lp_a", lpName: "Fjord Liquidity", amountSats: "100000", feeSats: "1050", estSeconds: 45 },
  ],
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
    { lpId: "lp_a", lpName: "Fjord Liquidity", amountSats: "60000", feeSats: "60", estSeconds: 60 },
    { lpId: "lp_b", lpName: "Meridian Bridge", amountSats: "40000", feeSats: "110", estSeconds: 90 },
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

  it("valid single-LP quote: hero receive, fee with effective %, honest time, one quiet route row", () => {
    render(
      <QuotePanel state={{ kind: "quote", quote: singleQuote, note: null }} direction="swap_in" />,
    );
    expect(screen.getByText("98 950")).toBeDefined(); // thin-space grouping
    expect(screen.getByText("You receive (balance)")).toBeDefined();
    expect(screen.getByText("1 050 sats · 1.05%")).toBeDefined();
    expect(screen.getByText("~45 s")).toBeDefined();
    expect(screen.getByText("via Fjord Liquidity")).toBeDefined();
    expect(screen.queryByText(/Routed across/)).toBeNull();
    expect(screen.getByText("Rate locked for")).toBeDefined();
  });

  it("valid split quote: caption + one row per provider leg", () => {
    render(
      <QuotePanel state={{ kind: "quote", quote: splitQuote, note: null }} direction="swap_in" />,
    );
    expect(screen.getByText("Routed across 2 providers for the best rate")).toBeDefined();
    expect(screen.getByText("Fjord Liquidity")).toBeDefined();
    expect(screen.getByText("Meridian Bridge")).toBeDefined();
    expect(screen.getByText("60 000 sats")).toBeDefined();
    expect(screen.getByText("40 000 sats")).toBeDefined();
    expect(screen.getByText("170 sats · 0.17%")).toBeDefined();
    expect(screen.getByText("~90 s")).toBeDefined();
  });

  it("requote note rides on top of a fresh quote", () => {
    render(
      <QuotePanel
        state={{ kind: "quote", quote: singleQuote, note: "Rates updated — liquidity changed" }}
        direction="swap_in"
      />,
    );
    expect(screen.getByText("Rates updated — liquidity changed")).toBeDefined();
  });

  it("below-min: names the actual minimum", () => {
    render(<QuotePanel state={{ kind: "below_min", minSats: "5000" }} direction="swap_in" />);
    expect(screen.getByText(/Minimum swap is/)).toBeDefined();
    expect(screen.getByText("5 000 sats")).toBeDefined();
  });

  it("insufficient liquidity: names the routable maximum", () => {
    render(
      <QuotePanel state={{ kind: "insufficient", maxRoutableSats: "140000" }} direction="swap_in" />,
    );
    expect(screen.getByText(/Not enough liquidity/)).toBeDefined();
    expect(screen.getByText("140 000 sats")).toBeDefined();
  });

  it("insufficient with an empty book: no misleading zero", () => {
    render(
      <QuotePanel state={{ kind: "insufficient", maxRoutableSats: "0" }} direction="swap_in" />,
    );
    expect(screen.getByText(/No liquidity available in this direction/)).toBeDefined();
  });

  it("expired quote path: onExpired fires once the countdown is spent", async () => {
    let expired = 0;
    render(
      <QuotePanel
        state={{
          kind: "quote",
          quote: { ...singleQuote, expiresAt: Date.now() - 1000 },
          note: null,
        }}
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

describe("MarketplaceStrip", () => {
  const market: Marketplace = {
    swapIn: [
      { lpId: "a", name: "Fjord", availableSats: "60000", feeBps: 10, feeFixedSats: "0", minSats: "1", maxSats: "60000", estSeconds: 60, updatedAt: NOW, bestRate: true },
      { lpId: "b", name: "Meridian", availableSats: "80000", feeBps: 25, feeFixedSats: "10", minSats: "1", maxSats: "80000", estSeconds: 90, updatedAt: NOW, bestRate: false },
    ],
    swapOut: [],
    generatedAt: NOW,
  };

  it("summarizes total available, provider count and best rate per direction", () => {
    render(<MarketplaceStrip market={market} />);
    expect(screen.getByText("LIQUIDITY BOOK")).toBeDefined();
    expect(screen.getByText(/140 000 sats · 2 providers · from 0\.10%/)).toBeDefined();
    expect(screen.getByText("no liquidity right now")).toBeDefined();
  });

  it("renders nothing before the book loads", () => {
    const { container } = render(<MarketplaceStrip market={null} />);
    expect(container.innerHTML).toBe("");
  });
});
