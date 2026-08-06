import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SWAP_FUNDING_WINDOW_MS } from "@opensluice/shared";
import { expireDueSwaps } from "../src/domain/swaps";
import {
  acceptQuoteHttp,
  getMarketplace,
  getSwap,
  makeHarness,
  operatorHeaders,
  requestQuote,
  setupLp,
  type Harness,
} from "./helpers";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.destroy();
});

const AFTER_WINDOW = () => Date.now() + SWAP_FUNDING_WINDOW_MS + 1_000;

async function payOnchain(address: string, amountSats: string): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/dev/simulate-onchain-deposit",
    headers: operatorHeaders(),
    payload: { address, amountSats },
  });
  if (res.statusCode !== 202) throw new Error(`simulate onchain failed: ${res.body}`);
}

async function mineBlocks(blocks: number): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/dev/advance-blocks",
    headers: operatorHeaders(),
    payload: { blocks },
  });
  if (res.statusCode !== 202) throw new Error(`advance blocks failed: ${res.body}`);
}

describe("swap expiry", () => {
  it("an unpaid swap expires and releases its locks back to the marketplace", async () => {
    const lp = await setupLp(h, "Expirer", {
      fundOffchainSats: "500000",
      swapIn: { capacitySats: "500000", feeBps: 10 },
    });

    const quote = await requestQuote(h, "swap_in", "300000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1pghost");
    expect((await getMarketplace(h)).swapIn[0]!.availableSats).toBe("200000");

    // Nothing paid; the sweep runs after the funding window.
    const changed = expireDueSwaps(h.ctx, AFTER_WINDOW());
    expect(changed).toBe(1);

    const current = await getSwap(h, swap.id);
    expect(current.status).toBe("expired");
    expect(current.legs.every((l) => l.status === "expired")).toBe(true);

    // Locks fully released — the book is whole again.
    expect((await getMarketplace(h)).swapIn[0]!.availableSats).toBe("500000");
    expect(h.repo.lockedSats(lp.id, "swap_in")).toBe(0n);
    expect(h.repo.listLedgerForSwap(swap.id)).toHaveLength(0);
  });

  it("a sweep before the window closes changes nothing", async () => {
    await setupLp(h, "Patient", {
      fundOffchainSats: "100000",
      swapIn: { capacitySats: "100000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "50000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1pwaiting");

    expect(expireDueSwaps(h.ctx, Date.now())).toBe(0);
    expect((await getSwap(h, swap.id)).status).toBe("pending");
  });

  it("partial funding at expiry -> partially_funded: paid leg accounted, unpaid lock released", async () => {
    const lpA = await setupLp(h, "PartA", {
      fundOffchainSats: "60000",
      swapIn: { capacitySats: "60000", feeBps: 10 },
    });
    const lpB = await setupLp(h, "PartB", {
      fundOffchainSats: "60000",
      swapIn: { capacitySats: "60000", feeBps: 20 },
    });

    const quote = await requestQuote(h, "swap_in", "100000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1ppartial");
    const [legA, legB] = swap.legs;

    // Only leg A gets paid and settles; leg B is never funded.
    await payOnchain(legA!.payTo, legA!.amountSats);
    await mineBlocks(3);
    expect((await getSwap(h, swap.id)).status).toBe("funding");

    const changed = expireDueSwaps(h.ctx, AFTER_WINDOW());
    expect(changed).toBe(1);

    const current = await getSwap(h, swap.id);
    expect(current.status).toBe("partially_funded");
    const a = current.legs.find((l) => l.id === legA!.id)!;
    const b = current.legs.find((l) => l.id === legB!.id)!;
    expect(a.status).toBe("settled"); // the settled leg's accounting stands
    expect(b.status).toBe("expired");

    // Terminal swap holds no locks: B's capacity is fully available again,
    // A's availability reflects the funds it actually spent.
    const market = await getMarketplace(h);
    const byId = new Map(market.swapIn.map((e) => [e.lpId, e]));
    expect(byId.get(lpB.id)!.availableSats).toBe("60000");
    expect(byId.get(lpA.id)!.availableSats).toBe("60"); // balance left after payout
    expect(h.repo.lockedSats(lpB.id, "swap_in")).toBe(0n);

    // Ledger holds exactly the settled leg's two rows — nothing for leg B.
    const rows = h.repo.listLedgerForSwap(swap.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.legId === legA!.id)).toBe(true);
  });

  it("a fully-paid-but-unconfirmed swap does NOT expire: 0-conf before the deadline counts as paid", async () => {
    await setupLp(h, "Limbo", {
      fundOffchainSats: "100000",
      swapIn: { capacitySats: "100000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "80000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1plimbo");

    // Deposit is seen but not yet confirmed when the window closes.
    await payOnchain(swap.legs[0]!.payTo, "80000");
    expect((await getSwap(h, swap.id)).status).toBe("settling");

    // The sweep only touches pending/funding swaps — the user did their part.
    expect(expireDueSwaps(h.ctx, AFTER_WINDOW())).toBe(0);
    expect((await getSwap(h, swap.id)).status).toBe("settling");

    // Confirmation later still completes the swap normally.
    await mineBlocks(3);
    expect((await getSwap(h, swap.id)).status).toBe("completed");
  });

  it("late money arriving after expiry is recorded but never credited", async () => {
    await setupLp(h, "TooLate", {
      fundOffchainSats: "100000",
      swapIn: { capacitySats: "100000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "50000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1plate");

    expireDueSwaps(h.ctx, AFTER_WINDOW());
    expect((await getSwap(h, swap.id)).status).toBe("expired");

    // The user pays anyway.
    await payOnchain(swap.legs[0]!.payTo, "50000");
    await mineBlocks(3);

    const current = await getSwap(h, swap.id);
    expect(current.status).toBe("expired");
    expect(current.legs[0]!.status).toBe("expired");
    // Events were recorded for the audit trail; no settlement happened.
    const events = h.repo.listEventsForLeg(swap.legs[0]!.id);
    expect(events.length).toBeGreaterThan(0);
    expect(h.repo.listLedgerForSwap(swap.id)).toHaveLength(0);
  });
});

describe("webhook retries", () => {
  it("retries a failed delivery with backoff until it lands", async () => {
    const { startWebhookSink } = await import("./helpers");
    const sink = await startWebhookSink();
    sink.setResponseStatus(500);

    await setupLp(h, "Hooked", {
      fundOffchainSats: "200000",
      swapIn: { capacitySats: "200000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "50000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1phook", sink.url);

    await payOnchain(swap.legs[0]!.payTo, "50000");
    await mineBlocks(3);

    // First attempts failed (sink 500s). Deliveries stay pending with backoff.
    await sink.waitFor(2);
    const failing = h.repo
      .listWebhooksForSwap(swap.id)
      .filter((d) => d.status === "pending" && d.attempts >= 1);
    expect(failing.length).toBeGreaterThan(0);

    // Sink recovers; a sweep past the backoff delivers everything.
    sink.setResponseStatus(200);
    const delivered = await h.webhooks.sweep(Date.now() + 60_000);
    expect(delivered).toBeGreaterThan(0);
    const final = h.repo.listWebhooksForSwap(swap.id);
    expect(final.every((d) => d.status === "delivered")).toBe(true);
    await sink.close();
  });
});
