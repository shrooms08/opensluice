import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  LpBalancesDTO,
  LpEarningsDTO,
  LpExposureDTO,
  LpHistoryDTO,
  LpMeDTO,
} from "@opensluice/shared";
import {
  acceptQuoteHttp,
  getMarketplace,
  lpHeaders,
  makeHarness,
  operatorHeaders,
  requestQuote,
  setupLp,
  type Harness,
  type TestLp,
} from "./helpers";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.destroy();
});

const LP_GET_ENDPOINTS = [
  "/api/lp/me",
  "/api/lp/balances",
  "/api/lp/exposure",
  "/api/lp/earnings",
  "/api/lp/history",
] as const;

async function lpGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await h.app.inject({ method: "GET", url: path, headers: lpHeaders(apiKey) });
  if (res.statusCode !== 200) throw new Error(`GET ${path} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

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

/** Two LPs whose swap_in offers force a 60k/40k split on a 100k quote. */
async function seedSplitPair(): Promise<{ fjord: TestLp; meridian: TestLp }> {
  const fjord = await setupLp(h, "Fjord Liquidity", {
    fundOffchainSats: "60000",
    fundOnchainSats: "500000",
    swapIn: { capacitySats: "60000", feeBps: 10, minSats: "1000", maxSats: "60000" },
  });
  const meridian = await setupLp(h, "Meridian Bridge", {
    fundOffchainSats: "80000",
    swapIn: { capacitySats: "80000", feeBps: 25, feeFixedSats: "10", minSats: "1000", maxSats: "80000" },
  });
  return { fjord, meridian };
}

describe("LP endpoint auth", () => {
  it.each(LP_GET_ENDPOINTS)("%s rejects missing and bogus keys with 401", async (path) => {
    const missing = await h.app.inject({ method: "GET", url: path });
    expect(missing.statusCode).toBe(401);

    const bogus = await h.app.inject({
      method: "GET",
      url: path,
      headers: lpHeaders("slk_definitely_not_a_key"),
    });
    expect(bogus.statusCode).toBe(401);
    expect(bogus.json()).toMatchObject({ error: "unauthorized" });
  });
});

describe("GET /api/lp/me", () => {
  it("returns the caller's profile with both directions' liquidity config", async () => {
    const lp = await setupLp(h, "Solo", {
      fundOffchainSats: "100000",
      swapIn: { capacitySats: "100000", feeBps: 15, feeFixedSats: "5", minSats: "500", maxSats: "90000", estSeconds: 75 },
    });
    const me = await lpGet<LpMeDTO>("/api/lp/me", lp.apiKey);
    expect(me.id).toBe(lp.id);
    expect(me.name).toBe("Solo");
    expect(me.status).toBe("active");
    expect(me.liquidity.swapIn).toMatchObject({
      direction: "swap_in",
      capacitySats: "100000",
      feeBps: 15,
      feeFixedSats: "5",
      minSats: "500",
      maxSats: "90000",
      estSeconds: 75,
    });
    expect(me.liquidity.swapOut).toBeNull();
  });
});

describe("cross-LP isolation — every endpoint, two seeded LPs", () => {
  it("LP A's key never sees LP B's rows anywhere", async () => {
    const { fjord, meridian } = await seedSplitPair();

    // One split swap touches both LPs; settle only Fjord's leg so exposure,
    // earnings, and history all have direction-specific content to leak.
    const quote = await requestQuote(h, "swap_in", "100000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1pisolation");
    const fjordLeg = swap.legs.find((l) => l.lpId === fjord.id)!;
    await payOnchain(fjordLeg.payTo, fjordLeg.amountSats);
    await mineBlocks(3);

    // me: each key resolves to its own identity.
    expect((await lpGet<LpMeDTO>("/api/lp/me", fjord.apiKey)).id).toBe(fjord.id);
    expect((await lpGet<LpMeDTO>("/api/lp/me", meridian.apiKey)).id).toBe(meridian.id);

    // balances: Fjord settled its 60k leg (+60000 onchain, -59940 offchain);
    // Meridian's books are untouched and still show its own 40k lock.
    const fb = await lpGet<LpBalancesDTO>("/api/lp/balances", fjord.apiKey);
    expect(fb).toMatchObject({
      onchainSats: "560000", // 500000 funded + 60000 deposit
      offchainSats: "60", // 60000 funded - 59940 payout
      locked: { swapIn: "0", swapOut: "0" },
    });
    const mb = await lpGet<LpBalancesDTO>("/api/lp/balances", meridian.apiKey);
    expect(mb).toMatchObject({
      onchainSats: "0",
      offchainSats: "80000",
      locked: { swapIn: "40000", swapOut: "0" },
    });

    // exposure: only Meridian still has an open leg — and only its own.
    const fe = await lpGet<LpExposureDTO>("/api/lp/exposure", fjord.apiKey);
    expect(fe.rows).toHaveLength(0);
    const me2 = await lpGet<LpExposureDTO>("/api/lp/exposure", meridian.apiKey);
    expect(me2.rows).toHaveLength(1);
    expect(me2.rows[0]!.amountSats).toBe("40000");

    // earnings: Fjord earned its leg fee, Meridian earned nothing yet.
    const fEarn = await lpGet<LpEarningsDTO>("/api/lp/earnings", fjord.apiKey);
    expect(fEarn.rows).toHaveLength(1);
    expect(fEarn.rows[0]!.feeSats).toBe("60");
    const mEarn = await lpGet<LpEarningsDTO>("/api/lp/earnings", meridian.apiKey);
    expect(mEarn.rows).toHaveLength(0);
    expect(mEarn.totalFeesSats).toBe("0");

    // history: same boundary.
    const fHist = await lpGet<LpHistoryDTO>("/api/lp/history", fjord.apiKey);
    expect(fHist.rows).toHaveLength(1);
    expect(fHist.rows[0]!.amountSats).toBe("60000");
    const mHist = await lpGet<LpHistoryDTO>("/api/lp/history", meridian.apiKey);
    expect(mHist.rows).toHaveLength(0);
  });

  it("swap refs are truncated everywhere — LPs never receive the user's full swap capability", async () => {
    const { fjord } = await seedSplitPair();
    const quote = await requestQuote(h, "swap_in", "100000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1prefcheck");
    const fjordLeg = swap.legs.find((l) => l.lpId === fjord.id)!;

    const exposure = await lpGet<LpExposureDTO>("/api/lp/exposure", fjord.apiKey);
    expect(exposure.rows[0]!.swapRef).toContain("…");
    expect(exposure.rows[0]!.swapRef.length).toBeLessThan(swap.id.length);

    await payOnchain(fjordLeg.payTo, fjordLeg.amountSats);
    await mineBlocks(3);

    const earnings = await lpGet<LpEarningsDTO>("/api/lp/earnings", fjord.apiKey);
    const history = await lpGet<LpHistoryDTO>("/api/lp/history", fjord.apiKey);
    for (const ref of [earnings.rows[0]!.swapRef, history.rows[0]!.swapRef]) {
      expect(ref).not.toBe(swap.id);
      expect(ref).toContain("…");
    }
  });
});

describe("exposure reflects locks", () => {
  it("split accept shows each LP its leg; settling one moves it to history/earnings", async () => {
    const { fjord, meridian } = await seedSplitPair();
    const quote = await requestQuote(h, "swap_in", "100000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1pexposure");
    const fjordLeg = swap.legs.find((l) => l.lpId === fjord.id)!;
    const meridianLeg = swap.legs.find((l) => l.lpId === meridian.id)!;

    // Both LPs see exactly their own in-flight leg after accept.
    let fe = await lpGet<LpExposureDTO>("/api/lp/exposure", fjord.apiKey);
    expect(fe.rows).toHaveLength(1);
    expect(fe.rows[0]).toMatchObject({
      direction: "swap_in",
      amountSats: "60000",
      status: "pending",
      confirmations: null,
    });
    expect(fe.totalLockedSats).toBe("60000");
    // Truncated ref correlates to the swap without being the capability.
    expect(fe.rows[0]!.swapRef).not.toBe(swap.id);
    expect(fe.rows[0]!.swapRef.startsWith(swap.id.slice(0, 8))).toBe(true);

    let me = await lpGet<LpExposureDTO>("/api/lp/exposure", meridian.apiKey);
    expect(me.rows).toHaveLength(1);
    expect(me.rows[0]!.amountSats).toBe("40000");

    // Fjord's leg settles fully: it leaves exposure and lands in history +
    // earnings while Meridian's untouched leg remains open.
    await payOnchain(fjordLeg.payTo, "60000");
    await mineBlocks(3);

    fe = await lpGet<LpExposureDTO>("/api/lp/exposure", fjord.apiKey);
    expect(fe.rows).toHaveLength(0);
    expect(fe.totalLockedSats).toBe("0");

    const fHist = await lpGet<LpHistoryDTO>("/api/lp/history", fjord.apiKey);
    expect(fHist.rows).toHaveLength(1);
    expect(fHist.rows[0]).toMatchObject({ status: "settled", feeSats: "60" });

    const fEarn = await lpGet<LpEarningsDTO>("/api/lp/earnings", fjord.apiKey);
    expect(fEarn.rows).toHaveLength(1);
    expect(fEarn.totalFeesSats).toBe("60");

    me = await lpGet<LpExposureDTO>("/api/lp/exposure", meridian.apiKey);
    expect(me.rows).toHaveLength(1);
    expect(me.rows[0]!.status).toBe("pending"); // still awaiting the user

    // Meridian's leg gets paid and partially confirmed: exposure shows the
    // live confirmation count while the leg is still in flight.
    await payOnchain(meridianLeg.payTo, "40000");
    await mineBlocks(2); // 2 of the 3 mock confirmations
    me = await lpGet<LpExposureDTO>("/api/lp/exposure", meridian.apiKey);
    expect(me.rows).toHaveLength(1); // still confirming — still exposed
    expect(me.rows[0]!.status).toBe("seen");
    expect(me.rows[0]!.confirmations).toBe(2);
  });
});

describe("earnings math", () => {
  it("totals match the LP ledger's fee rows exactly", async () => {
    const { fjord, meridian } = await seedSplitPair();
    const quote = await requestQuote(h, "swap_in", "100000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1pearnings");

    for (const leg of swap.legs) {
      await payOnchain(leg.payTo, leg.amountSats);
    }
    await mineBlocks(3);

    for (const lp of [fjord, meridian]) {
      const earnings = await lpGet<LpEarningsDTO>("/api/lp/earnings", lp.apiKey);

      // The ledger is the source of truth: one leg's four swap rows sum to
      // its fee, so the API total must equal the raw ledger sum.
      const ledgerFeeSum = h.repo
        .listLedgerForLp(lp.id)
        .filter((entry) => entry.entryType.startsWith("swap_"))
        .reduce((sum, entry) => sum + entry.amountSats, 0n);
      expect(earnings.totalFeesSats).toBe(ledgerFeeSum.toString());

      // And the per-row fees add up to the same total.
      const rowSum = earnings.rows.reduce((sum, r) => sum + BigInt(r.feeSats), 0n);
      expect(rowSum.toString()).toBe(earnings.totalFeesSats);
      expect(earnings.rows[0]!.settledAt).toBeGreaterThan(0);
    }

    // Both LPs' totals together equal exactly what the user was quoted.
    const fEarn = await lpGet<LpEarningsDTO>("/api/lp/earnings", fjord.apiKey);
    const mEarn = await lpGet<LpEarningsDTO>("/api/lp/earnings", meridian.apiKey);
    expect(BigInt(fEarn.totalFeesSats) + BigInt(mEarn.totalFeesSats)).toBe(
      BigInt(quote.totalFeeSats),
    );
  });

  it("paginates earnings rows", async () => {
    const lp = await setupLp(h, "Busy", {
      fundOffchainSats: "10000000",
      swapIn: { capacitySats: "10000000", feeBps: 100, minSats: "1000" },
    });
    for (let i = 0; i < 3; i += 1) {
      const quote = await requestQuote(h, "swap_in", "10000");
      const swap = await acceptQuoteHttp(h, quote.quoteId, `mocktachi1ppage${i}`);
      await payOnchain(swap.legs[0]!.payTo, "10000");
    }
    await mineBlocks(3);

    const page = await lpGet<LpEarningsDTO>("/api/lp/earnings?limit=2&offset=0", lp.apiKey);
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
    const rest = await lpGet<LpEarningsDTO>("/api/lp/earnings?limit=2&offset=2", lp.apiKey);
    expect(rest.rows).toHaveLength(1);
    // Total fees are lifetime, not per-page.
    expect(rest.totalFeesSats).toBe(page.totalFeesSats);
  });
});

describe("history filters", () => {
  it("filters by status", async () => {
    const lp = await setupLp(h, "Filtered", {
      fundOffchainSats: "1000000",
      swapIn: { capacitySats: "1000000", feeBps: 50, minSats: "1000" },
    });
    const quote = await requestQuote(h, "swap_in", "20000");
    const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1pfilter");
    await payOnchain(swap.legs[0]!.payTo, "20000");
    await mineBlocks(3);

    const settled = await lpGet<LpHistoryDTO>("/api/lp/history?status=settled", lp.apiKey);
    expect(settled.rows).toHaveLength(1);
    const failed = await lpGet<LpHistoryDTO>("/api/lp/history?status=failed", lp.apiKey);
    expect(failed.rows).toHaveLength(0);
  });
});

describe("PUT /api/lp/liquidity validation", () => {
  let lp: TestLp;

  beforeEach(async () => {
    lp = await setupLp(h, "Validator", { fundOffchainSats: "100000" });
  });

  const put = (swapIn: Record<string, unknown>) =>
    h.app.inject({
      method: "PUT",
      url: "/api/lp/liquidity",
      headers: lpHeaders(lp.apiKey),
      payload: { swapIn },
    });

  const base = {
    capacitySats: "100000",
    feeBps: 10,
    feeFixedSats: "0",
    minSats: "1000",
    maxSats: "50000",
    estSeconds: 60,
  };

  it("rejects negative fee bps with a zod error", async () => {
    const res = await put({ ...base, feeBps: -5 });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; details: Array<{ path: string }> };
    expect(body.error).toBe("validation_error");
    expect(body.details.some((d) => d.path.includes("feeBps"))).toBe(true);
  });

  it("rejects a negative capacity (not a decimal sats string)", async () => {
    const res = await put({ ...base, capacitySats: "-100" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("validation_error");
  });

  it("rejects zero minSats", async () => {
    const res = await put({ ...base, minSats: "0" });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { details: Array<{ message: string }> };
    expect(body.details.some((d) => /greater than zero/.test(d.message))).toBe(true);
  });

  it("rejects min > max", async () => {
    const res = await put({ ...base, minSats: "60000", maxSats: "50000" });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { details: Array<{ message: string }> };
    expect(body.details.some((d) => /minSats must be <= maxSats/.test(d.message))).toBe(true);
  });

  it("a rejected update leaves the previous offer untouched", async () => {
    await put(base);
    const bad = await put({ ...base, feeBps: -1 });
    expect(bad.statusCode).toBe(400);
    const me = await lpGet<LpMeDTO>("/api/lp/me", lp.apiKey);
    expect(me.liquidity.swapIn).toMatchObject({ feeBps: 10 });
  });
});

describe("marketplace bestRate marker", () => {
  it("marks exactly the entry the router would drain first, per direction", async () => {
    await seedSplitPair(); // Fjord 10 bps beats Meridian 25 bps + 10 fixed
    const market = await getMarketplace(h);

    const flags = market.swapIn.map((e) => ({ name: e.name, bestRate: e.bestRate }));
    expect(flags.filter((f) => f.bestRate)).toEqual([
      { name: "Fjord Liquidity", bestRate: true },
    ]);
    expect(market.swapOut.every((e) => !e.bestRate)).toBe(true);
    // estSeconds rides along for the marketplace page.
    expect(typeof market.swapIn[0]!.estSeconds).toBe("number");
  });

  it("never marks a dry provider, however cheap its offer", async () => {
    await setupLp(h, "Dry But Cheap", {
      // no funding: availableSats = 0
      swapIn: { capacitySats: "100000", feeBps: 1 },
    });
    const funded = await setupLp(h, "Funded", {
      fundOffchainSats: "50000",
      swapIn: { capacitySats: "50000", feeBps: 80 },
    });
    const market = await getMarketplace(h);
    const best = market.swapIn.filter((e) => e.bestRate);
    expect(best).toHaveLength(1);
    expect(best[0]!.lpId).toBe(funded.id);
  });
});
