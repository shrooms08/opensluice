import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { MockSettlementAdapter } from "@opensluice/adapter";
import type { LpDTO, MarketplaceDTO, QuoteDTO, SwapDTO } from "@opensluice/shared";
import { createApp, type App } from "../src/app";
import type { GatewayConfig } from "../src/config";

export const OPERATOR_KEY = "test_operator_key";
export const WEBHOOK_SECRET = "test_webhook_secret";

export interface Harness extends App {
  mock: MockSettlementAdapter;
  dir: string;
  destroy(): Promise<void>;
}

/**
 * Boots the gateway against a temp SQLite file and a mock adapter. Background
 * timers stay off; tests drive `poller.tick()` and the expiry sweep directly.
 * Mock time is frozen (huge block time, zero off-chain latency) so nothing
 * races the wall clock.
 */
export async function makeHarness(overrides: Partial<GatewayConfig> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "opensluice-test-"));
  const mock = new MockSettlementAdapter({
    mockBlockTimeMs: 10 ** 9,
    mockOffchainCommitMs: 0,
  });

  const config: GatewayConfig = {
    operatorKey: OPERATOR_KEY,
    webhookSecret: WEBHOOK_SECRET,
    dbPath: join(dir, "test.db"),
    adapterMode: "mock",
    port: 0,
    host: "127.0.0.1",
    pollIntervalMs: 50,
    expirySweepIntervalMs: 50,
    webhookSweepIntervalMs: 50,
    devRoutesEnabled: true,
    devPublicSimulate: false,
    sseHeartbeatMs: 15_000,
    webDistPath: join(dir, "no-dist"),
    ...overrides,
  };

  const app = await createApp(config, { adapter: mock });

  return Object.assign(app, {
    mock,
    dir,
    async destroy() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
}

export function operatorHeaders(): Record<string, string> {
  return { authorization: `Bearer ${OPERATOR_KEY}`, "content-type": "application/json" };
}

export function lpHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

export function publicHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

// ---- high-level flows -------------------------------------------------------

export interface TestLp {
  id: string;
  name: string;
  apiKey: string;
}

/** Register an LP via the API and return its one-time key. */
export async function registerLp(h: Harness, name: string): Promise<TestLp> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/lps",
    headers: operatorHeaders(),
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`registerLp failed: ${res.body}`);
  const body = res.json() as LpDTO & { apiKey: string };
  return { id: body.id, name: body.name, apiKey: body.apiKey };
}

export interface OfferSpec {
  capacitySats: string;
  feeBps: number;
  feeFixedSats?: string;
  minSats?: string;
  maxSats?: string;
  estSeconds?: number;
}

/** Fund both chains and publish liquidity for an LP in one call. */
export async function setupLp(
  h: Harness,
  name: string,
  opts: {
    fundOnchainSats?: string;
    fundOffchainSats?: string;
    swapIn?: OfferSpec;
    swapOut?: OfferSpec;
  },
): Promise<TestLp> {
  const lp = await registerLp(h, name);

  for (const [chain, amountSats] of [
    ["onchain", opts.fundOnchainSats],
    ["offchain", opts.fundOffchainSats],
  ] as const) {
    if (!amountSats) continue;
    const res = await h.app.inject({
      method: "POST",
      url: "/api/lp/fund",
      headers: operatorHeaders(),
      payload: { lpId: lp.id, chain, amountSats },
    });
    if (res.statusCode !== 201) throw new Error(`fund failed: ${res.body}`);
  }

  const offer = (spec: OfferSpec) => ({
    capacitySats: spec.capacitySats,
    feeBps: spec.feeBps,
    feeFixedSats: spec.feeFixedSats ?? "0",
    minSats: spec.minSats ?? "1",
    maxSats: spec.maxSats ?? "100000000000",
    estSeconds: spec.estSeconds ?? 60,
  });

  const payload: Record<string, unknown> = {};
  if (opts.swapIn) payload.swapIn = offer(opts.swapIn);
  if (opts.swapOut) payload.swapOut = offer(opts.swapOut);
  if (Object.keys(payload).length > 0) {
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/lp/liquidity",
      headers: lpHeaders(lp.apiKey),
      payload,
    });
    if (res.statusCode !== 200) throw new Error(`liquidity failed: ${res.body}`);
  }

  return lp;
}

