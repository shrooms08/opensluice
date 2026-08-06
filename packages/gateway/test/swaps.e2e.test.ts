import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifySignature } from "../src/webhooks";
import {
  acceptQuoteHttp,
  getMarketplace,
  getSwap,
  makeHarness,
  operatorHeaders,
  requestQuote,
  setupLp,
  startWebhookSink,
  WEBHOOK_SECRET,
  type Harness,
} from "./helpers";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.destroy();
});

/** Simulate an on-chain deposit through the dev route (pokes the poller). */
async function payOnchain(address: string, amountSats: string): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/dev/simulate-onchain-deposit",
    headers: operatorHeaders(),
    payload: { address, amountSats },
  });
  if (res.statusCode !== 202) throw new Error(`simulate onchain failed: ${res.body}`);
}

async function payOffchain(address: string, amountSats: string): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/dev/simulate-offchain-payment",
    headers: operatorHeaders(),
    payload: { address, amountSats },
  });
  if (res.statusCode !== 202) throw new Error(`simulate offchain failed: ${res.body}`);
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

describe("swap_in — single leg happy path", () => {
  it("runs deposit -> seen -> confirmed -> off-chain payout -> completed with webhooks", async () => {
    const sink = await startWebhookSink();
    const lp = await setupLp(h, "InLP", {
      fundOffchainSats: "1000000",
      swapIn: { capacitySats: "1000000", feeBps: 100 }, // 1%
    });

    const quote = await requestQuote(h, "swap_in", "100000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1puserdest", sink.url);
    expect(swap.status).toBe("pending");
    expect(swap.legs).toHaveLength(1);
    const leg = swap.legs[0]!;
    expect(leg.payChain).toBe("onchain");
    expect(leg.receiveSats).toBe("99000");

    // User pays the leg's on-chain deposit address.
    await payOnchain(leg.payTo, "100000");
    let current = await getSwap(h, swap.id);
    expect(current.legs[0]!.status).toBe("seen");
    expect(current.status).toBe("settling"); // single leg, user side done

    // Confirmations arrive.
    await mineBlocks(3);
    current = await getSwap(h, swap.id);
    expect(current.legs[0]!.status).toBe("settled");
    expect(current.legs[0]!.payoutTransferId).toBeTruthy();
    expect(current.status).toBe("completed");
    expect(current.completedAt).not.toBeNull();

    // Ledger: LP received 100k on-chain, paid 99k off-chain, earned 1k.
    const rows = h.repo.listLedgerForSwap(swap.id);
    expect(rows).toHaveLength(2);
    const sum = rows.reduce((s, r) => s + r.amountSats, 0n);
    expect(sum).toBe(1000n);
    expect(h.repo.ledgerBalance(lp.id, "offchain")).toBe(901_000n);
    expect(h.repo.ledgerBalance(lp.id, "onchain")).toBe(100_000n);

    // Webhooks: pending -> settling, settling -> completed, each HMAC-signed.
    const hooks = await sink.waitFor(2);
    for (const hook of hooks) {
      expect(verifySignature(hook.body, hook.signature, WEBHOOK_SECRET)).toBe(true);
      expect(hook.parsed.swapId).toBe(swap.id);
    }
    expect(hooks.map((w) => w.parsed.status)).toEqual(["settling", "completed"]);
    await sink.close();
  });
});

describe("swap_out — single leg happy path", () => {
  it("runs off-chain deposit -> committed -> on-chain payout -> confirmed -> completed", async () => {
    const lp = await setupLp(h, "OutLP", {
      fundOnchainSats: "1000000",
      swapOut: { capacitySats: "1000000", feeBps: 50 }, // 0.5%
    });

    const quote = await requestQuote(h, "swap_out", "200000");
    expect(quote.totalFeeSats).toBe("1000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mockbtc1quserdest");
    const leg = swap.legs[0]!;
    expect(leg.payChain).toBe("offchain");

    // User pays the leg's off-chain address; commits instantly in the harness.
    await payOffchain(leg.payTo, "200000");
    let current = await getSwap(h, swap.id);
    expect(current.legs[0]!.status).toBe("broadcasting");
    expect(current.legs[0]!.payoutTxId).toBeTruthy();
    expect(current.status).toBe("settling");

    // The LP's on-chain payout confirms.
    await mineBlocks(3);
    current = await getSwap(h, swap.id);
    expect(current.legs[0]!.status).toBe("settled");
    expect(current.status).toBe("completed");

    // Ledger: +200k off-chain, -199k on-chain, fee 1k.
    const rows = h.repo.listLedgerForSwap(swap.id);
    const sum = rows.reduce((s, r) => s + r.amountSats, 0n);
    expect(sum).toBe(1000n);
    expect(h.repo.ledgerBalance(lp.id, "onchain")).toBe(801_000n);
    expect(h.repo.ledgerBalance(lp.id, "offchain")).toBe(200_000n);

    // The user's destination actually received the payout on the mock chain.
    expect(h.mock.addressBalance("onchain", "mockbtc1quserdest")).toBe(199_000n);
  });
});

