import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicSwapDTO, Swap, SwapLeg } from "@opensluice/shared";
import { loadConfig } from "../src/config";
import { toPublicSwapDTO } from "../src/serialize";
import {
  acceptQuoteHttp,
  connectSse,
  makeHarness,
  operatorHeaders,
  requestQuote,
  setupLp,
  waitUntil,
  type Harness,
} from "./helpers";
import type { GatewayConfig } from "../src/config";

const PUBLIC_SWAP_FIELDS = [
  "id",
  "direction",
  "status",
  "amountSats",
  "totalFeeSats",
  "totalReceiveSats",
  "destination",
  "legs",
  "createdAt",
  "expiresAt",
  "completedAt",
  "devSimulate",
].sort();

const PUBLIC_LEG_FIELDS = [
  "index",
  "status",
  "amountSats",
  "feeSats",
  "receiveSats",
  "estSeconds",
  "payChain",
  "payTo",
  "payoutTxId",
  "payoutTransferId",
  "confirmations",
].sort();

const FORBIDDEN_SWAP_FIELDS = ["quoteId", "webhookUrl", "error"];
const FORBIDDEN_LEG_FIELDS = [
  "lpId",
  "lpName",
  "id",
  "swapId",
  "error",
  "needsManualResolution",
  "depositAddress",
];

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.destroy();
  harness = null;
});

/** Boots the harness and starts a real HTTP listener (needed for SSE). */
async function listeningHarness(
  overrides: Partial<GatewayConfig> = {},
): Promise<{ h: Harness; base: string }> {
  const h = await makeHarness(overrides);
  harness = h;
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = h.app.server.address() as AddressInfo;
  return { h, base: `http://127.0.0.1:${port}` };
}

/** One LP + one accepted 100k swap_in, the standard subject for these tests. */
async function seededSwap(h: Harness): Promise<PublicSwapDTO> {
  await setupLp(h, "PubLP", {
    fundOffchainSats: "1000000",
    swapIn: { capacitySats: "1000000", feeBps: 100 },
  });
  const quote = await requestQuote(h, "swap_in", "100000");
  const swap = await acceptQuoteHttp(h, quote.quoteId, "mocktachi1ppublic", "https://ops.example/hook");
  const res = await h.app.inject({ method: "GET", url: `/swap/api/${swap.id}` });
  expect(res.statusCode).toBe(200);
  return res.json() as PublicSwapDTO;
}

describe("public swap serializer", () => {
  it("emits exactly the public allowlist, never LP or operator material", () => {
    const swap: Swap = {
      id: "sw_test",
      quoteId: "q_secret",
      direction: "swap_in",
      status: "funding",
      amountSats: 100_000n,
      totalFeeSats: 1_000n,
      destination: "mocktachi1pdest",
      webhookUrl: "https://ops.example/hook",
      error: "internal adapter stack trace",
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
      completedAt: null,
    };
    const leg: SwapLeg = {
      id: "leg_internal",
      swapId: "sw_test",
      lpId: "lp_secret",
      amountSats: 100_000n,
      feeSats: 1_000n,
      estSeconds: 60,
      status: "seen",
      depositAddress: "mockbtc1qdeposit",
      payoutTxId: null,
      payoutTransferId: null,
      error: "raw engine error",
      needsManualResolution: true,
      createdAt: 1,
      updatedAt: 2,
      settledAt: null,
    };

    const dto = toPublicSwapDTO(swap, [leg], {
      devSimulate: true,
      confirmations: new Map([[leg.id, 2]]),
    });

    expect(Object.keys(dto).sort()).toEqual(PUBLIC_SWAP_FIELDS);
    for (const field of FORBIDDEN_SWAP_FIELDS) {
      expect(dto).not.toHaveProperty(field);
    }
    expect(dto.legs).toHaveLength(1);
    expect(Object.keys(dto.legs[0]!).sort()).toEqual(PUBLIC_LEG_FIELDS);
    for (const field of FORBIDDEN_LEG_FIELDS) {
      expect(dto.legs[0]).not.toHaveProperty(field);
    }
    // The instruction address surfaces as payTo; nothing named for the LP does.
    expect(dto.legs[0]!.payTo).toBe("mockbtc1qdeposit");
    expect(dto.legs[0]!.confirmations).toBe(2);
    expect(JSON.stringify(dto)).not.toContain("lp_secret");
    expect(JSON.stringify(dto)).not.toContain("q_secret");
    expect(JSON.stringify(dto)).not.toContain("hook");
  });
});