export async function getMarketplace(h: Harness): Promise<MarketplaceDTO> {
  const res = await h.app.inject({ method: "GET", url: "/api/marketplace" });
  if (res.statusCode !== 200) throw new Error(`marketplace failed: ${res.body}`);
  return res.json() as MarketplaceDTO;
}

export async function requestQuote(
  h: Harness,
  direction: "swap_in" | "swap_out",
  amountSats: string,
): Promise<QuoteDTO> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/quotes",
    headers: publicHeaders(),
    payload: { direction, amountSats },
  });
  if (res.statusCode !== 201) throw new Error(`quote failed (${res.statusCode}): ${res.body}`);
  return res.json() as QuoteDTO;
}

export async function acceptQuoteHttp(
  h: Harness,
  quoteId: string,
  destination: string,
  webhookUrl?: string,
): Promise<SwapDTO> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/swaps",
    headers: publicHeaders(),
    payload: { quoteId, destination, ...(webhookUrl ? { webhookUrl } : {}) },
  });
  if (res.statusCode !== 201) throw new Error(`accept failed (${res.statusCode}): ${res.body}`);
  return res.json() as SwapDTO;
}

export async function getSwap(h: Harness, id: string): Promise<SwapDTO> {
  const res = await h.app.inject({ method: "GET", url: `/api/swaps/${id}` });
  if (res.statusCode !== 200) throw new Error(`getSwap failed: ${res.body}`);
  return res.json() as SwapDTO;
}

// ---- webhook sink -----------------------------------------------------------

export interface CapturedWebhook {
  body: string;
  signature: string;
  parsed: Record<string, unknown>;
}

export interface WebhookSink {
  url: string;
  received: CapturedWebhook[];
  waitFor(count: number, timeoutMs?: number): Promise<CapturedWebhook[]>;
  setResponseStatus(status: number): void;
  close(): Promise<void>;
}

/** Local HTTP sink that records signed webhook deliveries. */
export async function startWebhookSink(): Promise<WebhookSink> {
  const received: CapturedWebhook[] = [];
  let responseStatus = 200;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({
        body,
        signature: String(req.headers["x-opensluice-signature"] ?? ""),
        parsed: JSON.parse(body) as Record<string, unknown>,
      });
      res.writeHead(responseStatus).end("{}");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    setResponseStatus(status: number) {
      responseStatus = status;
    },
    async waitFor(count: number, timeoutMs = 5000): Promise<CapturedWebhook[]> {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} webhooks, got ${received.length}`);
        }
        await sleep(10);
      }
      return received;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `predicate` until it holds. Used where a result lands just after the observable side effect. */
export async function waitUntil(
  predicate: () => boolean,
  label = "condition",
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

// ---- SSE client -------------------------------------------------------------

export interface SseEvent {
  event: string;
  data: string;
}

export interface SseClient {
  /** Every event received so far, in order. */
  events: SseEvent[];
  /** Resolves with the next unconsumed event matching the predicate. */
  waitForEvent(
    predicate: (e: SseEvent) => boolean,
    label?: string,
    timeoutMs?: number,
  ): Promise<SseEvent>;
  close(): void;
}

/** Minimal EventSource stand-in over fetch streaming, enough for our tests. */
export async function connectSse(url: string): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (res.status !== 200 || !res.body) {
    controller.abort();
    throw new Error(`SSE connect failed with status ${res.status}`);
  }

  const events: SseEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          if (data.length > 0) events.push({ event, data: data.join("\n") });
        }
      }
    } catch {
      /* stream aborted by close() */
    }
  })();

  let cursor = 0;
  return {
    events,
    async waitForEvent(predicate, label = "sse event", timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (cursor < events.length) {
          const candidate = events[cursor]!;
          cursor += 1;
          if (predicate(candidate)) return candidate;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(10);
      }
    },
    close() {
      controller.abort();
    },
  };
}
