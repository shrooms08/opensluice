import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPIRY_SWEEP_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS,
} from "@opensluice/shared";
import type { AdapterMode, TachiAdapterConfig } from "@opensluice/adapter";

/** Production build output of apps/web, served by @fastify/static. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

export interface GatewayConfig {
  operatorKey: string;
  webhookSecret: string;
  dbPath: string;
  adapterMode: AdapterMode;
  port: number;
  host: string;
  pollIntervalMs: number;
  expirySweepIntervalMs: number;
  webhookSweepIntervalMs: number;
  /**
   * Dev-only OPERATOR routes (LP mock funding, deposit simulation, block
   * mining) are mounted only when this is true: never in production, never
   * with a non-mock adapter.
   */
  devRoutesEnabled: boolean;
  /**
   * Unauthenticated POST /dev/swaps/:id/pay-leg/:index for swap-page demos.
   * Effective only with the mock adapter outside production; loadConfig
   * refuses to boot when the env var is set with a non-mock adapter.
   */
  devPublicSimulate: boolean;
  /** Interval between SSE heartbeat events on /swap/api/:id/events. */
  sseHeartbeatMs: number;
  /** Directory holding the built swap app (apps/web/dist). */
  webDistPath: string;
  /** Present only when ADAPTER_MODE=tachi: the real off-chain settlement config. */
  tachi?: TachiAdapterConfig;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const operatorKey = env.OPENSLUICE_OPERATOR_KEY;
  if (!operatorKey) throw new Error("OPENSLUICE_OPERATOR_KEY is required (see .env.example)");

  const webhookSecret = env.OPENSLUICE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("OPENSLUICE_WEBHOOK_SECRET is required (see .env.example)");

  const rawMode = env.ADAPTER_MODE ?? "mock";
  if (rawMode !== "mock" && rawMode !== "tachi") {
    throw new Error(`ADAPTER_MODE must be "mock" or "tachi", got ${JSON.stringify(rawMode)}`);
  }
  const adapterMode: AdapterMode = rawMode;

  const rawSimulate = env.OPENSLUICE_DEV_PUBLIC_SIMULATE ?? "false";
  if (rawSimulate !== "true" && rawSimulate !== "false") {
    throw new Error(
      `OPENSLUICE_DEV_PUBLIC_SIMULATE must be "true" or "false", got ${JSON.stringify(rawSimulate)}`,
    );
  }
  if (rawSimulate === "true" && adapterMode !== "mock") {
    throw new Error(
      "OPENSLUICE_DEV_PUBLIC_SIMULATE=true requires ADAPTER_MODE=mock — unauthenticated payment " +
        "simulation must never reach a real settlement layer; refusing to boot",
    );
  }

  // Real Tachi settlement. Off-chain legs are real; L1 legs stay simulated
  // (see INTEGRATION.md) — the adapter reports that through its capabilities.
  let tachi: TachiAdapterConfig | undefined;
  if (adapterMode === "tachi") {
    const mnemonic = env.OPENSLUICE_TACHI_MNEMONIC;
    if (!mnemonic) {
      throw new Error(
        "ADAPTER_MODE=tachi requires OPENSLUICE_TACHI_MNEMONIC (BIP-39). " +
          "Run `npm run smoke:tachi` first — it generates and funds one on regtest.",
      );
    }
    const rawNetwork = env.OPENSLUICE_TACHI_NETWORK ?? "regtest";
    if (rawNetwork !== "regtest" && rawNetwork !== "signet") {
      throw new Error(`OPENSLUICE_TACHI_NETWORK must be "regtest" or "signet", got ${JSON.stringify(rawNetwork)}`);
    }
    tachi = {
      rpcUrl: env.OPENSLUICE_TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com",
      network: rawNetwork,
      mnemonic,
      statePath: env.OPENSLUICE_TACHI_STATE_PATH ?? "./tachi-adapter-state.json",
      apiKey: env.OPENSLUICE_TACHI_API_KEY,
      useWatch: env.OPENSLUICE_TACHI_USE_WATCH === "true",
    };
  }


  return {
    operatorKey,
    webhookSecret,
    dbPath: env.OPENSLUICE_DB_PATH ?? "./opensluice.db",
    adapterMode,
    port: intFromEnv(env, "PORT", 8080),
    host: env.HOST ?? "0.0.0.0",
    pollIntervalMs: intFromEnv(env, "POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    expirySweepIntervalMs: intFromEnv(
      env,
      "EXPIRY_SWEEP_INTERVAL_MS",
      DEFAULT_EXPIRY_SWEEP_INTERVAL_MS,
    ),
    webhookSweepIntervalMs: intFromEnv(
      env,
      "WEBHOOK_SWEEP_INTERVAL_MS",
      DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS,
    ),
    // Operator dev routes stay available in tachi mode: `/api/lp/fund` is how
    // an operator moves REAL off-chain value to an LP. The simulate/mine routes
    // inside it still check for the mock adapter themselves.
    devRoutesEnabled: env.NODE_ENV !== "production",
    devPublicSimulate:
      rawSimulate === "true" && adapterMode === "mock" && env.NODE_ENV !== "production",
    sseHeartbeatMs: intFromEnv(env, "SSE_HEARTBEAT_MS", DEFAULT_SSE_HEARTBEAT_MS),
    webDistPath: env.OPENSLUICE_WEB_DIST ?? DEFAULT_WEB_DIST,
    tachi,
  };
}
