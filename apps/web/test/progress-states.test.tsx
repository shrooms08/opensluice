// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProgressView, deriveView, legChip } from "../src/progress/ProgressView";
import type { PublicSwap, PublicSwapLeg } from "../src/shared/types";

afterEach(cleanup);

const NOW = 1_780_000_000_000;

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

  it("2 notfound: blank wordmark pattern", () => {
    render(<ProgressView swap={null} notFound={true} />);
    expect(screen.getByText("OpenSluice")).toBeDefined();
    expect(screen.getByText("Not found")).toBeDefined();
  });

  it("3 awaiting: per-leg instruction cards with amounts, addresses, COPY, countdown", () => {
    render(<ProgressView swap={base} notFound={false} />);
    expect(screen.getByText("99 830")).toBeDefined();
    expect(screen.getByText("AWAITING PAYMENT")).toBeDefined();
    expect(screen.getByText(/routed across 2 providers/)).toBeDefined();
    expect(screen.getByText("Pay within")).toBeDefined();
    expect(screen.getByText(/Part 1 ·/)).toBeDefined();
    expect(screen.getByText(/Part 2 ·/)).toBeDefined();
    expect(screen.getByText(base.legs[0]!.payTo)).toBeDefined();
    expect(screen.getByText(base.legs[1]!.payTo)).toBeDefined();
    expect(screen.getAllByText("COPY")).toHaveLength(2);
    expect(screen.getAllByText("WAITING")).toHaveLength(2);
    // dev buttons hidden unless the payload flags devSimulate
    expect(screen.queryByText(/Simulate this payment/)).toBeNull();
  });

  it("awaiting with devSimulate: dashed DEV button per unpaid leg", () => {
    render(
      <ProgressView swap={{ ...base, devSimulate: true }} notFound={false} onPayLeg={() => {}} />,
    );
    expect(screen.getAllByText("Simulate this payment")).toHaveLength(2);
    expect(screen.getAllByText("DEV")).toHaveLength(2);
  });

  it("4 settling: confirmation counting in plain words, no instructions", () => {
    const settling: PublicSwap = {
      ...base,
      status: "settling",
      legs: [
        leg({ index: 0, status: "seen", confirmations: 2 }),
        leg({ index: 1, status: "settled", payoutTransferId: "mockxfer_deadbeefdeadbeef" }),
      ],
    };
    render(<ProgressView swap={settling} notFound={false} />);
    expect(screen.getByText("FINALIZING")).toBeDefined();
    expect(screen.getByText("CONFIRMING (2/3)")).toBeDefined();
    expect(screen.getByText("SETTLED")).toBeDefined();
    expect(screen.queryByText(/Send exactly/)).toBeNull();
    expect(screen.getByText(/waiting for the network to confirm/)).toBeDefined();
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
    expect(screen.getByText("170 sats · 0.17%")).toBeDefined();
    // Refs render middle-truncated: `mockxfer…aaaa`.
    expect(screen.getAllByText(/mockxfer…/).length).toBe(2);
    expect(screen.getByText("New swap")).toBeDefined();
  });

  it("6 expired: calm gray, struck amount, nothing moved", () => {
    const expired: PublicSwap = {
      ...base,
      status: "expired",
      legs: base.legs.map((l) => ({ ...l, status: "expired" as const })),
    };
    render(<ProgressView swap={expired} notFound={false} />);
    expect(screen.getByText("Expired")).toBeDefined();
    expect(screen.getByText("100 000 sats")).toBeDefined();
    expect(screen.getByText(/nothing moved/)).toBeDefined();
    expect(screen.getByText("New swap")).toBeDefined();
  });

  it("7 partially_funded: amber, honest wording, per-leg received view", () => {
    const partial: PublicSwap = {
      ...base,
      status: "partially_funded",
      legs: [
        leg({ index: 0, status: "settled", payoutTransferId: "mockxfer_cccccccccccccccc" }),
        leg({ index: 1, status: "expired" }),
      ],
    };
    render(<ProgressView swap={partial} notFound={false} />);
    expect(screen.getByText("NEEDS ATTENTION")).toBeDefined();
    expect(screen.getByText("Partly received")).toBeDefined();
    expect(screen.getByText(/arrived after the window/)).toBeDefined();
    expect(screen.getByText(/contact the/)).toBeDefined();
    expect(screen.getByText("SETTLED")).toBeDefined();
    expect(screen.getByText("EXPIRED")).toBeDefined();
  });

  it("8 failed: red, calm, sats accounted for", () => {
    const failed: PublicSwap = {
      ...base,
      status: "failed",
      legs: [leg({ index: 0, status: "failed" }), leg({ index: 1, status: "pending" })],
    };
    render(<ProgressView swap={failed} notFound={false} />);
    expect(screen.getByText("Swap failed")).toBeDefined();
    expect(screen.getByText(/Your sats are accounted for/)).toBeDefined();
    // Header chip + the failed leg's chip.
    expect(screen.getAllByText("FAILED").length).toBeGreaterThanOrEqual(2);
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
  it("walks waiting → seen → confirming (n/3) → settled for on-chain legs", () => {
    expect(legChip(leg({ index: 0, status: "pending" })).label).toBe("WAITING");
    expect(legChip(leg({ index: 0, status: "seen", confirmations: 0 })).label).toBe("SEEN");
    expect(legChip(leg({ index: 0, status: "seen", confirmations: 1 })).label).toBe("CONFIRMING (1/3)");
    expect(legChip(leg({ index: 0, status: "seen", confirmations: 2 })).label).toBe("CONFIRMING (2/3)");
    expect(legChip(leg({ index: 0, status: "settled" })).label).toBe("SETTLED");
  });

  it("off-chain deposits read RECEIVED; payouts read SENDING then counting", () => {
    expect(legChip(leg({ index: 0, status: "committed", payChain: "offchain" })).label).toBe("RECEIVED");
    expect(legChip(leg({ index: 0, status: "broadcasting", confirmations: null })).label).toBe("SENDING");
    expect(legChip(leg({ index: 0, status: "broadcasting", confirmations: 2 })).label).toBe("CONFIRMING (2/3)");
  });
});