describe("GET /swap/api/:swapId", () => {
  it("serves the public view; unknown ids get the uniform 404", async () => {
    harness = await makeHarness();
    const dto = await seededSwap(harness);
    expect(dto.status).toBe("pending");
    expect(dto.legs[0]!.payChain).toBe("onchain");
    expect(dto.devSimulate).toBe(false);

    const missing = await harness.app.inject({ method: "GET", url: "/swap/api/sw_nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /swap/api/:swapId/events (SSE)", () => {
  it("sends a snapshot, then leg movement, then completion; cleans up its listener", async () => {
    const { h, base } = await listeningHarness();
    const dto = await seededSwap(h);

    const sse = await connectSse(`${base}/swap/api/${dto.id}/events`);
    const snapshot = await sse.waitForEvent((e) => e.event === "status", "snapshot");
    expect((JSON.parse(snapshot.data) as PublicSwapDTO).status).toBe("pending");

    // Leg funding: deposit seen (leg event without an aggregate move first).
    await h.app.inject({
      method: "POST",
      url: "/dev/simulate-onchain-deposit",
      headers: operatorHeaders(),
      payload: { address: dto.legs[0]!.payTo, amountSats: dto.amountSats },
    });
    const seen = await sse.waitForEvent(
      (e) => e.event === "status" && (JSON.parse(e.data) as PublicSwapDTO).legs[0]!.status === "seen",
      "leg seen",
    );
    expect((JSON.parse(seen.data) as PublicSwapDTO).legs[0]!.status).toBe("seen");
    // The aggregate follows in the same tick, as its own event.
    await sse.waitForEvent(
      (e) => e.event === "status" && (JSON.parse(e.data) as PublicSwapDTO).status === "settling",
      "aggregate settling",
    );

    // Confirmations arrive; the stream walks to completed without a refetch.
    await h.app.inject({
      method: "POST",
      url: "/dev/advance-blocks",
      headers: operatorHeaders(),
      payload: { blocks: 3 },
    });
    const done = await sse.waitForEvent(
      (e) => e.event === "status" && (JSON.parse(e.data) as PublicSwapDTO).status === "completed",
      "completed",
    );
    const final = JSON.parse(done.data) as PublicSwapDTO;
    expect(final.legs[0]!.status).toBe("settled");
    expect(final.legs[0]!.payoutTransferId).toBeTruthy();
    expect(final.legs[0]!.confirmations).toBeGreaterThanOrEqual(3);

    expect(h.events.listenerCount(dto.id)).toBe(1);
    sse.close();
    await waitUntil(() => h.events.listenerCount(dto.id) === 0, "listener cleanup");
  });

  it("emits heartbeats", async () => {
    const { h, base } = await listeningHarness({ sseHeartbeatMs: 40 });
    const dto = await seededSwap(h);
    const sse = await connectSse(`${base}/swap/api/${dto.id}/events`);
    await sse.waitForEvent((e) => e.event === "heartbeat", "heartbeat");
    sse.close();
  });

  it("404s for unknown swaps with the uniform shape", async () => {
    const { base } = await listeningHarness();
    const res = await fetch(`${base}/swap/api/sw_nope/events`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("leaks no listeners after 50 connect/disconnect cycles", async () => {
    const { h, base } = await listeningHarness();
    const dto = await seededSwap(h);

    for (let i = 0; i < 50; i += 1) {
      const sse = await connectSse(`${base}/swap/api/${dto.id}/events`);
      await sse.waitForEvent((e) => e.event === "status", `snapshot #${i}`);
      sse.close();
    }

    await waitUntil(() => h.events.listenerCount(dto.id) === 0, "all listeners removed");
    expect(h.events.listenerCount(dto.id)).toBe(0);
  });
});

describe("GET /api/limits", () => {
  it("derives min and max routable from the live book, per direction", async () => {
    harness = await makeHarness();
    await setupLp(harness, "LimA", {
      fundOffchainSats: "40000",
      fundOnchainSats: "90000",
      swapIn: { capacitySats: "40000", feeBps: 10, minSats: "5000" },
      swapOut: { capacitySats: "90000", feeBps: 10, minSats: "2000" },
    });
    await setupLp(harness, "LimB", {
      fundOffchainSats: "25000",
      swapIn: { capacitySats: "25000", feeBps: 20, minSats: "1000" },
    });
    await setupLp(harness, "LimC", {
      fundOffchainSats: "10000",
      swapIn: { capacitySats: "10000", feeBps: 30, minSats: "1000" },
    });
    await setupLp(harness, "LimD", {
      fundOffchainSats: "5000",
      swapIn: { capacitySats: "5000", feeBps: 30, minSats: "1000" },
    });

    const res = await harness.app.inject({ method: "GET", url: "/api/limits" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      swapIn: { minSats: string; maxRoutableSats: string };
      swapOut: { minSats: string; maxRoutableSats: string };
    };
    // swap_in: top-3 chunks 40k+25k+10k; smallest min among usable LPs = 1000.
    expect(body.swapIn).toEqual({ minSats: "1000", maxRoutableSats: "75000" });
    // swap_out: single LP book.
    expect(body.swapOut).toEqual({ minSats: "2000", maxRoutableSats: "90000" });
  });

  it("returns zeros on an empty book", async () => {
    harness = await makeHarness();
    const res = await harness.app.inject({ method: "GET", url: "/api/limits" });
    expect(res.json()).toEqual({
      swapIn: { minSats: "0", maxRoutableSats: "0" },
      swapOut: { minSats: "0", maxRoutableSats: "0" },
    });
  });
});

describe("POST /dev/swaps/:swapId/pay-leg/:legIndex", () => {
  it("does not exist when the flag is off", async () => {
    harness = await makeHarness();
    const dto = await seededSwap(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: `/dev/swaps/${dto.id}/pay-leg/0`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("pays a pending leg and drives it through the poller", async () => {
    harness = await makeHarness({ devPublicSimulate: true });
    const dto = await seededSwap(harness);
    expect(dto.devSimulate).toBe(true);

    const res = await harness.app.inject({
      method: "POST",
      url: `/dev/swaps/${dto.id}/pay-leg/0`,
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { simulatedSats: string }).simulatedSats).toBe("100000");

    const after = await harness.app.inject({ method: "GET", url: `/swap/api/${dto.id}` });
    expect((after.json() as PublicSwapDTO).legs[0]!.status).toBe("seen");
  });

  it("409s on a bad leg index and on an already-paid leg", async () => {
    harness = await makeHarness({ devPublicSimulate: true });
    const dto = await seededSwap(harness);

    const bad = await harness.app.inject({
      method: "POST",
      url: `/dev/swaps/${dto.id}/pay-leg/7`,
    });
    expect(bad.statusCode).toBe(409);
    expect((bad.json() as { error: string }).error).toBe("invalid_leg");

    await harness.app.inject({ method: "POST", url: `/dev/swaps/${dto.id}/pay-leg/0` });
    const repay = await harness.app.inject({
      method: "POST",
      url: `/dev/swaps/${dto.id}/pay-leg/0`,
    });
    expect(repay.statusCode).toBe(409);
    expect((repay.json() as { error: string }).error).toBe("invalid_state");
  });

  it("404s for unknown swaps with the uniform shape", async () => {
    harness = await makeHarness({ devPublicSimulate: true });
    const res = await harness.app.inject({ method: "POST", url: "/dev/swaps/sw_nope/pay-leg/0" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("config guards for public simulate", () => {
  it("refuses to boot with the flag on and a non-mock adapter", () => {
    expect(() =>
      loadConfig({
        OPENSLUICE_OPERATOR_KEY: "k",
        OPENSLUICE_WEBHOOK_SECRET: "s",
        ADAPTER_MODE: "tachi",
        OPENSLUICE_DEV_PUBLIC_SIMULATE: "true",
      } as NodeJS.ProcessEnv),
    ).toThrow(/refusing to boot/);
  });

  it("flag is inert in production even with the mock adapter", () => {
    const config = loadConfig({
      OPENSLUICE_OPERATOR_KEY: "k",
      OPENSLUICE_WEBHOOK_SECRET: "s",
      ADAPTER_MODE: "mock",
      OPENSLUICE_DEV_PUBLIC_SIMULATE: "true",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(config.devPublicSimulate).toBe(false);
  });

  it("serves a 503 hint for the app shell when the UI is not built", async () => {
    harness = await makeHarness();
    const res = await harness.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/swap UI is not built/);
  });
});
