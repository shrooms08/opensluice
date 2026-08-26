import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  advanceBlocksSchema,
  createSwapSchema,
  fundLpSchema,
  idParamsSchema,
  listSwapsQuerySchema,
  lpHistoryQuerySchema,
  lpPageQuerySchema,
  parseSats,
  quoteRequestSchema,
  registerLpSchema,
  setLiquiditySchema,
  simulateDepositSchema,
  updateLpSchema,
  type Lp,
  type SwapDirection,
} from "@opensluice/shared";
import { MockSettlementAdapter, TachiRealSettlementAdapter } from "@opensluice/adapter";
import type { GatewayConfig } from "./config";
import { isDbHealthy } from "./db";
import { bestRateLpId, buildBook, generateLpApiKey, hashLpApiKey } from "./domain/lps";
import { createQuote } from "./domain/quotes";
import { bookMaxRoutableSats, bookMinRoutableSats } from "./domain/router";
import {
  acceptQuote,
  QuoteAlreadyAcceptedError,
  QuoteExpiredError,
  QuoteNotFoundError,
  QuoteStaleError,
  type ServiceContext,
} from "./domain/swaps";
import {
  toLpDTO,
  toLpEarningRowDTO,
  toLpExposureRowDTO,
  toLpHistoryRowDTO,
  toLpLiquidityDTO,
  toMarketplaceEntryDTO,
  toQuoteDTO,
  toSwapDTO,
  toWebhookDeliveryDTO,
} from "./serialize";

export interface RouteDeps {
  config: GatewayConfig;
  ctx: ServiceContext;
  /** Nudges the webhook dispatcher after a state change instead of waiting for the sweep. */
  flushWebhooks: () => void;
  /** Drives one poll cycle promptly after a dev simulation. */
  pokePoller: () => Promise<void>;
}

