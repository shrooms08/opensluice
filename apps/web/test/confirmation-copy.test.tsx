// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CONFIRMATION_TARGET } from "../src/shared/confirmations";
import { QuotePanel } from "../src/widget/QuotePanel";
import { legChip, ProgressView } from "../src/progress/ProgressView";
import type { PublicSwap, Quote } from "../src/shared/types";

afterEach(cleanup);

const NOW = 1_780_000_000_000;

const quote: Quote = {
  quoteId: "q_conf",
  direction: "swap_in",
  amountSats: "100000",
  legs: [{ lpId: "lp_a", lpName: "Penstock", amountSats: "100000", feeSats: "170", estSeconds: 45 }],
  totalFeeSats: "170",
  totalReceiveSats: "99830",
  estSeconds: 45,
  expiresAt: NOW + 60_000,
};

function swapWithConfirmations(confirmations: number): PublicSwap {
  return {
    id: "sw_conf_fixture_0001",
    direction: "swap_in",
    status: "funding",
    amountSats: "100000",
    totalFeeSats: "170",
    totalReceiveSats: "99830",
    destination: "mocktachi1pdest",
    createdAt: NOW,
    expiresAt: NOW + 15 * 60_000,
    completedAt: null,
    devSimulate: false,
    legs: [
      {
        index: 0,
        status: "seen",
        amountSats: "100000",
        feeSats: "170",
        receiveSats: "99830",
        estSeconds: 45,
        payChain: "onchain",
        payTo: "mockbtc1qexample",
        payoutTxId: null,
        payoutTransferId: null,
        confirmations,
      },
    ],
  };
}

/**
 * Part B.3 — the quote panel's arrival promise and the progress chip's live
 * count are the same promise made twice. They must be incapable of diverging,
 * so both are asserted against the imported constant rather than a literal.
 */
describe("confirmation copy is config-driven on both surfaces", () => {
  it("the quote panel's arrival line names the shared target", () => {
    render(<QuotePanel state={{ kind: "quote", quote, note: null }} direction="swap_in" />);
    expect(
      screen.getByText(`seconds after ${CONFIRMATION_TARGET} confirmations`),
    ).toBeDefined();
  });

  it("the progress chip counts toward the same shared target", () => {
    render(<ProgressView swap={swapWithConfirmations(2)} notFound={false} />);
    expect(screen.getByText(`CONFIRMING (2/${CONFIRMATION_TARGET})`)).toBeDefined();
  });

  it("both surfaces agree on the denominator, whatever it is set to", () => {
    const { container: quotePanel } = render(
      <QuotePanel state={{ kind: "quote", quote, note: null }} direction="swap_in" />,
    );
    const { container: progress } = render(
      <ProgressView swap={swapWithConfirmations(1)} notFound={false} />,
    );
    // The same number appears on both, and it is the constant — not a literal
    // that happened to match on the day this test was written.
    expect(quotePanel.textContent).toContain(`${CONFIRMATION_TARGET} confirmations`);
    expect(progress.textContent).toContain(`/${CONFIRMATION_TARGET})`);
  });

  it("a count beyond the target never over-reports", () => {
    // The adapter can report more confirmations than the settle threshold.
    expect(legChip({ ...swapWithConfirmations(9).legs[0]! }).label).toBe(
      `CONFIRMING (${CONFIRMATION_TARGET}/${CONFIRMATION_TARGET})`,
    );
  });
});
