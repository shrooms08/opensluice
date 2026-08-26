import type {
  LpBalances,
  LpEarnings,
  LpExposure,
  LpHistory,
  LpMe,
  Marketplace,
} from "../shared/types";

/**
 * OpenTill's key-handling pattern, verbatim: the LP API key lives in
 * sessionStorage only — cleared when the tab closes, never in a URL or
 * cookie. Acceptable for a self-hosted professional tool; the key never
 * leaves this browser except as the Authorization header to its own gateway.
 */
const KEY_STORAGE = "opensluice.lpKey";

export const UNAUTHORIZED_EVENT = "opensluice:lp-unauthorized";

export const getStoredKey = (): string | null => sessionStorage.getItem(KEY_STORAGE);
export const storeKey = (key: string): void => sessionStorage.setItem(KEY_STORAGE, key);
export const clearKey = (): void => sessionStorage.removeItem(KEY_STORAGE);

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${getStoredKey() ?? ""}`,
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "could not reach the gateway");
  }

  if (res.status === 401) {
    // Central 401 handling: drop the key and bounce the app to the prompt.
    clearKey();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(401, "LP API key rejected");
  }
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as {
        message?: string;
        details?: Array<{ path: string; message: string }>;
      };
      if (body.details?.length) {
        message = body.details.map((d) => `${d.path}: ${d.message}`).join("; ");
      } else if (body.message) {
        message = body.message;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface SettlementCapabilities {
  onchainReal: boolean;
  offchainReal: boolean;
  label: string;
  chainId: string | null;
}

export interface Health {
  ok: boolean;
  adapterMode: string;
  dbOk: boolean;
  /** What the running adapter actually settles — the banner reads this. */
  settlement?: SettlementCapabilities;
}

export interface LiquidityOffer {
  capacitySats: string;
  feeBps: number;
  feeFixedSats: string;
  minSats: string;
  maxSats: string;
  estSeconds: number;
}

export const api = {
  /** No-auth health probe; also reveals whether settlement is mock or real. */
  health: () => request<Health>("/healthz"),
  me: () => request<LpMe>("/api/lp/me"),
  balances: () => request<LpBalances>("/api/lp/balances"),
  exposure: () => request<LpExposure>("/api/lp/exposure"),

  earnings: (opts: { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    return request<LpEarnings>(`/api/lp/earnings?${params.toString()}`);
  },

  history: (opts: { status?: "settled" | "failed"; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    return request<LpHistory>(`/api/lp/history?${params.toString()}`);
  },

  putLiquidity: (body: { swapIn?: LiquidityOffer; swapOut?: LiquidityOffer }) =>
    request<unknown>("/api/lp/liquidity", { method: "PUT", body: JSON.stringify(body) }),

  /** Public book — used for the "your position in the book" preview. */
  marketplace: () => request<Marketplace>("/api/marketplace"),
};
