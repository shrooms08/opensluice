// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { KeyPrompt } from "../src/lp/LpPage";
import { OverviewView } from "../src/lp/views/Overview";
import { DirectionEditor, bookPosition } from "../src/lp/views/Liquidity";
import { ExposureView } from "../src/lp/views/Exposure";
import { HistoryView } from "../src/lp/views/History";
import type {
  LpBalances,
  LpEarnings,
  LpExposure,
  LpHistory,
  LpMe,
  MarketplaceEntry,
} from "../src/shared/types";

afterEach(cleanup);

const NOW = Date.now();

const me: LpMe = {
  id: "lp_fjord",
  name: "Fjord Liquidity",
  status: "active",
  createdAt: NOW - 86_400_000,
  liquidity: {
    swapIn: {
      direction: "swap_in",
      capacitySats: "60000",
      feeBps: 10,
      feeFixedSats: "0",
      minSats: "1000",
      maxSats: "60000",
      estSeconds: 60,
      updatedAt: NOW,
    },
    swapOut: null,
  },
};

const zeroBalances: LpBalances = {
  onchainSats: "0",
  offchainSats: "0",
  locked: { swapIn: "0", swapOut: "0" },
};

const fundedBalances: LpBalances = {
  onchainSats: "2000000",
  offchainSats: "60000",
  locked: { swapIn: "60000", swapOut: "0" },
};

const zeroEarnings: LpEarnings = { totalFeesSats: "0", rows: [], total: 0, limit: 1, offset: 0 };

const fundedEarnings: LpEarnings = {
  totalFeesSats: "170",
  rows: [
    { swapRef: "sw_9f3k2…a2c7", direction: "swap_in", amountSats: "60000", feeSats: "60", settledAt: NOW },
  ],
  total: 2,
  limit: 1,
  offset: 0,
};

