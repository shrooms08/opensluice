# GAPS — known limits, honestly stated

Things the system does not solve yet, in rough order of how much they matter.

## Money-handling

- **Partial-funding resolution is manual.** At expiry, a swap with some legs paid
  becomes `partially_funded` — terminal. Received funds are written to `lp_ledger` as
  `stranded_deposit` rows and the legs are flagged `needs_manual_resolution`, but
  nothing refunds the user or completes the paid legs. A real resolution path needs a
  user refund address per swap and an operator tooling surface. The flags are visible (the
  LP history view shows a `manual` marker) but there is no resolution tool, and the user-
  facing copy says so rather than promising a refund that cannot happen.
- **Failed sends strand funds the same way.** If an LP-side send fails after funding,
  the swap is `failed`, the deposit is booked as stranded, and a human has to act.
  There is no automatic retry of sends — a send that failed transiently (adapter
  hiccup) could in principle be retried safely because leg state gates the action, but
  the engine does not schedule one.
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
  re-validates inside a single SQLite transaction, which serializes on one node — so on
  this deployment a stale quote is always caught and answered with a 409 the widget
  re-quotes from, showing the user the honest delta. That guarantee is an artifact of one
  process on one database. With multiple gateway instances, or any DB without this
  serialization, two accepts can pass re-validation against the same capacity and both
  commit; the second LP is then short. Fixing it properly needs an explicit reservation
  scheme (short-lived capacity holds with a TTL, released on accept or expiry) rather
  than optimistic re-validation.
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
  leg. Real adapters get real address validation; this build does not have it.

## LP economics

- **LP fee payout/settlement is still open.** Plainly: an LP can now SEE its earnings
  (the provider console reads them straight from `lp_ledger`, and the totals are
  test-asserted against the ledger rows), but it still cannot WITHDRAW them. There is
  no payout instruction, no settlement schedule, no withdrawal path of any kind —
  fees just accumulate as ledger balance. A real payout flow needs an LP-supplied
  payout address, an operator-approved (or automatic) sweep, and adapter sends with
  their own failure handling.
- **The LP console cannot show a vault-level breakdown of on-chain funds.** The design
  calls for splitting the on-chain figure into settled sats and sats sitting in timelocked
  vaults, and for a per-leg timelock delta in blocks on the Exposure sheet. Neither is
  implemented, because the balance model has no such dimension: `lp_ledger` records signed
  sats per chain, and a lock is derived from in-flight leg amounts, not from any vault or
  expiry the engine knows about. Adding it is a real-adapter refinement — it needs the
  settlement layer to report vault membership and expiry heights per output, which is the
  same data the on-chain half of the adapter would surface (INTEGRATION.md §1). Until then
  the console shows the figures that exist rather than inventing the ones that do not.
- **LP solvency is self-reported mock state.** `lp_ledger` is credited by a dev route;
  no proof the LP actually controls funds on either chain. The real system needs
  deposits/collateral verified through the adapter.
- **No LP-side notifications.** LPs now have their own read API and a 5s-polling
  dashboard, but no push channel — a webhook per LP is still missing; exposure changes
  are only as fresh as the last poll.

## Real (tachi) mode

These apply only with `ADAPTER_MODE=tachi`. Everything above still applies too.

- **Bitcoin L1 legs are simulated — an SDK gap, not a protocol gap.** Tachi's
  `TxWithdraw` offboards any ledger VTXO straight to L1 with no vault involved, so
  the path a real `sendOnchain` needs does exist (INTEGRATION.md §2). What is
  missing is a builder: the shipped TS SDK provides neither an implementation nor
  documented payload semantics for `TxWithdraw` or `TxLockForVault`, and
  hand-rolling a withdrawal payload we have never seen accepted would risk a
  user's payout going nowhere. So `sendOnchain`, `pollOnchain` and
  `createOnchainDepositAddress` run against an embedded mock and log every call as
  simulated; a swap has one real half and one simulated half, and
  `capabilities.onchainReal` is the single flag that says so. An earlier version of
  this file called the exit impossible — that was wrong, and this entry replaces it.
