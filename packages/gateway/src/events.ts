import { EventEmitter } from "node:events";
import type { Swap, SwapStatus } from "@opensluice/shared";

/**
 * Everything observable about a swap flows through here:
 * - `transition` — the swap's status changed (state machine move).
 * - `updated`   — a leg changed without moving the aggregate status
 *                 (deposit seen, confirmation progress, payout broadcast).
 */
export type SwapEvent =
  | { kind: "transition"; swap: Swap; from: SwapStatus; to: SwapStatus; at: number }
  | { kind: "updated"; swap: Swap; at: number };

/** Channel key for subscribe-to-everything consumers (the webhook dispatcher). */
const ALL = Symbol("opensluice:all-swaps");

/**
 * In-process pub/sub for swap changes: one channel per swap id plus a
 * firehose channel. Emission is synchronous, so a subscriber that writes to
 * the database (the webhook enqueuer) joins whatever SQLite transaction the
 * publisher currently holds — the "webhook row commits with the state change"
 * guarantee from OpenTill is preserved.
 */
export class SwapEventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(0);
  }

  publish(event: SwapEvent): void {
    this.#emitter.emit(ALL, event);
    this.#emitter.emit(event.swap.id, event);
  }

  /** Listen to a single swap's channel (SSE). Returns the unsubscribe function. */
  subscribe(swapId: string, listener: (event: SwapEvent) => void): () => void {
    this.#emitter.on(swapId, listener);
    return () => this.#emitter.off(swapId, listener);
  }

  /** Listen to every swap (webhook dispatcher). Returns the unsubscribe function. */
  subscribeAll(listener: (event: SwapEvent) => void): () => void {
    this.#emitter.on(ALL, listener);
    return () => this.#emitter.off(ALL, listener);
  }

  listenerCount(swapId: string): number {
    return this.#emitter.listenerCount(swapId);
  }
}