describe("LP key gate", () => {
  it("renders OpenTill's gate pattern: password field + never-leaves line", () => {
    render(<KeyPrompt onUnlocked={() => {}} />);
    expect(screen.getByText("Self-hosted · your key never leaves this browser")).toBeDefined();
    const input = screen.getByLabelText("LP API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByText("Unlock")).toBeDefined();
  });
});

describe("LP overview", () => {
  it("zero state: dark earnings hero, honest empty copy", () => {
    const { container } = render(
      <OverviewView me={me} balances={zeroBalances} earnings={zeroEarnings} />,
    );
    const hero = container.querySelector(".hero-card")!;
    expect(hero.className).toContain("is-dark");
    expect(hero.className).not.toContain("is-orange");
    expect(screen.getByText(/Nothing earned yet/)).toBeDefined();
    expect(screen.getByText("Fjord Liquidity")).toBeDefined();
  });

  it("funded state: the earnings hero goes orange with the exact total", () => {
    const { container } = render(
      <OverviewView me={me} balances={fundedBalances} earnings={fundedEarnings} />,
    );
    const hero = container.querySelector(".hero-card")!;
    expect(hero.className).toContain("is-orange");
    expect(screen.getByText("170")).toBeDefined();
    // Locked amounts ride as secondary lines on the balance figures.
    expect(screen.getByText(/60 000 sats locked by in-flight swap-ins/)).toBeDefined();
    // Utilization: locked / declared capacity, per direction.
    expect(screen.getByText(/60 000 \/ 60 000 sats · 100\.0%/)).toBeDefined();
    expect(screen.getByText("no offer published")).toBeDefined();
  });

  it("speaks the precise LP dialect — vault language is REQUIRED here", () => {
    const { container } = render(
      <OverviewView me={me} balances={fundedBalances} earnings={fundedEarnings} />,
    );
    expect(container.textContent).toMatch(/vault/i);
    expect(container.textContent).toMatch(/locked/i);
  });
});

describe("LP liquidity editor", () => {
  const entries: MarketplaceEntry[] = [
    { lpId: "lp_fjord", name: "Fjord Liquidity", availableSats: "60000", feeBps: 10, feeFixedSats: "0", minSats: "1000", maxSats: "60000", estSeconds: 60, updatedAt: NOW, bestRate: true },
    { lpId: "lp_meridian", name: "Meridian Bridge", availableSats: "80000", feeBps: 25, feeFixedSats: "10", minSats: "1000", maxSats: "80000", estSeconds: 90, updatedAt: NOW, bestRate: false },
  ];

  const draft = {
    capacitySats: "60000",
    feeBps: "10",
    feeFixedSats: "0",
    minSats: "1000",
    maxSats: "60000",
    estSeconds: "60",
  };

  it("renders every inline-editable field with current values and a save button", () => {
    render(
      <DirectionEditor
        direction="swap_in"
        title="Swap-in offer"
        sub="You front off-chain sats."
        me={me}
        entries={entries}
        draft={draft}
        onDraft={() => {}}
      />,
    );
    expect((screen.getByLabelText("Swap-in offer — Capacity (sats)") as HTMLInputElement).value).toBe("60000");
    expect((screen.getByLabelText("Swap-in offer — Fee (bps)") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Swap-in offer — Min (sats)") as HTMLInputElement).value).toBe("1000");
    expect((screen.getByLabelText("Swap-in offer — Est. seconds") as HTMLInputElement).value).toBe("60");
    expect(screen.getByText("Save")).toBeDefined();
  });

  it("shows your position in the book, best rate called out", () => {
    render(
      <DirectionEditor
        direction="swap_in"
        title="Swap-in offer"
        sub=""
        me={me}
        entries={entries}
        draft={draft}
        onDraft={() => {}}
      />,
    );
    expect(
      screen.getByText("Your position in the swap-in book: #1 of 2 · best rate"),
    ).toBeDefined();
  });

  it("bookPosition re-ranks against draft fees, not the published ones", () => {
    // Raising the draft fee above Meridian's 25 bps drops Fjord to #2.
    expect(bookPosition(entries, "lp_fjord", { ...draft, feeBps: "40" })).toEqual({
      rank: 2,
      of: 2,
    });
  });
});

describe("LP exposure", () => {
  it("empty state: idle capital, in so many words", () => {
    render(<ExposureView exposure={{ rows: [], totalLockedSats: "0" }} />);
    expect(screen.getByText(/No open exposure — your capital is idle\./)).toBeDefined();
  });

  it("populated: swap ref, locked amount, and a confirmations chip on on-chain legs", () => {
    const exposure: LpExposure = {
      totalLockedSats: "100000",
      rows: [
        { swapRef: "sw_9f3k2m7x…a2c7", direction: "swap_in", amountSats: "60000", feeSats: "60", status: "seen", confirmations: 2, createdAt: NOW - 90_000 },
        { swapRef: "sw_9f3k2m7x…a2c7", direction: "swap_in", amountSats: "40000", feeSats: "110", status: "pending", confirmations: null, createdAt: NOW - 90_000 },
      ],
    };
    render(<ExposureView exposure={exposure} />);
    expect(screen.getAllByText("sw_9f3k2m7x…a2c7")).toHaveLength(2);
    expect(screen.getByText("60 000")).toBeDefined();
    expect(screen.getByText("seen 2/3")).toBeDefined(); // the confirmations chip
    expect(screen.getByText("pending")).toBeDefined();
  });
});

describe("LP history", () => {
  it("white-sheet table with the fee per settled row and pagination", () => {
    const history: LpHistory = {
      total: 30,
      limit: 25,
      offset: 0,
      rows: [
        { swapRef: "sw_11111111…aaaa", direction: "swap_in", amountSats: "60000", feeSats: "60", status: "settled", error: null, needsManualResolution: false, createdAt: NOW - 500_000, settledAt: NOW - 400_000 },
        { swapRef: "sw_22222222…bbbb", direction: "swap_out", amountSats: "9000", feeSats: "18", status: "failed", error: "on-chain send failed", needsManualResolution: true, createdAt: NOW - 300_000, settledAt: null },
      ],
    };
    render(<HistoryView history={history} onPage={() => {}} />);
    expect(screen.getByText("sw_11111111…aaaa")).toBeDefined();
    expect(screen.getByText("60")).toBeDefined(); // the settled row's fee
    expect(screen.getByText("settled")).toBeDefined();
    expect(screen.getByText("failed")).toBeDefined();
    expect(screen.getByText("manual")).toBeDefined(); // stranded funds flagged
    expect(screen.getByText("1–25 of 30")).toBeDefined();
    expect(screen.getByText("Next")).toBeDefined();
  });
});
