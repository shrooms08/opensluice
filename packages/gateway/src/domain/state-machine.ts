import type { LegStatus, SwapDirection, SwapStatus } from "@opensluice/shared";

/**
 * The ONE place swap transitions are defined. Everything that mutates
 * swap.status must route through `assertSwapTransition`.
 *
 *   pending ──► funding ──► settling ──► completed
 *      │     │      │  │         └──► failed
 *      │     │      │  └──► partially_funded (expiry with some legs paid)
 *      │     │      └──► failed (a send failed after funding)
 *      │     └──────────► settling (every leg paid in one observation)
 *      └──► expired (nothing paid within the funding window)
 *
 * funding = some legs paid; settling = every leg paid, engine-side work
 * (sends, confirmations) still running; completed = every leg settled.
 */
export const SWAP_TRANSITIONS: Readonly<Record<SwapStatus, readonly SwapStatus[]>> = Object.freeze({
  pending: ["funding", "settling", "expired"],
  funding: ["settling", "partially_funded", "failed"],
  settling: ["completed", "failed"],
  completed: [],
  expired: [],
  partially_funded: [],
  failed: [],
} as const);

/**
 * Per-direction leg maps. One status vocabulary, two machines: an on-chain
 * deposit confirms in blocks (swap_in), an off-chain deposit commits at once
 * (swap_out). Statuses a direction never visits map to [] so any attempt to
 * enter them fails loudly.
 *
 * swap_in leg:  pending ─► seen ─► confirmed ─► settled
 *                  └─► expired         └─► failed (off-chain send failed)
 *
 * swap_out leg: pending ─► committed ─► broadcasting ─► settled
 *                  └─► expired  └─► failed   └─► failed
 */
export const SWAP_IN_LEG_TRANSITIONS: Readonly<Record<LegStatus, readonly LegStatus[]>> =
  Object.freeze({
    pending: ["seen", "expired"],
    seen: ["confirmed"],
    confirmed: ["settled", "failed"],
    committed: [],
    broadcasting: [],
    settled: [],
    failed: [],
    expired: [],
  } as const);

export const SWAP_OUT_LEG_TRANSITIONS: Readonly<Record<LegStatus, readonly LegStatus[]>> =
  Object.freeze({
    pending: ["committed", "expired"],
    committed: ["broadcasting", "failed"],
    broadcasting: ["settled", "failed"],
    seen: [],
    confirmed: [],
    settled: [],
    failed: [],
    expired: [],
  } as const);

export function legTransitionsFor(
  direction: SwapDirection,
): Readonly<Record<LegStatus, readonly LegStatus[]>> {
  return direction === "swap_in" ? SWAP_IN_LEG_TRANSITIONS : SWAP_OUT_LEG_TRANSITIONS;
}

export class InvalidTransitionError extends Error {
  readonly from: string;
  readonly to: string;

  constructor(kind: "swap" | "leg", from: string, to: string, id?: string) {
    super(
      `illegal ${kind} transition ${from} -> ${to}` + (id ? ` (${kind} ${id})` : ""),
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionSwap(from: SwapStatus, to: SwapStatus): boolean {
  return SWAP_TRANSITIONS[from].includes(to);
}

export function assertSwapTransition(from: SwapStatus, to: SwapStatus, swapId?: string): void {
  if (!canTransitionSwap(from, to)) throw new InvalidTransitionError("swap", from, to, swapId);
}

export function canTransitionLeg(direction: SwapDirection, from: LegStatus, to: LegStatus): boolean {
  return legTransitionsFor(direction)[from].includes(to);
}

export function assertLegTransition(
  direction: SwapDirection,
  from: LegStatus,
  to: LegStatus,
  legId?: string,
): void {
  if (!canTransitionLeg(direction, from, to)) {
    throw new InvalidTransitionError("leg", from, to, legId);
  }
}

export function isSwapTerminal(status: SwapStatus): boolean {
  return SWAP_TRANSITIONS[status].length === 0;
}

/** A leg holds no capacity lock once it reaches one of these. */
export function isLegSettledOrDead(status: LegStatus): boolean {
  return status === "settled" || status === "failed" || status === "expired";
}
