// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProgressView, deriveView, legChip } from "../src/progress/ProgressView";
import { CONFIRMATION_TARGET } from "../src/shared/confirmations";
import type { PublicSwap, PublicSwapLeg } from "../src/shared/types";

afterEach(cleanup);

const NOW = 1_780_000_000_000;
const N = CONFIRMATION_TARGET;

function leg(partial: Partial<PublicSwapLeg> & { index: number }): PublicSwapLeg {
  return {
    status: "pending",
    amountSats: "60000",
    feeSats: "60",
    receiveSats: "59940",
    estSeconds: 60,
    payChain: "onchain",
    payTo: `mockbtc1qfixtureleg${partial.index}addr`,
    payoutTxId: null,
    payoutTransferId: null,
    confirmations: null,
    ...partial,
  };
}

const base: PublicSwap = {
  id: "sw_fixture_1234567890",
  direction: "swap_in",
  status: "pending",
  amountSats: "100000",
  totalFeeSats: "170",
  totalReceiveSats: "99830",
  destination: "mocktachi1pfixturedestination",
  legs: [leg({ index: 0 }), leg({ index: 1, amountSats: "40000", feeSats: "110", receiveSats: "39890" })],
  createdAt: NOW,
  expiresAt: NOW + 15 * 60 * 1000,
  completedAt: null,
  devSimulate: false,
};

const single: PublicSwap = {
  ...base,
  amountSats: "60000",
  totalFeeSats: "60",
  totalReceiveSats: "59940",
  legs: [leg({ index: 0 })],
};

describe("deriveView covers every aggregate status", () => {
  it("maps statuses to the 8 views", () => {
    expect(deriveView(null, true)).toBe("notfound");
    expect(deriveView(null, false)).toBe("loading");
    expect(deriveView({ ...base, status: "pending" }, false)).toBe("awaiting");
    expect(deriveView({ ...base, status: "funding" }, false)).toBe("awaiting");
    expect(deriveView({ ...base, status: "settling" }, false)).toBe("settling");
    expect(deriveView({ ...base, status: "completed" }, false)).toBe("completed");
    expect(deriveView({ ...base, status: "expired" }, false)).toBe("expired");
    expect(deriveView({ ...base, status: "partially_funded" }, false)).toBe("partial");
    expect(deriveView({ ...base, status: "failed" }, false)).toBe("failed");
  });
});