function parseOr400<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
): z.infer<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({
    error: "validation_error",
    message: "request failed validation",
    details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, ctx } = deps;

  const requireOperatorKey = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (!token || !constantTimeEquals(token, config.operatorKey)) {
      await reply
        .code(401)
        .send({ error: "unauthorized", message: "missing or invalid operator key" });
    }
  };

  /** Resolve the calling LP from its bearer key, or null. */
  const lpFromAuth = (request: FastifyRequest): Lp | null => {
    const token = bearerToken(request);
    if (!token) return null;
    return ctx.repo.getLpByKeyHash(hashLpApiKey(token));
  };

  app.get("/healthz", async () => ({
    ok: true,
    adapterMode: config.adapterMode,
    dbOk: isDbHealthy(ctx.repo.db),
    // One source of truth for what actually settles. The UI banner, the README
    // and INTEGRATION.md all describe this object rather than restating it.
    settlement: ctx.adapter.capabilities,
  }));

  // ---- operator API (bearer auth with the operator key) ---------------------
  await app.register(async (api) => {
    api.addHook("onRequest", requireOperatorKey);

    api.post("/api/lps", async (request, reply) => {
      const body = parseOr400(registerLpSchema, request.body, reply);
      if (!body) return reply;
      const { apiKey, hash } = generateLpApiKey();
      const lp = ctx.repo.insertLp({ name: body.name, apiKeyHash: hash });
      // The plaintext key exists in this response and nowhere else.
      return reply.code(201).send({ ...toLpDTO(lp), apiKey });
    });

    api.get("/api/lps", async (_request, reply) => {
      return reply.send({ lps: ctx.repo.listLps().map(toLpDTO) });
    });

    api.patch("/api/lps/:id", async (request, reply) => {
      const params = parseOr400(idParamsSchema, request.params, reply);
      if (!params) return reply;
      const body = parseOr400(updateLpSchema, request.body, reply);
      if (!body) return reply;
      const lp = ctx.repo.setLpStatus(params.id, body.status);
      if (!lp) {
        return reply.code(404).send({ error: "not_found", message: `LP ${params.id} not found` });
      }
      return reply.send(toLpDTO(lp));
    });

    api.get("/api/swaps", async (request, reply) => {
      const query = parseOr400(listSwapsQuerySchema, request.query, reply);
      if (!query) return reply;
      const swaps = ctx.repo.listSwaps(query);
      const lpNames = new Map(ctx.repo.listLps().map((lp) => [lp.id, lp.name]));
      return reply.send({
        swaps: swaps.map((s) => toSwapDTO(s, ctx.repo.listLegsForSwap(s.id), lpNames)),
        total: ctx.repo.countSwaps(query.status, query.direction),
        limit: query.limit,
        offset: query.offset,
      });
    });

    /**
     * Credit an LP so it can front swaps. Operator-authenticated.
     *
     * This lives on the operator API rather than with the dev simulation
     * routes because in real mode it is a genuine treasury operation: it moves
     * REAL sats from the operator float to the LP's own derived account, and
     * books the `lp_ledger` row only if that transfer commits. A deployment
     * that settles for real needs it in production; the dev routes it used to
     * sit beside mint fictional value and must stay switched off there.
     *
     * Credits that are NOT backed by a transfer (any on-chain credit, and any
     * credit at all on the mock adapter) are still allowed here: on an instance
     * that openly reports `onchainReal: false` they are part of the declared
     * simulation, not a deception. The invariant is that the response says
     * per-credit whether real sats moved, so nothing downstream has to guess.
     */
    api.post("/api/lp/fund", async (request, reply) => {
      const body = parseOr400(fundLpSchema, request.body, reply);
      if (!body) return reply;
      const lp = ctx.repo.getLp(body.lpId);
      if (!lp) {
        return reply.code(404).send({ error: "not_found", message: `LP ${body.lpId} not found` });
      }
      const amountSats = parseSats(body.amountSats);

      let settlement: Record<string, unknown> | undefined;
      const adapter = ctx.adapter;
      if (body.chain === "offchain" && adapter instanceof TachiRealSettlementAdapter) {
        try {
          const funded = await adapter.fundOffchainAccount({ ref: `lp:${lp.id}`, amountSats });
          settlement = { real: true, ...funded, chainId: adapter.capabilities.chainId };
        } catch (err) {
          // Never book an off-chain credit whose sats did not move.
          return reply.code(502).send({
            error: "settlement_failed",
            message: `real off-chain funding failed, no ledger row written: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      } else {
        settlement = {
          real: false,
          note:
            body.chain === "onchain"
              ? "bookkeeping only — L1 legs are simulated in this build, see INTEGRATION.md"
              : "bookkeeping only — this adapter does not settle off-chain for real",
        };
      }

      const entry = ctx.repo.insertLedgerEntry({
        lpId: lp.id,
        chain: body.chain,
        entryType: "fund",
        amountSats,
      });
      return reply.code(201).send({
        lpId: lp.id,
        chain: entry.chain,
        amountSats: entry.amountSats.toString(),
        balanceSats: ctx.repo.ledgerBalance(lp.id, body.chain).toString(),
        ...(settlement ? { settlement } : {}),
      });
    });

    api.get("/api/swaps/:id/webhook-deliveries", async (request, reply) => {
      const params = parseOr400(idParamsSchema, request.params, reply);
      if (!params) return reply;
      if (!ctx.repo.getSwap(params.id)) {
        return reply.code(404).send({ error: "not_found", message: `swap ${params.id} not found` });
      }
      return reply.send({
        deliveries: ctx.repo.listWebhooksForSwap(params.id).map(toWebhookDeliveryDTO),
      });
    });
  });

  // ---- LP API (per-LP bearer keys) ------------------------------------------
  // Every handler resolves the caller's LP from its own key and reads ONLY
  // rows filtered on that lp_id — an LP can never see another LP's world.
  await app.register(async (api) => {
    const requireLp = (request: FastifyRequest, reply: FastifyReply): Lp | null => {
      const lp = lpFromAuth(request);
      if (!lp) {
        void reply
          .code(401)
          .send({ error: "unauthorized", message: "missing or invalid LP API key" });
      }
      return lp;
    };

    /** Highest confirmation count any of the leg's events reported. */
    const legConfirmations = (legId: string): number | null => {
      let max: number | null = null;
      for (const event of ctx.repo.listEventsForLeg(legId)) {
        if (event.confirmations !== null && (max === null || event.confirmations > max)) {
          max = event.confirmations;
        }
      }
      return max;
    };

    api.get("/api/lp/me", async (request, reply) => {
      const lp = requireLp(request, reply);
      if (!lp) return reply;
      const swapIn = ctx.repo.getLiquidity(lp.id, "swap_in");
      const swapOut = ctx.repo.getLiquidity(lp.id, "swap_out");
      return reply.send({
        id: lp.id,
        name: lp.name,
        status: lp.status,
        createdAt: lp.createdAt,
        liquidity: {
          swapIn: swapIn ? toLpLiquidityDTO(swapIn) : null,
          swapOut: swapOut ? toLpLiquidityDTO(swapOut) : null,
        },
      });
    });

    api.get("/api/lp/balances", async (request, reply) => {
      const lp = requireLp(request, reply);
      if (!lp) return reply;
      return reply.send({
        onchainSats: ctx.repo.ledgerBalance(lp.id, "onchain").toString(),
        offchainSats: ctx.repo.ledgerBalance(lp.id, "offchain").toString(),
        locked: {
          swapIn: ctx.repo.lockedSats(lp.id, "swap_in").toString(),
          swapOut: ctx.repo.lockedSats(lp.id, "swap_out").toString(),
        },
      });
    });

    api.get("/api/lp/exposure", async (request, reply) => {
      const lp = requireLp(request, reply);
      if (!lp) return reply;
      const rows = ctx.repo
        .listExposureLegsForLp(lp.id)
        .map(({ leg, direction }) =>
          toLpExposureRowDTO(leg, direction, legConfirmations(leg.id)),
        );
      const totalLocked =
        ctx.repo.lockedSats(lp.id, "swap_in") + ctx.repo.lockedSats(lp.id, "swap_out");
      return reply.send({ rows, totalLockedSats: totalLocked.toString() });
    });

    api.get("/api/lp/earnings", async (request, reply) => {
      const lp = requireLp(request, reply);
      if (!lp) return reply;
      const query = parseOr400(lpPageQuerySchema, request.query, reply);
      if (!query) return reply;
      const rows = ctx.repo
        .listSettledLegsForLp(lp.id, query)
        .map(({ leg, direction }) => toLpEarningRowDTO(leg, direction));
      return reply.send({
        totalFeesSats: ctx.repo.totalSwapFeesSats(lp.id).toString(),
        rows,
        total: ctx.repo.countSettledLegsForLp(lp.id),
        limit: query.limit,
        offset: query.offset,
      });
    });

    api.get("/api/lp/history", async (request, reply) => {
      const lp = requireLp(request, reply);
      if (!lp) return reply;
      const query = parseOr400(lpHistoryQuerySchema, request.query, reply);
      if (!query) return reply;
      const rows = ctx.repo
        .listClosedLegsForLp(lp.id, query)
        .map(({ leg, direction }) => toLpHistoryRowDTO(leg, direction));
      return reply.send({
        rows,
        total: ctx.repo.countClosedLegsForLp(lp.id, query),
        limit: query.limit,
        offset: query.offset,
      });
    });

    api.put("/api/lp/liquidity", async (request, reply) => {
      const lp = requireLp(request, reply);
      if (!lp) return reply;
      const body = parseOr400(setLiquiditySchema, request.body, reply);
      if (!body) return reply;

      const updated = ctx.repo.db.transaction(() => {
        const results: Record<string, unknown> = {};
        const offers: Array<[SwapDirection, NonNullable<typeof body.swapIn>]> = [];
        if (body.swapIn) offers.push(["swap_in", body.swapIn]);
        if (body.swapOut) offers.push(["swap_out", body.swapOut]);
        for (const [direction, offer] of offers) {
          const liquidity = ctx.repo.upsertLiquidity({
            lpId: lp.id,
            direction,
            capacitySats: parseSats(offer.capacitySats),
            feeBps: offer.feeBps,
            feeFixedSats: parseSats(offer.feeFixedSats),
            minSats: parseSats(offer.minSats),
            maxSats: parseSats(offer.maxSats),
            estSeconds: offer.estSeconds,
          });
          results[direction === "swap_in" ? "swapIn" : "swapOut"] = {
            capacitySats: liquidity.capacitySats.toString(),
            feeBps: liquidity.feeBps,
            feeFixedSats: liquidity.feeFixedSats.toString(),
            minSats: liquidity.minSats.toString(),
            maxSats: liquidity.maxSats.toString(),
            estSeconds: liquidity.estSeconds,
            updatedAt: liquidity.updatedAt,
          };
        }
        return results;
      })();

      return reply.send({ lpId: lp.id, ...updated });
    });
  });

  // ---- public API (capability = ids) ----------------------------------------

  app.get("/api/marketplace", async (_request, reply) => {
    const bookFor = (direction: SwapDirection) => {
      const book = buildBook(ctx.repo, direction);
      const bestId = bestRateLpId(book);
      return book.map((entry) => toMarketplaceEntryDTO(entry, entry.lpId === bestId));
    };
    return reply.send({
      swapIn: bookFor("swap_in"),
      swapOut: bookFor("swap_out"),
      generatedAt: Date.now(),
    });
  });

  // Live input bounds for the swap widget, derived from the same book quotes use.
  app.get("/api/limits", async (_request, reply) => {
    const limitsFor = (direction: "swap_in" | "swap_out") => {
      const book = buildBook(ctx.repo, direction);
      return {
        minSats: bookMinRoutableSats(book).toString(),
        maxRoutableSats: bookMaxRoutableSats(book).toString(),
      };
    };
    return reply.send({ swapIn: limitsFor("swap_in"), swapOut: limitsFor("swap_out") });
  });

  app.post("/api/quotes", async (request, reply) => {
    const body = parseOr400(quoteRequestSchema, request.body, reply);
    if (!body) return reply;
    const outcome = createQuote(ctx.repo, {
      direction: body.direction,
      amountSats: parseSats(body.amountSats),
    });
    if (!outcome.ok) {
      return reply.code(409).send({
        error: "insufficient_liquidity",
        message: "no combination of active LPs can route this amount right now",
        maxRoutableSats: outcome.maxRoutableSats.toString(),
      });
    }
    return reply.code(201).send(toQuoteDTO(outcome.quote));
  });

  app.post("/api/swaps", async (request, reply) => {
    const body = parseOr400(createSwapSchema, request.body, reply);
    if (!body) return reply;
    try {
      const { swap, legs } = await acceptQuote(ctx, {
        quoteId: body.quoteId,
        destination: body.destination,
        webhookUrl: body.webhookUrl ?? null,
      });
      const lpNames = new Map(ctx.repo.listLps().map((lp) => [lp.id, lp.name]));
      return reply.code(201).send(toSwapDTO(swap, legs, lpNames));
    } catch (err) {
      if (err instanceof QuoteNotFoundError) {
        return reply.code(404).send({ error: "not_found", message: err.message });
      }
      if (err instanceof QuoteExpiredError) {
        return reply.code(409).send({ error: "quote_expired", message: err.message });
      }
      if (err instanceof QuoteAlreadyAcceptedError) {
        return reply.code(409).send({ error: "quote_already_accepted", message: err.message });
      }
      if (err instanceof QuoteStaleError) {
        return reply.code(409).send({ error: "quote_stale", message: err.message });
      }
      throw err;
    }
  });

  app.get("/api/swaps/:id", async (request, reply) => {
    const params = parseOr400(idParamsSchema, request.params, reply);
    if (!params) return reply;
    const swap = ctx.repo.getSwap(params.id);
    if (!swap) {
      return reply.code(404).send({ error: "not_found", message: `swap ${params.id} not found` });
    }
    const lpNames = new Map(ctx.repo.listLps().map((lp) => [lp.id, lp.name]));
    return reply.send(toSwapDTO(swap, ctx.repo.listLegsForSwap(swap.id), lpNames));
  });

  // ---- dev-only helpers ------------------------------------------------------
  // Gated on non-production + mock adapter, and still behind the operator key:
  // a dev instance bound to 0.0.0.0 must not let a passer-by mint deposits.
  if (!config.devRoutesEnabled) return;

  await app.register(async (dev) => {
    dev.addHook("onRequest", requireOperatorKey);

    /**
     * The simulated chain these routes drive. In mock mode that is the whole
     * adapter; in tachi mode it is the embedded L1 the real adapter already
     * admits is simulated. Either way, nothing here can move real value.
     */
    const requireMock = (reply: FastifyReply): MockSettlementAdapter | null => {
      if (ctx.adapter instanceof MockSettlementAdapter) return ctx.adapter;
      if (ctx.adapter instanceof TachiRealSettlementAdapter) return ctx.adapter.simulatedL1();
      void reply
        .code(409)
        .send({ error: "unavailable", message: "simulation requires a simulated chain" });
      return null;
    };

    dev.post("/dev/simulate-onchain-deposit", async (request, reply) => {
      const body = parseOr400(simulateDepositSchema, request.body, reply);
      if (!body) return reply;
      const mock = requireMock(reply);
      if (!mock) return reply;
      const { txId } = mock.simulateOnchainDeposit(body.address, parseSats(body.amountSats));
      await deps.pokePoller();
      return reply.code(202).send({ txId, address: body.address, amountSats: body.amountSats });
    });

    dev.post("/dev/simulate-offchain-payment", async (request, reply) => {
      const body = parseOr400(simulateDepositSchema, request.body, reply);
      if (!body) return reply;
      const mock = requireMock(reply);
      if (!mock) return reply;
      const { transferId } = mock.simulateOffchainPayment(body.address, parseSats(body.amountSats));
      await deps.pokePoller();
      return reply.code(202).send({ transferId, address: body.address, amountSats: body.amountSats });
    });

    dev.post("/dev/advance-blocks", async (request, reply) => {
      const body = parseOr400(advanceBlocksSchema, request.body, reply);
      if (!body) return reply;
      const mock = requireMock(reply);
      if (!mock) return reply;
      mock.advanceBlocks(body.blocks);
      await deps.pokePoller();
      return reply.code(202).send({ blocks: body.blocks, height: mock.blockHeight() });
    });
  });
}
