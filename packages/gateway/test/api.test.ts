import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getMarketplace,
  lpHeaders,
  makeHarness,
  operatorHeaders,
  publicHeaders,
  registerLp,
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

describe("LP registry", () => {
  it("registers an LP and returns the plaintext key exactly once", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/lps",
      headers: operatorHeaders(),
      payload: { name: "Alice Liquidity" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; apiKey: string; status: string };
    expect(body.name).toBe("Alice Liquidity");
    expect(body.apiKey.startsWith("slk_")).toBe(true);
    expect(body.status).toBe("active");

    // The key is hashed at rest and never listed again.
    const list = await h.app.inject({ method: "GET", url: "/api/lps", headers: operatorHeaders() });
    const listed = (list.json() as { lps: Array<Record<string, unknown>> }).lps[0]!;
    expect(listed.apiKey).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(body.apiKey);
    expect(h.repo.getLp(body.id)).not.toBeNull();
  });

  it("pauses and reactivates an LP", async () => {
    const lp = await registerLp(h, "Pausable");
    const paused = await h.app.inject({
      method: "PATCH",
      url: `/api/lps/${lp.id}`,
      headers: operatorHeaders(),
      payload: { status: "paused" },
    });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { status: string }).status).toBe("paused");
  });

  it("rejects registration with a bad name", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/lps",
      headers: operatorHeaders(),
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("LP liquidity + marketplace", () => {
  it("publishes both directions and shows them in the book", async () => {
    const lp = await setupLp(h, "Bob", {
      fundOffchainSats: "5000000",
      fundOnchainSats: "3000000",
      swapIn: { capacitySats: "2000000", feeBps: 25, feeFixedSats: "100", minSats: "1000", maxSats: "1000000", estSeconds: 30 },
      swapOut: { capacitySats: "1500000", feeBps: 40 },
    });

    const market = await getMarketplace(h);
    expect(market.swapIn).toHaveLength(1);
    expect(market.swapIn[0]).toMatchObject({
      lpId: lp.id,
      name: "Bob",
      availableSats: "2000000", // min(capacity 2M, off-chain balance 5M)
      feeBps: 25,
      feeFixedSats: "100",
      minSats: "1000",
      maxSats: "1000000",
      estSeconds: 30,
    });
    expect(market.swapOut[0]).toMatchObject({
      lpId: lp.id,
      availableSats: "1500000", // min(capacity 1.5M, on-chain balance 3M)
      feeBps: 40,
    });
  });

  it("caps availability at the funded ledger balance", async () => {
    await setupLp(h, "Thin", {
      fundOffchainSats: "40000",
      swapIn: { capacitySats: "1000000", feeBps: 10 },
    });
    const market = await getMarketplace(h);
    expect(market.swapIn[0]!.availableSats).toBe("40000");
  });

  it("hides paused LPs from the book", async () => {
    const lp = await setupLp(h, "Ghost", {
      fundOffchainSats: "100000",
      swapIn: { capacitySats: "100000", feeBps: 10 },
    });
    await h.app.inject({
      method: "PATCH",
      url: `/api/lps/${lp.id}`,
      headers: operatorHeaders(),
      payload: { status: "paused" },
    });
    const market = await getMarketplace(h);
    expect(market.swapIn).toHaveLength(0);
  });

  it("updating liquidity overwrites the previous offer", async () => {
    const lp = await setupLp(h, "Updater", {
      fundOffchainSats: "1000000",
      swapIn: { capacitySats: "500000", feeBps: 10 },
    });
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/lp/liquidity",
      headers: lpHeaders(lp.apiKey),
      payload: {
        swapIn: { capacitySats: "700000", feeBps: 15, feeFixedSats: "0", minSats: "1", maxSats: "700000", estSeconds: 45 },
      },
    });
    expect(res.statusCode).toBe(200);
    const market = await getMarketplace(h);
    expect(market.swapIn[0]).toMatchObject({ availableSats: "700000", feeBps: 15 });
  });

  it("rejects an offer with min > max", async () => {
    const lp = await registerLp(h, "Backwards");
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/lp/liquidity",
      headers: lpHeaders(lp.apiKey),
      payload: {
        swapIn: { capacitySats: "1000", feeBps: 1, feeFixedSats: "0", minSats: "500", maxSats: "100", estSeconds: 10 },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("auth boundaries", () => {
  it("operator endpoints reject missing, wrong, and LP keys", async () => {
    const lp = await registerLp(h, "NotAnOperator");
    for (const headers of [
      publicHeaders(),
      { ...publicHeaders(), authorization: "Bearer wrong_key" },
      lpHeaders(lp.apiKey),
    ]) {
      const res = await h.app.inject({ method: "GET", url: "/api/lps", headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it("the LP endpoint rejects missing, wrong, and operator keys", async () => {
    for (const headers of [
      publicHeaders(),
      { ...publicHeaders(), authorization: "Bearer slk_not_a_real_key" },
      operatorHeaders(),
    ]) {
      const res = await h.app.inject({
        method: "PUT",
        url: "/api/lp/liquidity",
        headers,
        payload: {
          swapIn: { capacitySats: "1", feeBps: 0, feeFixedSats: "0", minSats: "1", maxSats: "1", estSeconds: 1 },
        },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("public endpoints need no auth", async () => {
    const market = await h.app.inject({ method: "GET", url: "/api/marketplace" });
    expect(market.statusCode).toBe(200);
    const health = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  });

  it("operator list of swaps is not public", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/swaps" });
    expect(res.statusCode).toBe(401);
  });
});

describe("dev route guards", () => {
  it("dev routes require the operator key even in dev mode", async () => {
    const lp = await registerLp(h, "Fundee");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/lp/fund",
      headers: publicHeaders(),
      payload: { lpId: lp.id, chain: "offchain", amountSats: "1000" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("dev routes are absent entirely when devRoutesEnabled is false", async () => {
    const prod = await makeHarness({ devRoutesEnabled: false });
    try {
      for (const [method, url, payload] of [
        ["POST", "/api/lp/fund", { lpId: "x", chain: "offchain", amountSats: "1" }],
        ["POST", "/dev/simulate-onchain-deposit", { address: "addr", amountSats: "1" }],
        ["POST", "/dev/simulate-offchain-payment", { address: "addr", amountSats: "1" }],
        ["POST", "/dev/advance-blocks", { blocks: 1 }],
      ] as const) {
        const res = await prod.app.inject({
          method,
          url,
          headers: operatorHeaders(),
          payload: payload as Record<string, unknown>,
        });
        expect(res.statusCode, url).toBe(404);
      }
    } finally {
      await prod.destroy();
    }
  });
});

describe("POST /api/lp/fund", () => {
  it("marks every credit as real or bookkeeping so nothing downstream guesses", async () => {
    const lp = await registerLp(h, "Marked");
    for (const chain of ["offchain", "onchain"] as const) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/lp/fund",
        headers: operatorHeaders(),
        payload: { lpId: lp.id, chain, amountSats: "1000" },
      });
      expect(res.statusCode).toBe(201);
      // The mock adapter settles nothing for real, and says so on both chains.
      expect(res.json()).toMatchObject({ settlement: { real: false } });
    }
    expect(h.repo.ledgerBalance(lp.id, "offchain")).toBe(1000n);
    expect(h.repo.ledgerBalance(lp.id, "onchain")).toBe(1000n);
  });

  it("works with dev routes off — funding an LP is an operator task, not a simulation", async () => {
    const prod = await makeHarness({ devRoutesEnabled: false });
    try {
      const lp = await registerLp(prod, "Prodly");
      const res = await prod.app.inject({
        method: "POST",
        url: "/api/lp/fund",
        headers: operatorHeaders(),
        payload: { lpId: lp.id, chain: "onchain", amountSats: "1000" },
      });
      expect(res.statusCode).toBe(201);
      expect(prod.repo.ledgerBalance(lp.id, "onchain")).toBe(1000n);
      // ...while the routes that conjure user deposits stay switched off.
      const sim = await prod.app.inject({
        method: "POST",
        url: "/dev/simulate-onchain-deposit",
        headers: operatorHeaders(),
        payload: { address: "mockbtc1qwhatever", amountSats: "1000" },
      });
      expect(sim.statusCode).toBe(404);
    } finally {
      await prod.destroy();
    }
  });

  it("requires the operator key", async () => {
    const lp = await registerLp(h, "Unauthed");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/lp/fund",
      payload: { lpId: lp.id, chain: "offchain", amountSats: "1000" },
    });
    expect(res.statusCode).toBe(401);
  });
});
