# GAPS — known limits through Gate 3, honestly stated

Things the system does not solve yet, in rough order of how much they matter.

## Money-handling

- **Partial-funding resolution is manual.** At expiry, a swap with some legs paid
  becomes `partially_funded` — terminal. Received funds are written to `lp_ledger` as
  `stranded_deposit` rows and the legs are flagged `needs_manual_resolution`, but
  nothing refunds the user or completes the paid legs. A real resolution path needs a
  user refund address per swap and an operator tooling surface. Gate 3 made the flags
  visible (the LP history view shows a `manual` marker) but built no resolution tool.
- **Failed sends strand funds the same way.** If an LP-side send fails after funding,
  the swap is `failed`, the deposit is booked as stranded, and a human has to act.
  There is no automatic retry of sends — a send that failed transiently (adapter
  hiccup) could in principle be retried safely because leg state gates the action, but
  Gate 1 does not schedule one.
- **Under/overpayment is tolerated, not resolved.** Leg funding is threshold-based
  (cumulative deposits ≥ leg amount). An underpaid leg just sits `pending`; an overpaid
  leg settles with the LP silently keeping the excess. Neither refunds the difference.
- **A crash between the poll commit and the engine-side send loses the send trigger.**
  Event application and cursor advance are atomic, but the resulting `send_offchain` /
  `send_onchain` actions run after commit. If the process dies in between, a `confirmed`
  (swap_in) or `committed` (swap_out) leg is left waiting with no event to re-trigger
  it. Restart recovery should scan for legs in those states and re-emit actions.
- **A `settling` swap can hang forever on a never-confirming deposit.** 0-conf payment
  before the deadline counts as paid, so expiry ignores `settling` swaps. A tx that is
  seen but never confirms (or is double-spent — the mock cannot model that) leaves the
  swap stuck. Needs a confirmation timeout policy.

## Marketplace / routing

- **Quote-lock races under real concurrency.** Quotes lock nothing; acceptance
  re-validates inside a single SQLite transaction, which serializes on one node. With
  multiple gateway instances or a different DB, accept-time re-validation needs an
  explicit reservation scheme (short-lived holds with TTL) instead.
- **The split allocator is greedy with a one-step rebalance.** It prefers the cheapest
  bps first and can rescue a leftover stranded below the next LP's minimum, but it is
  not an optimal allocator: pathological min/max shapes exist where a feasible 3-way
  split is missed or a slightly cheaper allocation is passed over. Deterministic, yes;
  optimal, no.
- **`maxRoutableSats` on the 409 is an upper-bound estimate** (sum of top-3 usable
  chunks). Amounts at or below it can still be unroutable (e.g. below every LP's
  minimum). The UI should treat it as a hint, not a promise.
- **Destination addresses are not validated.** A user could set a swap destination that
  collides with another swap's deposit address; on the mock this could cross-credit a
  leg. Real adapters get real address validation; Gate 1 does not have it.

## LP economics

- **LP fee payout/settlement is still open.** Plainly: an LP can now SEE its earnings
  (the Gate 3 dashboard reads them straight from `lp_ledger`, and the totals are
  test-asserted against the ledger rows), but it still cannot WITHDRAW them. There is
  no payout instruction, no settlement schedule, no withdrawal path of any kind —
  fees just accumulate as ledger balance. A real payout flow needs an LP-supplied
  payout address, an operator-approved (or automatic) sweep, and adapter sends with
  their own failure handling.
- **LP solvency is self-reported mock state.** `lp_ledger` is credited by a dev route;
  no proof the LP actually controls funds on either chain. The real system needs
  deposits/collateral verified through the adapter.
- **No LP-side notifications.** LPs now have their own read API and a 5s-polling
  dashboard, but no push channel — a webhook per LP is still missing; exposure changes
  are only as fresh as the last poll.

## Operational

- **Late confirmations after a terminal swap are recorded, never credited** — the
  `leg_events` audit trail holds them, and stranded-deposit accounting only covers what
  was final at expiry. Money that confirms after expiry is visible but unbooked.
- **Quotes are never garbage-collected.** Expired quote rows accumulate.
- **Single operator, single node, SQLite.** Fine for Gate 1's scope; the coordinator is
  fully trusted (it books ledgers with no external attestation).