describe("ProgressView renders all 8 states from fixtures", () => {
  it("1 loading: spinner", () => {
    render(<ProgressView swap={null} notFound={false} />);
    expect(screen.getByText("LOADING")).toBeDefined();
  });

  it("2 notfound: names nothing, blames nothing", () => {
    render(<ProgressView swap={null} notFound={true} />);
    expect(screen.getByText("No swap here")).toBeDefined();
    expect(screen.getByText(/doesn't match any swap/)).toBeDefined();
  });

  it("3 awaiting, single leg: SEND EXACTLY hero, address, QR, countdown", () => {
    render(<ProgressView swap={single} notFound={false} />);
    expect(screen.getByText("SEND EXACTLY")).toBeDefined();
    expect(screen.getByText("60 000")).toBeDefined();
    expect(screen.getByText(single.legs[0]!.payTo)).toBeDefined();
    expect(screen.getByText("COPY")).toBeDefined();
    expect(screen.getByText("WAITING")).toBeDefined();
    expect(screen.getByText("Pay within")).toBeDefined();
    expect(screen.queryByText(/SIMULATE PAYMENT/)).toBeNull();
  });

  it("3b awaiting, multi-leg: PART n OF N, order-doesn't-matter line, one live card", () => {
    const { container } = render(<ProgressView swap={base} notFound={false} />);
    expect(screen.getByText(/routed across 2 providers/)).toBeDefined();
    expect(screen.getByText(/Order doesn't matter/)).toBeDefined();
    expect(screen.getByText("PART 1 OF 2")).toBeDefined();
    expect(screen.getByText("PART 2 OF 2")).toBeDefined();
    expect(screen.getByText("0 of 2 parts funded")).toBeDefined();
    // Exactly one card is live (orange border, QR expanded); the rest collapse.
    expect(container.querySelectorAll(".leg-card.is-live")).toHaveLength(1);
    expect(container.querySelectorAll(".leg-row")).toHaveLength(1);
    expect(screen.getByText("UP NEXT")).toBeDefined();
    expect(screen.getByText(base.legs[0]!.payTo)).toBeDefined();
    expect(screen.queryByText(base.legs[1]!.payTo)).toBeNull();
  });

  it("3c multi-leg aggregate counts funded parts and advances the live card", () => {
    const oneIn: PublicSwap = {
      ...base,
      status: "funding",
      legs: [leg({ index: 0, status: "settled" }), leg({ index: 1, amountSats: "40000" })],
    };
    render(<ProgressView swap={oneIn} notFound={false} />);
    expect(screen.getByText("1 of 2 parts funded")).toBeDefined();
    expect(screen.getByText(/One part in — one to go/)).toBeDefined();
    expect(screen.getByText("SETTLED")).toBeDefined();
    // The live card is now part 2 — its address is the one on screen.
    expect(screen.getByText(oneIn.legs[1]!.payTo)).toBeDefined();
  });

  it("awaiting with devSimulate: dashed DEV button on the live leg only", () => {
    render(
      <ProgressView swap={{ ...base, devSimulate: true }} notFound={false} onPayLeg={() => {}} />,
    );
    expect(screen.getAllByText("SIMULATE PAYMENT")).toHaveLength(1);
    expect(screen.getAllByText("DEV")).toHaveLength(1);
  });

  it("4 settling: the calm interstitial, no payment instructions", () => {
    const settling: PublicSwap = {
      ...base,
      status: "settling",
      legs: [
        leg({ index: 0, status: "confirmed" }),
        leg({ index: 1, status: "settled", payoutTransferId: "mockxfer_deadbeefdeadbeef" }),
      ],
    };
    render(<ProgressView swap={settling} notFound={false} />);
    expect(screen.getByText("Moving your funds…")).toBeDefined();
    expect(screen.getByText(/All 2 parts confirmed/)).toBeDefined();
    expect(screen.queryByText(/SEND EXACTLY/)).toBeNull();
  });

  it("5 completed: the Swapped money shot with refs, fee line, new-swap button", () => {
    const completed: PublicSwap = {
      ...base,
      status: "completed",
      completedAt: NOW + 60_000,
      legs: [
        leg({ index: 0, status: "settled", payoutTransferId: "mockxfer_aaaaaaaaaaaaaaaa" }),
        leg({ index: 1, status: "settled", payoutTransferId: "mockxfer_bbbbbbbbbbbbbbbb" }),
      ],
    };
    render(<ProgressView swap={completed} notFound={false} />);
    expect(screen.getByText("Swapped")).toBeDefined();
    expect(screen.getByText("99 830")).toBeDefined();
    expect(screen.getByText("sats received")).toBeDefined();
    expect(screen.getByText(/fee 170 sats · 0\.17%/)).toBeDefined();
    // Refs render middle-truncated: `mockxfer…aaaa`.
    expect(screen.getAllByText(/mockxfer…/).length).toBe(2);
    expect(screen.getByText("New swap")).toBeDefined();
  });

  it("6 expired: calm, struck amount, nothing left the wallet", () => {
    const expired: PublicSwap = {
      ...base,
      status: "expired",
      legs: base.legs.map((l) => ({ ...l, status: "expired" as const })),
    };
    render(<ProgressView swap={expired} notFound={false} />);
    expect(screen.getByText("Expired")).toBeDefined();
    expect(screen.getByText("100 000 sats")).toBeDefined();
    expect(screen.getByText(/Nothing left your wallet/)).toBeDefined();
    expect(screen.getByText("Start a new swap")).toBeDefined();
  });

  it("7 partially_funded: amber, honest — held, not swapped, not refunded", () => {
    const partial: PublicSwap = {
      ...base,
      status: "partially_funded",
      legs: [
        leg({ index: 0, status: "settled", payoutTransferId: "mockxfer_cccccccccccccccc" }),
        leg({ index: 1, status: "expired", amountSats: "40000" }),
      ],
    };
    render(<ProgressView swap={partial} notFound={false} />);
    expect(screen.getByText("PARTIALLY FUNDED")).toBeDefined();
    expect(screen.getByText("1 of 2 parts arrived in time")).toBeDefined();
    expect(screen.getByText(/recorded and held/)).toBeDefined();
    expect(screen.getByText("60 000 sats")).toBeDefined(); // received and held
    expect(screen.getByText("40 000 sats")).toBeDefined(); // never sent
  });

  it("7b partial funding never promises a swap or a refund that cannot happen", () => {
    const partial: PublicSwap = {
      ...base,
      status: "partially_funded",
      legs: [leg({ index: 0, status: "settled" }), leg({ index: 1, status: "expired" })],
    };
    const { container } = render(<ProgressView swap={partial} notFound={false} />);
    // `partially_funded` is terminal and stranded funds need a human (GAPS.md).
    expect(container.textContent).not.toMatch(/will be swapped|on (its|their) way back|refund/i);
    expect(container.textContent).toMatch(/contact the operator/i);
  });

  it("8 failed: red chip, calm body, no invented refund", () => {
    const failed: PublicSwap = {
      ...base,
      status: "failed",
      legs: [leg({ index: 0, status: "failed" }), leg({ index: 1, status: "pending" })],
    };
    const { container } = render(<ProgressView swap={failed} notFound={false} />);
    expect(screen.getByText("SWAP FAILED")).toBeDefined();
    expect(screen.getByText("Your funds are accounted for")).toBeDefined();
    expect(screen.getByText(/recorded against this swap and held/)).toBeDefined();
    expect(screen.getByText("FAILED")).toBeDefined();
    // There is no refund path in this engine — the copy must not imply one.
    expect(container.textContent).not.toMatch(/on (its|their) way back|refund ref|rfnd_/i);
    expect(container.textContent).toMatch(/contact the operator/i);
  });

  it("no user surface ever says timelock/vault/VTXO", () => {
    for (const status of ["pending", "settling", "completed", "expired", "partially_funded", "failed"] as const) {
      const { container } = render(
        <ProgressView swap={{ ...base, status, devSimulate: true }} notFound={false} onPayLeg={() => {}} />,
      );
      expect(container.textContent).not.toMatch(/timelock|vault|vtxo/i);
      cleanup();
    }
  });
});

describe("legChip mapping", () => {
  it(`walks waiting → payment seen → confirming (n/${N}) → settled for on-chain legs`, () => {
    expect(legChip(leg({ index: 0, status: "pending" })).label).toBe("WAITING");
    expect(legChip(leg({ index: 0, status: "seen", confirmations: 0 })).label).toBe("PAYMENT SEEN");
    expect(legChip(leg({ index: 0, status: "seen", confirmations: 1 })).label).toBe(`CONFIRMING (1/${N})`);
    expect(legChip(leg({ index: 0, status: "seen", confirmations: 2 })).label).toBe(`CONFIRMING (2/${N})`);
    expect(legChip(leg({ index: 0, status: "settled" })).label).toBe("SETTLED");
  });

  it("off-chain deposits read RECEIVED; payouts read SENDING then counting", () => {
    expect(legChip(leg({ index: 0, status: "committed", payChain: "offchain" })).label).toBe("RECEIVED");
    expect(legChip(leg({ index: 0, status: "broadcasting", confirmations: null })).label).toBe("SENDING");
    expect(legChip(leg({ index: 0, status: "broadcasting", confirmations: 2 })).label).toBe(`CONFIRMING (2/${N})`);
  });
});
