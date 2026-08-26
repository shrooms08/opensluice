import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { createAdapter, type SettlementAdapter } from "@opensluice/adapter";
import type { GatewayConfig } from "./config";
import { openDb, type Db } from "./db";
import { Repo } from "./db/repo";
import { expireDueSwaps, type ServiceContext } from "./domain/swaps";
import { SwapEventBus } from "./events";
import { Poller } from "./poller";
import { registerPublicRoutes } from "./public-routes";
import { registerRoutes } from "./routes";
import { WebhookDispatcher } from "./webhooks";

export interface AppOverrides {
  adapter?: SettlementAdapter;
  db?: Db;
  logger?: boolean;
}

export interface App {
  app: FastifyInstance;
  config: GatewayConfig;
  db: Db;
  repo: Repo;
  adapter: SettlementAdapter;
  ctx: ServiceContext;
  events: SwapEventBus;
  poller: Poller;
  webhooks: WebhookDispatcher;
  /** Start the poller, expiry sweep and webhook retry timers. */
  startBackgroundJobs(): void;
  stopBackgroundJobs(): void;
  close(): Promise<void>;
}

/**
 * Wires config -> adapter -> db -> services -> HTTP. Background timers are NOT
 * started here so tests can drive `poller.tick()` deterministically.
 */
export async function createApp(config: GatewayConfig, overrides: AppOverrides = {}): Promise<App> {
  // The adapter is built before Fastify exists, so its boot log goes to a shim
  // that simply prints — the adapter's connection banner is worth seeing early.
  const app0 = {
    log: {
      info: (meta: Record<string, unknown>, msg: string) =>
        console.log(`[adapter] ${msg}`, Object.keys(meta).length ? meta : ""),
    },
  };
  const adapter =
    overrides.adapter ??
    createAdapter({
      mode: config.adapterMode,
      tachi: config.tachi ? { ...config.tachi, log: (msg, meta) => app0.log.info(meta ?? {}, msg) } : undefined,
    });
  await adapter.init();

  const db = overrides.db ?? openDb(config.dbPath);
  const repo = new Repo(db);

  // forceCloseConnections: open SSE streams must not block shutdown.
  const app = Fastify({ logger: overrides.logger ?? false, forceCloseConnections: true });

  const webhooks = new WebhookDispatcher({
    repo,
    secret: config.webhookSecret,
    sweepIntervalMs: config.webhookSweepIntervalMs,
    log: (msg, meta) => app.log.warn(meta ?? {}, msg),
  });

  const events = new SwapEventBus();

  // The webhook dispatcher consumes the same bus the SSE handlers do, but
  // only cares about state-machine moves. The subscription is synchronous, so
  // each delivery row is written inside the same SQLite transaction as the
  // state change that produced it.
  events.subscribeAll((event) => {
    if (event.kind === "transition") {
      webhooks.enqueue(event.swap, event.from, event.to, event.at);
    }
  });

  const ctx: ServiceContext = { repo, adapter, events };

  const flushWebhooks = () => {
    void webhooks.sweep().catch(() => {
      /* failures are recorded per-delivery; the sweep will retry */
    });
  };

  const poller = new Poller({
    ctx,
    intervalMs: config.pollIntervalMs,
    log: (msg, meta) => app.log.error(meta ?? {}, msg),
    onChanges: flushWebhooks,
  });

  let expiryTimer: NodeJS.Timeout | null = null;

  const startBackgroundJobs = (): void => {
    poller.start();
    webhooks.start();
    if (!expiryTimer) {
      expiryTimer = setInterval(() => {
        try {
          if (expireDueSwaps(ctx) > 0) flushWebhooks();
        } catch (err) {
          app.log.error({ err }, "expiry sweep failed");
        }
      }, config.expirySweepIntervalMs);
      expiryTimer.unref?.();
    }
  };

  const stopBackgroundJobs = (): void => {
    poller.stop();
    webhooks.stop();
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = null;
  };

  // Built swap-app bundle, when present. `wildcard: false` registers one route
  // per existing file (index.html, /assets/*) instead of a catch-all, so API
  // routes can never be shadowed.
  const webDistAvailable = existsSync(join(config.webDistPath, "index.html"));
  if (webDistAvailable) {
    await app.register(fastifyStatic, {
      root: config.webDistPath,
      prefix: "/",
      index: false,
      wildcard: false,
    });
  }

  const pokePoller = async () => {
    await poller.tick();
  };

  await registerRoutes(app, { config, ctx, flushWebhooks, pokePoller });
  await registerPublicRoutes(app, { config, ctx, pokePoller, webDistAvailable });

  return {
    app,
    config,
    db,
    repo,
    adapter,
    ctx,
    events,
    poller,
    webhooks,
    startBackgroundJobs,
    stopBackgroundJobs,
    async close() {
      stopBackgroundJobs();
      await app.close();
      await adapter.close?.();
      db.close();
    },
  };
}
