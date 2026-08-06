import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptQuote, QuoteExpiredError, QuoteAlreadyAcceptedError } from "../src/domain/swaps";
import {
  acceptQuoteHttp,
  getMarketplace,
  makeHarness,
  publicHeaders,
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

describe("POST /api/quotes", () => {
  it("quotes a single-LP route with fees and expiry", async () => {
    const lp = await setupLp(h, "Solo", {
      fundOffchainSats: "1000000",
      swapIn: { capacitySats: "1000000", feeBps: 100, feeFixedSats: "50" },
    });

    const quote = await requestQuote(h, "swap_in", "100000");
    expect(quote.direction).toBe("swap_in");
    expect(quote.legs).toHaveLength(1);
    expect(quote.legs[0]).toMatchObject({ lpId: lp.id, amountSats: "100000", feeSats: "1050" });
    expect(quote.totalFeeSats).toBe("1050");
    expect(quote.totalReceiveSats).toBe("98950");
    expect(quote.expiresAt).toBeGreaterThan(Date.now());
    expect(quote.expiresAt).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("quotes a split when no single LP covers", async () => {
    await setupLp(h, "Small1", {
      fundOffchainSats: "60000",
      swapIn: { capacitySats: "60000", feeBps: 10 },
    });
    await setupLp(h, "Small2", {
      fundOffchainSats: "60000",
      swapIn: { capacitySats: "60000", feeBps: 20 },
    });

    const quote = await requestQuote(h, "swap_in", "100000");
    expect(quote.legs).toHaveLength(2);
    const total = quote.legs.reduce((s, l) => s + BigInt(l.amountSats), 0n);
    expect(total).toBe(100000n);
  });

  it("409s with the max routable amount when liquidity is insufficient", async () => {
    await setupLp(h, "Tiny", {
      fundOffchainSats: "30000",
      swapIn: { capacitySats: "30000", feeBps: 10 },
    });

    const res = await h.app.inject({
      method: "POST",
      url: "/api/quotes",
      headers: publicHeaders(),
      payload: { direction: "swap_in", amountSats: "100000" },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; maxRoutableSats: string };
    expect(body.error).toBe("insufficient_liquidity");
    expect(body.maxRoutableSats).toBe("30000");
  });

  it("quoting locks nothing", async () => {
    await setupLp(h, "Free", {
      fundOffchainSats: "100000",
      swapIn: { capacitySats: "100000", feeBps: 10 },
    });

    const before = await getMarketplace(h);
    await requestQuote(h, "swap_in", "100000");
    await requestQuote(h, "swap_in", "100000");
    const after = await getMarketplace(h);
    expect(after.swapIn[0]!.availableSats).toBe(before.swapIn[0]!.availableSats);
  });

  it("an expired quote cannot be accepted", async () => {
    await setupLp(h, "Clock", {
      fundOffchainSats: "100000",
      swapIn: { capacitySats: "100000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "50000");

    await expect(
      acceptQuote(
        h.ctx,
        { quoteId: quote.quoteId, destination: "mocktachi1puser", webhookUrl: null },
        Date.now() + 61_000,
      ),
    ).rejects.toThrow(QuoteExpiredError);
  });

  it("a quote can be accepted only once", async () => {
    await setupLp(h, "Once", {
      fundOffchainSats: "200000",
      swapIn: { capacitySats: "200000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "50000");
    await acceptQuoteHttp(h, quote.quoteId, "mocktachi1puser");

    const second = await h.app.inject({
      method: "POST",
      url: "/api/swaps",
      headers: publicHeaders(),
      payload: { quoteId: quote.quoteId, destination: "mocktachi1pother" },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toBe("quote_already_accepted");
  });

  it("accepting 409s as stale when the book moved after quoting", async () => {
    const lp = await setupLp(h, "Mover", {
      fundOffchainSats: "100000",
      swapIn: { capacitySats: "100000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "80000");

    // Another swap eats the capacity between quote and accept.
    const rival = await requestQuote(h, "swap_in", "50000");
    await acceptQuoteHttp(h, rival.quoteId, "mocktachi1prival");

    const res = await h.app.inject({
      method: "POST",
      url: "/api/swaps",
      headers: publicHeaders(),
      payload: { quoteId: quote.quoteId, destination: "mocktachi1plate" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("quote_stale");
    void lp;
  });

  it("unknown quote -> 404", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/swaps",
      headers: publicHeaders(),
      payload: { quoteId: "q_missing", destination: "mocktachi1p" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("double-accept service-level guard also fires", async () => {
    await setupLp(h, "Twice", {
      fundOffchainSats: "200000",
      swapIn: { capacitySats: "200000", feeBps: 10 },
    });
    const quote = await requestQuote(h, "swap_in", "50000");
    await acceptQuote(h.ctx, { quoteId: quote.quoteId, destination: "d1", webhookUrl: null });
    await expect(
      acceptQuote(h.ctx, { quoteId: quote.quoteId, destination: "d2", webhookUrl: null }),
    ).rejects.toThrow(QuoteAlreadyAcceptedError);
  });
});
