import type { FastifyInstance, FastifyReply } from "fastify";
import type { PublicSwapDTO, Swap } from "@opensluice/shared";
import { MockSettlementAdapter, TachiRealSettlementAdapter } from "@opensluice/adapter";
import type { GatewayConfig } from "./config";
import type { ServiceContext } from "./domain/swaps";
import { toPublicSwapDTO } from "./serialize";

export interface PublicRouteDeps {
  config: GatewayConfig;
  ctx: ServiceContext;
  /** Runs one poller tick so a simulated payment is applied before we respond. */
  pokePoller: () => Promise<void>;
  /** True when apps/web/dist exists and @fastify/static was registered. */
  webDistAvailable: boolean;
}

interface SwapIdParams {
  swapId: string;
}

/**
 * Everything under /swap/* and /dev/swaps/* is unauthenticated: the swap id
 * (122-bit random UUID under the sw_ prefix) is the bearer capability.
 * Unknown ids get one uniform 404 — same shape, same code path — so the
 * routes leak no existence oracle.
 */
export async function registerPublicRoutes(
  app: FastifyInstance,
  deps: PublicRouteDeps,
): Promise<void> {
  const { config, ctx } = deps;

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });

  const lookup = (params: unknown): Swap | null => {
    const { swapId } = params as SwapIdParams;
    if (typeof swapId !== "string" || swapId.length === 0 || swapId.length > 64) {
      return null;
    }
    return ctx.repo.getSwap(swapId);
  };

  const serialize = (swap: Swap): PublicSwapDTO => {
    const legs = ctx.repo.listLegsForSwap(swap.id);
    // On-chain confirmation progress: highest count any of the leg's events
    // has reported (deposit for swap_in, payout for swap_out).
    const confirmations = new Map<string, number | null>();
    for (const leg of legs) {
      let max: number | null = null;
      for (const event of ctx.repo.listEventsForLeg(leg.id)) {
        if (event.confirmations !== null && (max === null || event.confirmations > max)) {
          max = event.confirmations;
        }
      }
      confirmations.set(leg.id, max);
    }
    return toPublicSwapDTO(swap, legs, {
      devSimulate: config.devPublicSimulate,
      confirmations,
    });
  };

  // ---- public swap view ------------------------------------------------------
  app.get("/swap/api/:swapId", async (request, reply) => {
    const swap = lookup(request.params);
    if (!swap) return notFound(reply);
    return reply.send(serialize(swap));
  });

  // ---- SSE stream ------------------------------------------------------------
  app.get("/swap/api/:swapId/events", (request, reply) => {
    const swap = lookup(request.params);
    if (!swap) {
      void notFound(reply);
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tells nginx-style reverse proxies not to buffer the stream.
      "x-accel-buffering": "no",
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("status", serialize(swap));

    const unsubscribe = ctx.events.subscribe(swap.id, (event) => {
      send("status", serialize(event.swap));
    });

    const heartbeat = setInterval(() => {
      send("heartbeat", { at: Date.now() });
    }, config.sseHeartbeatMs);
    heartbeat.unref?.();

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  // ---- the app shell ---------------------------------------------------------
  // Served unconditionally for any id shape: the page itself asks /swap/api
  // and renders the 404 view, so this route reveals nothing either.
  const sendApp = (reply: FastifyReply) => {
    if (!deps.webDistAvailable) {
      return reply
        .code(503)
        .type("text/plain")
        .send(
          "swap UI is not built. Run `npm run build -w @opensluice/web`, or use the Vite dev server (npm run dev -w @opensluice/web).",
        );
    }
    return reply.sendFile("index.html");
  };

  app.get("/", async (_request, reply) => sendApp(reply));
  app.get("/swap/:swapId", async (_request, reply) => sendApp(reply));
  // LP dashboard + public marketplace. Same shell; the pathname picks.
  // /lp is served to anyone — the page itself gates on the LP API key.
  app.get("/lp", async (_request, reply) => sendApp(reply));
  app.get("/market", async (_request, reply) => sendApp(reply));

  // ---- public dev simulate ---------------------------------------------------
  // Demo-only: unauthenticated by design, so it is triple-gated — env flag on,
  // mock adapter, non-production. loadConfig has already refused flag+non-mock.
  if (!config.devPublicSimulate) return;

  app.post("/dev/swaps/:swapId/pay-leg/:legIndex", async (request, reply) => {
    // Only ever drives a simulated chain: the whole mock adapter, or the real
    // adapter's embedded (simulated) L1. A real off-chain leg cannot be
    // "simulated" — the user has to actually pay it.
    const sim =
      ctx.adapter instanceof MockSettlementAdapter
        ? ctx.adapter
        : ctx.adapter instanceof TachiRealSettlementAdapter
          ? ctx.adapter.simulatedL1()
          : null;
    if (!sim) {
      return reply
        .code(409)
        .send({ error: "unavailable", message: "simulation requires a simulated chain" });
    }
    const swap = lookup(request.params);
    if (!swap) return notFound(reply);

    const rawIndex = (request.params as { legIndex: string }).legIndex;
    const index = /^\d+$/.test(rawIndex) ? Number.parseInt(rawIndex, 10) : -1;
    const legs = ctx.repo.listLegsForSwap(swap.id);
    const leg = index >= 0 ? legs[index] : undefined;
    if (!leg) {
      return reply.code(409).send({
        error: "invalid_leg",
        message: `swap has ${legs.length} legs; no leg at index ${rawIndex}`,
      });
    }
    if (leg.status !== "pending" || swap.status === "expired" || swap.status === "failed") {
      return reply.code(409).send({
        error: "invalid_state",
        message: `leg is ${leg.status}, swap is ${swap.status}; only a pending leg of a live swap can be paid`,
      });
    }

    if (swap.direction === "swap_in") {
      sim.simulateOnchainDeposit(leg.depositAddress, leg.amountSats);
    } else {
      // A swap_out leg is paid off-chain. When that leg is REAL there is
      // nothing to simulate — the user must send actual sats to the address.
      if (ctx.adapter.capabilities.offchainReal) {
        return reply.code(409).send({
          error: "real_leg",
          message:
            "this leg settles for real on the Tachi ledger — pay the address shown; there is nothing to simulate",
        });
      }
      sim.simulateOffchainPayment(leg.depositAddress, leg.amountSats);
    }
    await deps.pokePoller();

    return reply.code(202).send({ ok: true, legIndex: index, simulatedSats: leg.amountSats.toString() });
  });
}