describe("swap_in — split across two LPs", () => {
  it("completes only when BOTH legs settle; locks show in the marketplace meanwhile", async () => {
    const lpA = await setupLp(h, "SplitA", {
      fundOffchainSats: "60000",
      swapIn: { capacitySats: "60000", feeBps: 10 },
    });
    const lpB = await setupLp(h, "SplitB", {
      fundOffchainSats: "60000",
      swapIn: { capacitySats: "60000", feeBps: 20 },
    });

    const quote = await requestQuote(h, "swap_in", "100000");
    expect(quote.legs).toHaveLength(2);
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1psplituser");
    const [legA, legB] = swap.legs;
    expect(legA!.lpId).toBe(lpA.id);
    expect(legB!.lpId).toBe(lpB.id);
    expect(legA!.amountSats).toBe("60000");
    expect(legB!.amountSats).toBe("40000");

    // Both legs locked: the book shows nothing available.
    let market = await getMarketplace(h);
    const bookById = new Map(market.swapIn.map((e) => [e.lpId, e]));
    expect(bookById.get(lpA.id)!.availableSats).toBe("0");
    expect(bookById.get(lpB.id)!.availableSats).toBe("20000");

    // Pay and confirm only leg A.
    await payOnchain(legA!.payTo, legA!.amountSats);
    await mineBlocks(3);
    let current = await getSwap(h, swap.id);
    expect(current.legs.find((l) => l.id === legA!.id)!.status).toBe("settled");
    expect(current.legs.find((l) => l.id === legB!.id)!.status).toBe("pending");
    expect(current.status).toBe("funding"); // NOT completed: all-legs rule

    // Now pay and confirm leg B.
    await payOnchain(legB!.payTo, legB!.amountSats);
    await mineBlocks(3);
    current = await getSwap(h, swap.id);
    expect(current.legs.every((l) => l.status === "settled")).toBe(true);
    expect(current.status).toBe("completed");

    // Zero-sum-minus-fees across the whole swap: sum(rows) == total fees.
    const rows = h.repo.listLedgerForSwap(swap.id);
    expect(rows).toHaveLength(4);
    const sum = rows.reduce((s, r) => s + r.amountSats, 0n);
    expect(sum).toBe(BigInt(quote.totalFeeSats));
    // Per-LP: each earned exactly its leg fee.
    const sumFor = (lpId: string) =>
      rows.filter((r) => r.lpId === lpId).reduce((s, r) => s + r.amountSats, 0n);
    expect(sumFor(lpA.id)).toBe(BigInt(legA!.feeSats));
    expect(sumFor(lpB.id)).toBe(BigInt(legB!.feeSats));

    // Locks released into reduced capacity: availability reflects spent funds.
    market = await getMarketplace(h);
    const after = new Map(market.swapIn.map((e) => [e.lpId, e]));
    // A paid out 60000-60=59940 off-chain; min(cap 60000, balance 60) - 0 = 60.
    expect(after.get(lpA.id)!.availableSats).toBe("60");
    expect(after.get(lpB.id)!.availableSats).toBe("20080");
  });
});

describe("capacity math through the lifecycle", () => {
  it("quote -> accept locks -> availability drops -> complete -> capacity reduced by spend", async () => {
    const lp = await setupLp(h, "CapMath", {
      fundOffchainSats: "1000000",
      swapIn: { capacitySats: "1000000", feeBps: 100 },
    });

    expect((await getMarketplace(h)).swapIn[0]!.availableSats).toBe("1000000");

    const quote = await requestQuote(h, "swap_in", "200000");
    // Quoting alone locks nothing.
    expect((await getMarketplace(h)).swapIn[0]!.availableSats).toBe("1000000");

    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1pcapuser");
    expect((await getMarketplace(h)).swapIn[0]!.availableSats).toBe("800000");

    await payOnchain(swap.legs[0]!.payTo, "200000");
    await mineBlocks(3);
    expect((await getSwap(h, swap.id)).status).toBe("completed");

    // Lock gone; off-chain balance now 1,000,000 - 198,000 = 802,000.
    expect((await getMarketplace(h)).swapIn[0]!.availableSats).toBe("802000");
    expect(h.repo.lockedSats(lp.id, "swap_in")).toBe(0n);
  });
});

describe("failure accounting", () => {
  it("a failed off-chain send after funding fails the swap without losing sats", async () => {
    await setupLp(h, "FailLP", {
      fundOffchainSats: "500000",
      swapIn: { capacitySats: "500000", feeBps: 100 },
    });
    const quote = await requestQuote(h, "swap_in", "100000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1pfailuser");

    // Sabotage the adapter's off-chain send.
    const original = h.mock.sendOffchain.bind(h.mock);
    h.mock.sendOffchain = async () => {
      throw new Error("validator quorum offline");
    };

    await payOnchain(swap.legs[0]!.payTo, "100000");
    await mineBlocks(3);

    const current = await getSwap(h, swap.id);
    expect(current.status).toBe("failed");
    expect(current.error).toMatch(/validator quorum offline/);
    const leg = current.legs[0]!;
    expect(leg.status).toBe("failed");
    expect(leg.needsManualResolution).toBe(true);

    // The user's deposit is on the LP's books as a stranded credit.
    const rows = h.repo.listLedgerForSwap(swap.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entryType: "stranded_deposit", chain: "onchain" });
    expect(rows[0]!.amountSats).toBe(100_000n);

    h.mock.sendOffchain = original;
  });
});

describe("idempotent event replay", () => {
  it("re-polling from a stale cursor does not double-apply deposits", async () => {
    await setupLp(h, "Replay", {
      fundOffchainSats: "500000",
      swapIn: { capacitySats: "500000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "100000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1preplay");

    await payOnchain(swap.legs[0]!.payTo, "100000");
    await mineBlocks(3);
    expect((await getSwap(h, swap.id)).status).toBe("completed");

    // Force a replay of everything the adapter ever emitted.
    h.repo.setCursors({ onchain: null, offchain: null });
    await h.poller.tick();

    const current = await getSwap(h, swap.id);
    expect(current.status).toBe("completed");
    const rows = h.repo.listLedgerForSwap(swap.id);
    expect(rows).toHaveLength(2); // still exactly one settlement's worth
  });
});