- **Vault liveness cannot be read from the daemon.** `TxVaultClose` (0x12) is
  defined but not wired: the vault `State` field is hardcoded `"open"` because the
  closing/closed/breaching writer is unimplemented, and there is no client-side
  `TxVaultClose` to send. Any future OpenSluice vault work must track liveness from
  its own L1 exit-leaf observation rather than trusting the reported state.
- **CSV timelocks have no protocol floor.** The protocol accepts anything `> 0` and
  `<= 65535`, so a dangerously short timelock is accepted silently. The conventional
  value is 1008 blocks (~7 days), and the real lower bound should come from how long
  we might fail to notice a breach and still respond. OpenSluice ships no vault code
  today; if it gains any, 1008 is the starting point and the sibling spike's
  `csvBlocks=1` is test-only and must not be copied.
- **Funding only works below mainnet.** Every sat in this system enters through a
  self-signed ledger deposit with no L1 backing — that is how `npm run fund:tachi`
  fills the operator float, and every LP credit is a transfer out of that float.
  The Tachi team has confirmed this is intended below mainnet: the L1 verification
  gate is mainnet-only (INTEGRATION.md §5). So the funding path is legitimate on
  regtest and signet, and **does not exist on mainnet**. There, ledger value could
  only enter via an L1-backed deposit that each validator independently checks
  against its own `bitcoind` — amount and block height/timestamp matching exactly —
  and attests to, finalizing once attestations clear a threshold. Concretely, a
  mainnet OpenSluice would need: real Bitcoin behind the operator float, a deposit
  flow that waits on validator attestation rather than a single broadcast, and a
  decision about whether LPs are funded by the coordinator at all or deposit their
  own L1 sats directly — which is the same question as the custody gap below.
  Nothing in the adapter is written for that today.
- **Custody: the coordinator can spend an LP's balance.** Every LP account is a
  key derived from the coordinator's one mnemonic. An LP holds an entitlement in
  `lp_ledger` plus sats under a key it does not control. Removing that assumption
  needs LP-owned keys with a delegated or co-signed spend path — INTEGRATION.md
  §5, "Still open" question 2.
- **`lp_ledger` and real Tachi balances are two books, reconciled by nobody.**
  The ledger tracks what each LP is owed inside the coordinator; the coordinator's
  keys hold the pooled float that actually pays. They are expected to diverge (the
  e2e output shows it plainly), and nothing detects or repairs a divergence. A real
  deployment needs a reconciliation sweep that compares the two and halts quoting
  when they disagree beyond fees.
- **Paying a split swap is serialised by the ledger.** A wallet cannot spend its
  own change while that change is pending (`code=5 vtxo already pending in
  mempool`), so a user paying an N-leg swap must wait for each payment to commit
  before making the next. Nothing in the UI explains that wait yet.
- **The off-chain poller re-scans one block on every tick.** The watermark is
  `height - 1` so a block committing mid-tick cannot be skipped; the cost is that
  the last block is re-read each time. Correct, but not efficient at scale.
- **`watch()` is verified but unused.** It streams pending→committed correctly
  (smoke record §9) and would cut detection latency, but polling stays
  authoritative because a dropped WebSocket frame during a restart must not be
  able to lose a payment. Wiring it as a supplement is left open.
- **A real-mode deployment cannot demonstrate swap_in.** The direction's user-side leg is
  an L1 deposit, which is simulated, and the routes that fake an arrival are correctly
  disabled in production — so on `opensluice-live` a swap_in would hand the user a
  `mockbtc1q…` address nobody can pay. The live LPs therefore publish zero swap_in
  capacity and the book honestly reports none. This resolves itself the moment L1 legs
  become real; until then a real-mode operator has to make the same choice deliberately.
- **No fee strategy.** Off-chain transfers use `getFeeEstimate` clamped to a
  1-sat floor. There is no bumping, no batching of several legs into one
  transaction, and no accounting for the fee against the LP's margin.

## Operational

- **Late confirmations after a terminal swap are recorded, never credited** — the
  `leg_events` audit trail holds them, and stranded-deposit accounting only covers what
  was final at expiry. Money that confirms after expiry is visible but unbooked.
- **Quotes are never garbage-collected.** Expired quote rows accumulate.
- **Single operator, single node, SQLite.** Fine for this scope; the coordinator is
  fully trusted (it books both sides of every ledger entry with no external attestation).
