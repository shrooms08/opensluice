import { randomUUID } from "node:crypto";
import type {
  LedgerChain,
  LedgerEntryType,
  LegStatus,
  Lp,
  LpLedgerEntry,
  LpLiquidity,
  LpStatus,
  Quote,
  QuoteLeg,
  Swap,
  SwapDirection,
  SwapLeg,
  SwapStatus,
} from "@opensluice/shared";
import type { Db } from "./index";

// ---- row shapes -------------------------------------------------------------

interface LpRow {
  id: string;
  name: string;
  api_key_hash: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface LiquidityRow {
  lp_id: string;
  direction: string;
  capacity_sats: string;
  fee_bps: number;
  fee_fixed_sats: string;
  min_sats: string;
  max_sats: string;
  est_seconds: number;
  updated_at: number;
}

interface LedgerRow {
  id: string;
  lp_id: string;
  chain: string;
  swap_id: string | null;
  leg_id: string | null;
  entry_type: string;
  amount_sats: string;
  created_at: number;
}

interface QuoteRow {
  id: string;
  direction: string;
  amount_sats: string;
  total_fee_sats: string;
  est_seconds: number;
  legs_json: string;
  status: string;
  created_at: number;
  expires_at: number;
}

interface SwapRow {
  id: string;
  quote_id: string;
  direction: string;
  status: string;
  amount_sats: string;
  total_fee_sats: string;
  destination: string;
  webhook_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  completed_at: number | null;
}

interface LegRow {
  id: string;
  swap_id: string;
  lp_id: string;
  amount_sats: string;
  fee_sats: string;
  est_seconds: number;
  status: string;
  deposit_address: string;
  payout_tx_id: string | null;
  payout_transfer_id: string | null;
  error: string | null;
  needs_manual_resolution: number;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

export interface LegEvent {
  id: string;
  eventId: string;
  legId: string;
  chain: LedgerChain;
  kind: "deposit" | "payout";
  txRef: string;
  amountSats: bigint;
  status: "seen" | "confirmed" | "committed";
  /** On-chain confirmation count at observation; null for off-chain events. */
  confirmations: number | null;
  observedAt: number;
  createdAt: number;
}

interface LegEventRow {
  id: string;
  event_id: string;
  leg_id: string;
  chain: string;
  kind: string;
  tx_ref: string;
  amount_sats: string;
  status: string;
  confirmations: number | null;
  observed_at: number;
  created_at: number;
}

export interface WebhookDelivery {
  id: string;
  swapId: string;
  url: string;
  body: string;
  signature: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WebhookRow {
  id: string;
  swap_id: string;
  url: string;
  body: string;
  signature: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

// ---- row -> domain ----------------------------------------------------------

function rowToLp(row: LpRow): Lp {
  return {
    id: row.id,
    name: row.name,
    status: row.status as LpStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLiquidity(row: LiquidityRow): LpLiquidity {
  return {
    lpId: row.lp_id,
    direction: row.direction as SwapDirection,
    capacitySats: BigInt(row.capacity_sats),
    feeBps: row.fee_bps,
    feeFixedSats: BigInt(row.fee_fixed_sats),
    minSats: BigInt(row.min_sats),
    maxSats: BigInt(row.max_sats),
    estSeconds: row.est_seconds,
    updatedAt: row.updated_at,
  };
}

function rowToLedger(row: LedgerRow): LpLedgerEntry {
  return {
    id: row.id,
    lpId: row.lp_id,
    chain: row.chain as LedgerChain,
    swapId: row.swap_id,
    legId: row.leg_id,
    entryType: row.entry_type as LedgerEntryType,
    amountSats: BigInt(row.amount_sats),
    createdAt: row.created_at,
  };
}

interface QuoteLegJson {
  lpId: string;
  lpName: string;
  amountSats: string;
  feeSats: string;
  estSeconds: number;
}

function rowToQuote(row: QuoteRow): Quote {
  const legsJson = JSON.parse(row.legs_json) as QuoteLegJson[];
  const legs: QuoteLeg[] = legsJson.map((l) => ({
    lpId: l.lpId,
    lpName: l.lpName,
    amountSats: BigInt(l.amountSats),
    feeSats: BigInt(l.feeSats),
    estSeconds: l.estSeconds,
  }));
  return {
    id: row.id,
    direction: row.direction as SwapDirection,
    amountSats: BigInt(row.amount_sats),
    totalFeeSats: BigInt(row.total_fee_sats),
    estSeconds: row.est_seconds,
    legs,
    status: row.status as Quote["status"],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function rowToSwap(row: SwapRow): Swap {
  return {
    id: row.id,
    quoteId: row.quote_id,
    direction: row.direction as SwapDirection,
    status: row.status as SwapStatus,
    amountSats: BigInt(row.amount_sats),
    totalFeeSats: BigInt(row.total_fee_sats),
    destination: row.destination,
    webhookUrl: row.webhook_url,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

function rowToLeg(row: LegRow): SwapLeg {
  return {
    id: row.id,
    swapId: row.swap_id,
    lpId: row.lp_id,
    amountSats: BigInt(row.amount_sats),
    feeSats: BigInt(row.fee_sats),
    estSeconds: row.est_seconds,
    status: row.status as LegStatus,
    depositAddress: row.deposit_address,
    payoutTxId: row.payout_tx_id,
    payoutTransferId: row.payout_transfer_id,
    error: row.error,
    needsManualResolution: row.needs_manual_resolution === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

function rowToLegEvent(row: LegEventRow): LegEvent {
  return {
    id: row.id,
    eventId: row.event_id,
    legId: row.leg_id,
    chain: row.chain as LedgerChain,
    kind: row.kind as LegEvent["kind"],
    txRef: row.tx_ref,
    amountSats: BigInt(row.amount_sats),
    status: row.status as LegEvent["status"],
    confirmations: row.confirmations,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  };
}

function rowToWebhook(row: WebhookRow): WebhookDelivery {
  return {
    id: row.id,
    swapId: row.swap_id,
    url: row.url,
    body: row.body,
    signature: row.signature,
    status: row.status as WebhookDelivery["status"],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Swap statuses that hold capacity locks on their unsettled legs. */
const IN_FLIGHT_SWAP_STATUSES = ["pending", "funding", "settling"] as const;

/** Leg statuses whose lock has already been released (converted or abandoned). */
const UNLOCKED_LEG_STATUSES = ["settled", "failed", "expired"] as const;

export class Repo {
  constructor(readonly db: Db) {}

  // ---- LPs ------------------------------------------------------------------

  insertLp(params: { name: string; apiKeyHash: string }, now: number = Date.now()): Lp {
    const id = `lp_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO lps (id, name, api_key_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, params.name, params.apiKeyHash, now, now);
    return this.getLp(id)!;
  }

  getLp(id: string): Lp | null {
    const row = this.db.prepare<[string], LpRow>("SELECT * FROM lps WHERE id = ?").get(id);
    return row ? rowToLp(row) : null;
  }

  getLpByKeyHash(hash: string): Lp | null {
    const row = this.db
      .prepare<[string], LpRow>("SELECT * FROM lps WHERE api_key_hash = ?")
      .get(hash);
    return row ? rowToLp(row) : null;
  }

  listLps(): Lp[] {
    return this.db
      .prepare<[], LpRow>("SELECT * FROM lps ORDER BY created_at ASC")
      .all()
      .map(rowToLp);
  }

  setLpStatus(id: string, status: LpStatus, now: number = Date.now()): Lp | null {
    this.db.prepare("UPDATE lps SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    return this.getLp(id);
  }

  // ---- liquidity ------------------------------------------------------------

  upsertLiquidity(
    params: {
      lpId: string;
      direction: SwapDirection;
      capacitySats: bigint;
      feeBps: number;
      feeFixedSats: bigint;
      minSats: bigint;
      maxSats: bigint;
      estSeconds: number;
    },
    now: number = Date.now(),
  ): LpLiquidity {
    this.db
      .prepare(
        `INSERT INTO lp_liquidity
           (lp_id, direction, capacity_sats, fee_bps, fee_fixed_sats, min_sats, max_sats, est_seconds, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (lp_id, direction) DO UPDATE SET
           capacity_sats = excluded.capacity_sats,
           fee_bps = excluded.fee_bps,
           fee_fixed_sats = excluded.fee_fixed_sats,
           min_sats = excluded.min_sats,
           max_sats = excluded.max_sats,
           est_seconds = excluded.est_seconds,
           updated_at = excluded.updated_at`,
      )
      .run(
        params.lpId,
        params.direction,
        params.capacitySats.toString(),
        params.feeBps,
        params.feeFixedSats.toString(),
        params.minSats.toString(),
        params.maxSats.toString(),
        params.estSeconds,
        now,
      );
    return this.getLiquidity(params.lpId, params.direction)!;
  }

  getLiquidity(lpId: string, direction: SwapDirection): LpLiquidity | null {
    const row = this.db
      .prepare<[string, string], LiquidityRow>(
        "SELECT * FROM lp_liquidity WHERE lp_id = ? AND direction = ?",
      )
      .get(lpId, direction);
    return row ? rowToLiquidity(row) : null;
  }

  listLiquidity(direction: SwapDirection): LpLiquidity[] {
    return this.db
      .prepare<[string], LiquidityRow>(
        "SELECT * FROM lp_liquidity WHERE direction = ? ORDER BY lp_id ASC",
      )
      .all(direction)
      .map(rowToLiquidity);
  }

  // ---- ledger ---------------------------------------------------------------

  insertLedgerEntry(
    params: {
      lpId: string;
      chain: LedgerChain;
      swapId?: string | null;
      legId?: string | null;
      entryType: LedgerEntryType;
      amountSats: bigint;
    },
    now: number = Date.now(),
  ): LpLedgerEntry {
    const id = `led_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO lp_ledger (id, lp_id, chain, swap_id, leg_id, entry_type, amount_sats, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.lpId,
        params.chain,
        params.swapId ?? null,
        params.legId ?? null,
        params.entryType,
        params.amountSats.toString(),
        now,
      );
    const row = this.db.prepare<[string], LedgerRow>("SELECT * FROM lp_ledger WHERE id = ?").get(id)!;
    return rowToLedger(row);
  }

  /** Sum of an LP's signed ledger rows on one chain — what it actually holds. */
  ledgerBalance(lpId: string, chain: LedgerChain): bigint {
    const rows = this.db
      .prepare<[string, string], { amount_sats: string }>(
        "SELECT amount_sats FROM lp_ledger WHERE lp_id = ? AND chain = ?",
      )
      .all(lpId, chain);
    return rows.reduce((sum, r) => sum + BigInt(r.amount_sats), 0n);
  }

  listLedgerForSwap(swapId: string): LpLedgerEntry[] {
    return this.db
      .prepare<[string], LedgerRow>(
        "SELECT * FROM lp_ledger WHERE swap_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(swapId)
      .map(rowToLedger);
  }

  listLedgerForLp(lpId: string): LpLedgerEntry[] {
    return this.db
      .prepare<[string], LedgerRow>(
        "SELECT * FROM lp_ledger WHERE lp_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(lpId)
      .map(rowToLedger);
  }

  /**
   * Sats locked against an LP in one direction: the user-side amounts of every
   * unsettled leg of every in-flight swap. Derived, never stored, so it can't
   * drift from reality.
   */
  lockedSats(lpId: string, direction: SwapDirection): bigint {
    const rows = this.db
      .prepare<unknown[], { amount_sats: string }>(
        `SELECT l.amount_sats FROM swap_legs l
         JOIN swaps s ON s.id = l.swap_id
         WHERE l.lp_id = ? AND s.direction = ?
           AND s.status IN (${IN_FLIGHT_SWAP_STATUSES.map(() => "?").join(", ")})
           AND l.status NOT IN (${UNLOCKED_LEG_STATUSES.map(() => "?").join(", ")})`,
      )
      .all(lpId, direction, ...IN_FLIGHT_SWAP_STATUSES, ...UNLOCKED_LEG_STATUSES);
    return rows.reduce((sum, r) => sum + BigInt(r.amount_sats), 0n);
  }

  // ---- LP-scoped reads --------------------------------------------------------
  // Every query here filters on lp_id — the isolation boundary for the LP API.

  /**
   * The LP's in-flight legs (both directions): exactly the rows lockedSats
   * counts, with the swap's direction joined in. Newest first.
   */
  listExposureLegsForLp(lpId: string): Array<{ leg: SwapLeg; direction: SwapDirection }> {
    return this.db
      .prepare<unknown[], LegRow & { swap_direction: string }>(
        `SELECT l.*, s.direction AS swap_direction FROM swap_legs l
         JOIN swaps s ON s.id = l.swap_id
         WHERE l.lp_id = ?
           AND s.status IN (${IN_FLIGHT_SWAP_STATUSES.map(() => "?").join(", ")})
           AND l.status NOT IN (${UNLOCKED_LEG_STATUSES.map(() => "?").join(", ")})
         ORDER BY l.created_at DESC, l.rowid DESC`,
      )
      .all(lpId, ...IN_FLIGHT_SWAP_STATUSES, ...UNLOCKED_LEG_STATUSES)
      .map((row) => ({ leg: rowToLeg(row), direction: row.swap_direction as SwapDirection }));
  }

  /** Settled legs, newest settlement first — the LP's earnings rows. */
  listSettledLegsForLp(
    lpId: string,
    page: { limit: number; offset: number },
  ): Array<{ leg: SwapLeg; direction: SwapDirection }> {
    return this.db
      .prepare<[string, number, number], LegRow & { swap_direction: string }>(
        `SELECT l.*, s.direction AS swap_direction FROM swap_legs l
         JOIN swaps s ON s.id = l.swap_id
         WHERE l.lp_id = ? AND l.status = 'settled'
         ORDER BY l.settled_at DESC, l.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(lpId, page.limit, page.offset)
      .map((row) => ({ leg: rowToLeg(row), direction: row.swap_direction as SwapDirection }));
  }

  countSettledLegsForLp(lpId: string): number {
    return this.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM swap_legs WHERE lp_id = ? AND status = 'settled'",
      )
      .get(lpId)!.n;
  }

  /** Closed (settled/failed) legs for the history view, filterable. */
  listClosedLegsForLp(
    lpId: string,
    query: { status?: "settled" | "failed"; direction?: SwapDirection; limit: number; offset: number },
  ): Array<{ leg: SwapLeg; direction: SwapDirection }> {
    const { clause, values } = this.closedLegsWhere(lpId, query);
    return this.db
      .prepare<unknown[], LegRow & { swap_direction: string }>(
        `SELECT l.*, s.direction AS swap_direction FROM swap_legs l
         JOIN swaps s ON s.id = l.swap_id
         ${clause}
         ORDER BY COALESCE(l.settled_at, l.updated_at) DESC, l.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, query.limit, query.offset)
      .map((row) => ({ leg: rowToLeg(row), direction: row.swap_direction as SwapDirection }));
  }

  countClosedLegsForLp(
    lpId: string,
    query: { status?: "settled" | "failed"; direction?: SwapDirection },
  ): number {
    const { clause, values } = this.closedLegsWhere(lpId, query);
    return this.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM swap_legs l JOIN swaps s ON s.id = l.swap_id ${clause}`,
      )
      .get(...values)!.n;
  }

  private closedLegsWhere(
    lpId: string,
    query: { status?: "settled" | "failed"; direction?: SwapDirection },
  ): { clause: string; values: unknown[] } {
    const where = ["l.lp_id = ?"];
    const values: unknown[] = [lpId];
    if (query.status) {
      where.push("l.status = ?");
      values.push(query.status);
    } else {
      where.push("l.status IN ('settled', 'failed')");
    }
    if (query.direction) {
      where.push("s.direction = ?");
      values.push(query.direction);
    }
    return { clause: `WHERE ${where.join(" AND ")}`, values };
  }

  /**
   * Lifetime fees earned, straight from the ledger: the four swap entry types
   * of one leg sum to exactly its fee, so summing them across the LP gives
   * total fees — the same rows an auditor would add up.
   */
  totalSwapFeesSats(lpId: string): bigint {
    const rows = this.db
      .prepare<[string], { amount_sats: string }>(
        `SELECT amount_sats FROM lp_ledger
         WHERE lp_id = ? AND entry_type IN
           ('swap_in_deposit', 'swap_in_payout', 'swap_out_deposit', 'swap_out_payout')`,
      )
      .all(lpId);
    return rows.reduce((sum, r) => sum + BigInt(r.amount_sats), 0n);
  }

  // ---- quotes ---------------------------------------------------------------

  insertQuote(
    params: {
      direction: SwapDirection;
      amountSats: bigint;
      totalFeeSats: bigint;
      estSeconds: number;
      legs: QuoteLeg[];
      expiresAt: number;
    },
    now: number = Date.now(),
  ): Quote {
    const id = `q_${randomUUID()}`;
    const legsJson = JSON.stringify(
      params.legs.map((l) => ({
        lpId: l.lpId,
        lpName: l.lpName,
        amountSats: l.amountSats.toString(),
        feeSats: l.feeSats.toString(),
        estSeconds: l.estSeconds,
      })),
    );
    this.db
      .prepare(
        `INSERT INTO quotes (id, direction, amount_sats, total_fee_sats, est_seconds, legs_json, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        params.direction,
        params.amountSats.toString(),
        params.totalFeeSats.toString(),
        params.estSeconds,
        legsJson,
        now,
        params.expiresAt,
      );
    return this.getQuote(id)!;
  }

  getQuote(id: string): Quote | null {
    const row = this.db.prepare<[string], QuoteRow>("SELECT * FROM quotes WHERE id = ?").get(id);
    return row ? rowToQuote(row) : null;
  }

  markQuoteAccepted(id: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").run(id);
    void now;
  }

  // ---- swaps ----------------------------------------------------------------

  insertSwap(
    params: {
      quoteId: string;
      direction: SwapDirection;
      amountSats: bigint;
      totalFeeSats: bigint;
      destination: string;
      webhookUrl: string | null;
      expiresAt: number;
    },
    now: number = Date.now(),
  ): Swap {
    const id = `sw_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO swaps (id, quote_id, direction, status, amount_sats, total_fee_sats, destination, webhook_url, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.quoteId,
        params.direction,
        params.amountSats.toString(),
        params.totalFeeSats.toString(),
        params.destination,
        params.webhookUrl,
        now,
        now,
        params.expiresAt,
      );
    return this.getSwap(id)!;
  }

  getSwap(id: string): Swap | null {
    const row = this.db.prepare<[string], SwapRow>("SELECT * FROM swaps WHERE id = ?").get(id);
    return row ? rowToSwap(row) : null;
  }

  updateSwap(
    id: string,
    patch: {
      status?: SwapStatus;
      error?: string | null;
      completedAt?: number | null;
    },
    now: number = Date.now(),
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      values.push(patch.error);
    }
    if (patch.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(patch.completedAt);
    }
    values.push(id);
    this.db.prepare(`UPDATE swaps SET ${sets.join(", ")} WHERE id = ?`).run(...(values as []));
  }

  listSwaps(query: {
    status?: SwapStatus;
    direction?: SwapDirection;
    limit: number;
    offset: number;
  }): Swap[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.status) {
      where.push("status = ?");
      values.push(query.status);
    }
    if (query.direction) {
      where.push("direction = ?");
      values.push(query.direction);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare<unknown[], SwapRow>(
        `SELECT * FROM swaps ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, query.limit, query.offset)
      .map(rowToSwap);
  }

  countSwaps(status?: SwapStatus, direction?: SwapDirection): number {
    const where: string[] = [];
    const values: unknown[] = [];
    if (status) {
      where.push("status = ?");
      values.push(status);
    }
    if (direction) {
      where.push("direction = ?");
      values.push(direction);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const row = this.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM swaps ${clause}`)
      .get(...(values as []));
    return row?.n ?? 0;
  }

  /** Swaps whose funding window has closed and that can still expire. */
  findExpirableSwaps(now: number): Swap[] {
    return this.db
      .prepare<[number], SwapRow>(
        `SELECT * FROM swaps WHERE status IN ('pending', 'funding') AND expires_at <= ?`,
      )
      .all(now)
      .map(rowToSwap);
  }

  // ---- legs -----------------------------------------------------------------

  insertLeg(
    params: {
      swapId: string;
      lpId: string;
      amountSats: bigint;
      feeSats: bigint;
      estSeconds: number;
      depositAddress: string;
    },
    now: number = Date.now(),
  ): SwapLeg {
    const id = `leg_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO swap_legs (id, swap_id, lp_id, amount_sats, fee_sats, est_seconds, status, deposit_address, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        params.swapId,
        params.lpId,
        params.amountSats.toString(),
        params.feeSats.toString(),
        params.estSeconds,
        params.depositAddress,
        now,
        now,
      );
    return this.getLeg(id)!;
  }

  getLeg(id: string): SwapLeg | null {
    const row = this.db.prepare<[string], LegRow>("SELECT * FROM swap_legs WHERE id = ?").get(id);
    return row ? rowToLeg(row) : null;
  }

  listLegsForSwap(swapId: string): SwapLeg[] {
    // rowid preserves insertion order — leg N here is leg N of the quote, so
    // public leg indexes stay stable across every read path.
    return this.db
      .prepare<[string], LegRow>("SELECT * FROM swap_legs WHERE swap_id = ? ORDER BY rowid ASC")
      .all(swapId)
      .map(rowToLeg);
  }

  findLegByDepositAddress(address: string): SwapLeg | null {
    const row = this.db
      .prepare<[string], LegRow>("SELECT * FROM swap_legs WHERE deposit_address = ?")
      .get(address);
    return row ? rowToLeg(row) : null;
  }

  findLegByPayoutTxId(txId: string): SwapLeg | null {
    const row = this.db
      .prepare<[string], LegRow>("SELECT * FROM swap_legs WHERE payout_tx_id = ?")
      .get(txId);
    return row ? rowToLeg(row) : null;
  }

  updateLeg(
    id: string,
    patch: {
      status?: LegStatus;
      payoutTxId?: string | null;
      payoutTransferId?: string | null;
      error?: string | null;
      needsManualResolution?: boolean;
      settledAt?: number | null;
    },
    now: number = Date.now(),
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.payoutTxId !== undefined) {
      sets.push("payout_tx_id = ?");
      values.push(patch.payoutTxId);
    }
    if (patch.payoutTransferId !== undefined) {
      sets.push("payout_transfer_id = ?");
      values.push(patch.payoutTransferId);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      values.push(patch.error);
    }
    if (patch.needsManualResolution !== undefined) {
      sets.push("needs_manual_resolution = ?");
      values.push(patch.needsManualResolution ? 1 : 0);
    }
    if (patch.settledAt !== undefined) {
      sets.push("settled_at = ?");
      values.push(patch.settledAt);
    }
    values.push(id);
    this.db.prepare(`UPDATE swap_legs SET ${sets.join(", ")} WHERE id = ?`).run(...(values as []));
  }

  // ---- leg events -----------------------------------------------------------

  hasLegEvent(eventId: string): boolean {
    return (
      this.db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM leg_events WHERE event_id = ?",
        )
        .get(eventId)!.n > 0
    );
  }

  insertLegEvent(
    params: {
      eventId: string;
      legId: string;
      chain: LedgerChain;
      kind: "deposit" | "payout";
      txRef: string;
      amountSats: bigint;
      status: "seen" | "confirmed" | "committed";
      confirmations?: number | null;
      observedAt: number;
    },
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO leg_events (id, event_id, leg_id, chain, kind, tx_ref, amount_sats, status, confirmations, observed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `lev_${randomUUID()}`,
        params.eventId,
        params.legId,
        params.chain,
        params.kind,
        params.txRef,
        params.amountSats.toString(),
        params.status,
        params.confirmations ?? null,
        params.observedAt,
        now,
      );
  }

  listEventsForLeg(legId: string): LegEvent[] {
    return this.db
      .prepare<[string], LegEventRow>(
        "SELECT * FROM leg_events WHERE leg_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(legId)
      .map(rowToLegEvent);
  }

  // ---- webhooks -------------------------------------------------------------

  enqueueWebhook(
    params: { swapId: string; url: string; body: string; signature: string },
    now: number = Date.now(),
  ): string {
    const id = `wh_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries (id, swap_id, url, body, signature, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(id, params.swapId, params.url, params.body, params.signature, now, now, now);
    return id;
  }

  getWebhook(id: string): WebhookDelivery | null {
    const row = this.db
      .prepare<[string], WebhookRow>("SELECT * FROM webhook_deliveries WHERE id = ?")
      .get(id);
    return row ? rowToWebhook(row) : null;
  }

  findDueWebhooks(now: number): WebhookDelivery[] {
    return this.db
      .prepare<[number], WebhookRow>(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC`,
      )
      .all(now)
      .map(rowToWebhook);
  }

  listWebhooksForSwap(swapId: string): WebhookDelivery[] {
    return this.db
      .prepare<[string], WebhookRow>(
        "SELECT * FROM webhook_deliveries WHERE swap_id = ? ORDER BY created_at ASC",
      )
      .all(swapId)
      .map(rowToWebhook);
  }

  recordWebhookAttempt(
    id: string,
    result: {
      status: WebhookDelivery["status"];
      attempts: number;
      nextAttemptAt: number;
      statusCode: number | null;
      error: string | null;
    },
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = ?, attempts = ?, next_attempt_at = ?, last_status_code = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(result.status, result.attempts, result.nextAttemptAt, result.statusCode, result.error, now, id);
  }

  // ---- adapter cursors ------------------------------------------------------

  getCursors(): { onchain: string | null; offchain: string | null } {
    const row = this.db
      .prepare<[], { onchain_cursor: string | null; offchain_cursor: string | null }>(
        "SELECT onchain_cursor, offchain_cursor FROM adapter_state WHERE id = 1",
      )
      .get()!;
    return { onchain: row.onchain_cursor, offchain: row.offchain_cursor };
  }

  setCursors(
    cursors: { onchain: string | null; offchain: string | null },
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        "UPDATE adapter_state SET onchain_cursor = ?, offchain_cursor = ?, updated_at = ? WHERE id = 1",
      )
      .run(cursors.onchain, cursors.offchain, now);
  }
}
