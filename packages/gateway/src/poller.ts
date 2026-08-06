import {
  applyOffchainEvent,
  applyOnchainEvent,
  performLegAction,
  type LegAction,
  type ServiceContext,
} from "./domain/swaps";

export interface PollerOptions {
  ctx: ServiceContext;
  intervalMs: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Called after each tick that changed something — lets the webhook sweep run promptly. */
  onChanges?: () => void;
}

export interface PollResult {
  applied: number;
  actionsPerformed: number;
}

/**
 * One loop over both adapter cursors. The adapter calls are IO and happen
 * outside the transaction; both event batches plus both new cursors then
 * commit in ONE SQLite transaction. A crash before commit replays the same
 * batches on restart, which is safe because event application is idempotent
 * on eventId. Engine-side sends collected during application run after the
 * commit, each settling in its own small transaction.
 */
export class Poller {
  readonly #ctx: ServiceContext;
  readonly #intervalMs: number;
  readonly #log: (msg: string, meta?: Record<string, unknown>) => void;
  readonly #onChanges: () => void;
  #timer: NodeJS.Timeout | null = null;
  #inFlight = false;

  constructor(opts: PollerOptions) {
    this.#ctx = opts.ctx;
    this.#intervalMs = opts.intervalMs;
    this.#log = opts.log ?? (() => {});
    this.#onChanges = opts.onChanges ?? (() => {});
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.#log("poll tick failed", { error: err instanceof Error ? err.message : String(err) });
      });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One poll cycle. Safe to call directly in tests. */
  async tick(): Promise<PollResult> {
    if (this.#inFlight) return { applied: 0, actionsPerformed: 0 };
    this.#inFlight = true;
    try {
      const cursors = this.#ctx.repo.getCursors();
      const onchain = await this.#ctx.adapter.pollOnchain(cursors.onchain);
      const offchain = await this.#ctx.adapter.pollOffchain(cursors.offchain);

      const actions: LegAction[] = [];
      const applied = this.#ctx.repo.db.transaction(() => {
        const now = Date.now();
        for (const event of onchain.events) {
          actions.push(...applyOnchainEvent(this.#ctx, event, now));
        }
        for (const event of offchain.events) {
          actions.push(...applyOffchainEvent(this.#ctx, event, now));
        }
        this.#ctx.repo.setCursors(
          { onchain: onchain.nextCursor, offchain: offchain.nextCursor },
          now,
        );
        return onchain.events.length + offchain.events.length;
      })();

      for (const action of actions) {
        await performLegAction(this.#ctx, action);
      }

      if (applied > 0 || actions.length > 0) this.#onChanges();
      return { applied, actionsPerformed: actions.length };
    } finally {
      this.#inFlight = false;
    }
  }
}
