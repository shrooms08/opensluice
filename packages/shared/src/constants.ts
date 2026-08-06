/** Quotes lock nothing, so they die fast. */
export const QUOTE_TTL_MS = 60_000;

/** How long an accepted swap waits for the user to pay before expiring. */
export const SWAP_FUNDING_WINDOW_MS = 15 * 60 * 1000;

/** A route never spreads across more than this many LPs. */
export const MAX_ROUTE_LEGS = 3;

/** Basis-point denominator for fee math. */
export const BPS_DENOMINATOR = 10_000n;

/** How often the poller asks the adapter for new settlement events. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** How often the swap expiry sweep runs. */
export const DEFAULT_EXPIRY_SWEEP_INTERVAL_MS = 5_000;

/** How often the webhook retry sweep runs. */
export const DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS = 5_000;

/** Delay before each retry, indexed by attempt count already made. Length == max attempts. */
export const WEBHOOK_BACKOFF_MS = [0, 5_000, 30_000, 120_000, 600_000] as const;

/** Total delivery attempts before a webhook is abandoned. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MS.length;

export const WEBHOOK_SIGNATURE_HEADER = "x-opensluice-signature";

/** Interval between `event: heartbeat` frames on the public SSE stream. */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

export const SATS_PER_BTC = 100_000_000n;
