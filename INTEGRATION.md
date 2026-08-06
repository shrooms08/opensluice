# OpenSluice × Tachi — Integration Spec

**Audience:** the Tachi team, and whoever wires the real settlement adapter.

> **Status as of 2026-08-06.** OpenSluice runs today against an in-memory
> **mock** settlement layer. Everything above the settlement boundary — routing,
> the swap and leg state machines, the LP ledger, the marketplace, the dashboard,
> webhooks, SSE — is built and tested. The only thing between mock mode and real
> Bitcoin is one file: [`packages/adapter/src/tachi.ts`](packages/adapter/src/tachi.ts),
> which today throws `NotImplementedError` from every method and refuses to
> `init()`.
>
> Of the questions that file needs answered: **co-signing is ANSWERED** (Tachi
> replied on Telegram — the coordinator co-signs; there is no separate signing
> round for us to drive). **Receiver-side VTXO detection is OPEN** and is the
> single biggest blocker. **Hosted regtest/Signet RPC endpoints are PENDING**
> their Swagger docs.

> **Why we shipped in mock mode.** We could not verify the `@tachibtc/*` package
> surface or reach a hosted Tachi node with published endpoints, and the
> receiver-side detection path is still an open design question. Rather than fake
> it, OpenSluice labels mock mode everywhere (the LP dashboard footer bar,
> `/healthz`, the `tachi` adapter's own boot error, this document) and positions
> the `SettlementAdapter` interface as the integration contract.

**Naming note.** "Swap-in" is overloaded in this document. `swap_in` is a
*direction* (user pays on-chain Bitcoin, receives off-chain balance).
"Swap-in plan" in §4 means swapping the real adapter in behind the interface.
Where it matters, the direction is written in code font: `swap_in`, `swap_out`.

---

## 1. What OpenSluice needs from a settlement layer

Everything OpenSluice needs is the
[`SettlementAdapter`](packages/adapter/src/types.ts) interface — nine methods,
two of them optional or trivial. Nothing in the router, engine, poller, ledger,
webhook dispatcher, UI, or test suite knows which implementation is behind it;
swapping mock → real is a `case` in
[`packages/adapter/src/factory.ts`](packages/adapter/src/factory.ts).

OpenSluice is a two-sided instrument, so every method serves a *specific*
transition in one of two mirrored lifecycles:

- **`swap_in`** — the user pays **on-chain**, the LP fronts **off-chain**.
  Leg: `pending → seen → confirmed → settled`.
- **`swap_out`** — the user pays **off-chain**, the LP pays **on-chain**.
  Leg: `pending → committed → broadcasting → settled`.

The aggregate swap (`pending → funding → settling → completed`, with `expired`,
`partially_funded` and `failed` branches) is derived from the legs and never
driven by the adapter directly.

### Method by method

| Method | What it must do | Transition it drives |
| --- | --- | --- |
| `init()` | Connect to the on-chain node/indexer and the Tachi node; open or derive whatever vault and wallet the coordinator sends from. Called once in `createApp` before the server listens — a throw is a boot failure. | Boot. Today the `tachi` stub throws here deliberately. |
| `createOnchainDepositAddress(ref)` | Derive a fresh receive address per leg. Called during `acceptQuote` for every `swap_in` leg, with `ref = "<quoteId>:<lpId>"`. | **`swap_in` quote acceptance.** No address, no swap: the address is written to `swap_legs.deposit_address` and is what the progress page renders as a QR. |
| `createOffchainAddress(ref)` | The same, on the off-chain leg. Called during `acceptQuote` for every `swap_out` leg. | **`swap_out` quote acceptance.** |
| `watchAddress(chain, address)` | Register an address whose events the poller must see. Called for every deposit address at acceptance, and again for the user's destination just before `sendOnchain` on a `swap_out` leg — the payout's own confirmations have to come back through the poller. | Precondition for every transition below. An address that is not watched produces no events and the leg sits `pending` until the funding window expires. |
| `pollOnchain(cursor)` | Return every on-chain event after `cursor`, plus the next cursor. Each event is `seen` (in the mempool / 0-conf) or `confirmed`, with a confirmation count. | **`swap_in`: `pending → seen`** once cumulative deposits to the leg address reach the leg amount; **`seen → confirmed`** once cumulative *confirmed* value reaches it, which queues the off-chain payout. **`swap_out`: `broadcasting → settled`** — the event matched by `payout_tx_id` is what closes the leg and writes the ledger rows. |
| `pollOffchain(cursor)` | Return every off-chain event after `cursor`, plus the next cursor. Off-chain is instant, so there is one status: `committed`. | **`swap_out`: `pending → committed`**, which queues the on-chain payout. This is the method with no documented path today (§3, Q2). |
| `sendOffchain({ toAddress, amountSats, ref })` | Pay the user off-chain and return a `transferId`. Called after a `swap_in` leg reaches `confirmed`, with `ref = leg.id`. | **`swap_in`: `confirmed → settled`** on success (the `transferId` is stored as the leg's settlement reference and the LP's two ledger rows are written); **`confirmed → failed`** on throw, which fails the swap and books the user's deposit as a `stranded_deposit`. |
| `sendOnchain({ toAddress, amountSats, ref })` | Pay the user on-chain and return a `txId`. Called after a `swap_out` leg reaches `committed`. | **`swap_out`: `committed → broadcasting`** on success; **`committed → failed`** on throw. Note the leg does *not* settle here — settlement waits for that `txId` to come back `confirmed` through `pollOnchain`. |
| `close?()` | Release timers and sockets. Called on `SIGINT`/`SIGTERM`. | Shutdown only. |

### Contract requirements the signatures do not express

These are the parts a real implementation gets wrong quietly, so they are stated
explicitly. All four are satisfied by the mock and exercised by the engine tests.

1. **Cursors must be durable and complete.** The poller reads both cursors,
   calls both `poll*` methods, then commits *both event batches and both new
   cursors in one SQLite transaction*. A crash before the commit replays the same
   batch; a crash after it must never re-serve those events. An adapter that
   skips an event between cursor positions loses a payment permanently — there is
   no reconciliation sweep.
2. **`eventId` must be unique per emission, not per transaction.** The `seen` and
   the `confirmed` event of one deposit are two different events with two
   different ids. Application is idempotent on `eventId`, so a stable id is what
   makes replay safe — and a *reused* id is what makes the confirmation silently
   disappear.
3. **Amounts are `bigint` sats.** No floats, no BTC-denominated strings anywhere
   across the boundary.
4. **A throw from `send*` is read as "the money definitely did not move."** The
   engine responds by failing the leg and the swap and booking a stranded
   deposit for manual resolution. An ambiguous timeout must therefore be resolved
   *inside* the adapter — retry, or look the transfer up by its `ref` — because
   throwing on a send that actually succeeded pays the user twice on the books.

The adapter never has to know about swaps, quotes, LPs, fees, webhooks, or
SQLite. It reports what it observes and does what it is told.

---

## 2. What Tachi's docs and replies provide today

Honest mapping, per method. **Ours** = not a Tachi dependency at all, ordinary
Bitcoin engineering on our side. **Answered** = the mechanism is settled, only
endpoints are missing. **Pending** = understood but waiting on published
endpoints. **Blocked** = no documented path.

Where an SDK call or endpoint name is unknown, it is written as unknown. We have
not verified the `@tachibtc/*` package surface, so no method names from it are
asserted anywhere in this document or in `tachi.ts`.

| Adapter method | Coverage | Notes |
| --- | --- | --- |
| `createOnchainDepositAddress` | **Ours** | A watch-only descriptor wallet on a Bitcoin node we run. No Tachi involvement. |
| `pollOnchain` | **Ours** | Standard address-watching against our own node or indexer, with a block-height/txid cursor. No Tachi involvement. |
| `sendOnchain` | **Ours** | A hot wallet we control — subject to the funding question in §3, Q4. No Tachi involvement. |
| `init` | **Pending** | Tachi runs hosted regtest/Signet RPC; there is no local validator set to stand up, and a local regtest `bitcoind` will not reach their network. Connection and vault-open endpoints arrive with their Swagger docs. |
| `createOffchainAddress` | **Pending** | Vault address derivation happens against Tachi's hosted node. The mechanism is not in question; the endpoint name and its parameters are unpublished. |
| `sendOffchain` | **Answered, pending endpoint** | Their Telegram reply settles the co-signing question: the coordinator co-signs, so there is no quorum round for us to run. Our side is build → sign our part → broadcast. Waiting only on the broadcast endpoint. |
| `watchAddress` (`"offchain"`) | **Blocked** | Only implementable once there is *something* to subscribe to or query — see below. |
| `pollOffchain` | **Blocked** | No documented way for a receiver to learn that an off-chain payment landed on an address it controls. The docs we have describe sending. |
| `close` | **Ours** | Trivial. |

**Summary.** The on-chain half of OpenSluice is not blocked on Tachi at all — it
is a Bitcoin node, a watch-only wallet, and a hot wallet. Of the off-chain half,
the *sending* side is specification-complete and waiting on endpoints; the
*receiving* side has no documented path. Because `swap_in` only needs the
off-chain **send** and `swap_out` needs the off-chain **receive**, that split
falls exactly along a direction boundary: `swap_in` can go live before `swap_out`
can. §4 leans on that.

---

## 3. Open questions, and what each unblocks

### Q1 — Co-signing mechanics — ✅ ANSWERED

- **Answer (Tachi, via Telegram):** the coordinator co-signs. There is no
  separate signing endpoint and no quorum round for us to orchestrate; we build
  our part, sign it, and broadcast.
- **Unblocks:** `sendOffchain`, and therefore the `swap_in` leg transition
  `confirmed → settled` — the moment the user actually receives their off-chain
  balance and the LP's fee is booked.
- **Remaining:** the published broadcast endpoint. This is wiring, not design.

### Q2 — Receiver-side VTXO detection — ⏳ OPEN (the blocker)

- **Question:** given an off-chain address we control, how do we learn that a
  payment was credited to it?
- **Where it blocks:** `pollOffchain`, and consequently `watchAddress("offchain",
  …)`.
- **What it gates:** the `swap_out` leg transition `pending → committed`. That
  transition is what queues the on-chain payout, so without it `committed →
  broadcasting` and `broadcasting → settled` never happen either. In plain terms:
  **the entire `swap_out` direction cannot run.** A user could accept a
  `swap_out` quote and pay the address, and the gateway would expire the swap
  fifteen minutes later having never seen the money.
- **Answer shapes that would work, best first:**
  1. **A push feed** — subscribe by address, receive credits as they commit. Best
     fit: it also removes polling latency from the user-visible progress page.
  2. **A pollable query by address with a cursor** — maps one-to-one onto the
     existing cursor poller, which is the shape `pollOffchain` already has.
  3. **Enumerate committed VTXOs and filter by output address** — heavier, but we
     can reconstruct credits ourselves from it.
- Any one of the three is enough. The interface does not care which.

### Q3 — Hosted RPC endpoints and vault access — 🟡 PENDING SWAGGER

- **What we know:** Tachi provides hosted regtest/Signet RPC; there is no local
  validator set to obtain, and a local regtest `bitcoind` per the public tutorial
  will not talk to their network. Concrete endpoints arrive with their Swagger
  docs.
- **Where it blocks:** `init` and `createOffchainAddress`.
- **What it gates:** boot (the adapter cannot connect), and `swap_out` quote
  acceptance (no off-chain deposit address to hand the user). It does not gate
  `swap_in` acceptance, which only needs an on-chain address.
- **Implication for testing:** our "run it against regtest" plan means *Tachi's
  hosted regtest*, not a local chain.

### Q4 — LP-side vault funding and solvency — ⏳ OPEN, and it is ours

This one is not Tachi's to answer; it is OpenSluice's own gap, and it is the
question OpenTill never had to ask because OpenTill has one merchant, not a
marketplace of counterparties.

- **Today:** an LP's balance on both chains is self-reported mock ledger state,
  credited by an operator-only dev route (`POST /api/lp/fund`). Availability is
  computed as `min(declared capacity, funded ledger balance) − in-flight locks`,
  which is arithmetically sound and completely unbacked. There is no proof that
  an LP controls a single sat on either chain. See
  [GAPS.md](GAPS.md) — "LP solvency is self-reported mock state".
- **Where it blocks:** nothing, structurally — which is the problem. The engine
  will happily route a leg to an LP that cannot pay, and only discover it when
  `sendOffchain`/`sendOnchain` throws, at which point the user's deposit is
  already stranded.
- **What it needs:** a funding path where the LP deposits into a vault the
  coordinator can spend from (or co-spend from), verified through the adapter
  rather than asserted through a dev route — plus the mirror question of who
  holds the keys the `send*` methods sign with. Whether that is one coordinator
  vault per LP, a shared vault with per-LP accounting, or per-LP collateral with
  the LP signing its own payouts, is a design decision we have deliberately not
  made yet, because it depends on what Q2 and Q3 turn out to permit.

---

## 4. Swap-in plan: what happens when the real adapter lands

### What does not change

Nothing above the settlement boundary. Concretely, none of this is touched:

- the routing engine and the split allocator,
- the swap and per-direction leg state machines and their transition maps,
- the poller (its cursor/transaction discipline is already the contract a real
  adapter has to meet),
- the double-entry LP ledger and availability derivation,
- webhooks, SSE, the public swap serializer,
- every user surface and the LP dashboard,
- the entire test suite. The engine and e2e tests drive lifecycles through the
  `SettlementAdapter` interface, not through the mock's internals; the mock's
  deterministic `advanceBlocks()` maps onto regtest block generation.

If wiring the real adapter requires a change outside `packages/adapter`, that is
a signal the boundary was drawn wrong, and it is worth stopping to look at.

### The order of work

1. **Install and verify the SDK.** Replace the local type mirrors in `tachi.ts`
   with real imports once the packages and access are confirmed. Until then no
   method names from `@tachibtc/*` appear in our source, on purpose.
2. **Build the on-chain half first — it is unblocked today.** A watch-only
   wallet for `createOnchainDepositAddress`, a cursor-based poller against our
   own node for `pollOnchain`, a hot wallet for `sendOnchain`. This half needs
   nothing from Tachi and can be built and tested against local regtest while the
   other questions are open.
3. **Wire `init` + `createOffchainAddress`** against Tachi's hosted node once
   Q3's endpoints are published.
4. **Wire `sendOffchain`** (Q1 answered): build, sign our part, broadcast; the
   coordinator co-signs. At this point **`swap_in` works end to end** —
   on-chain receive is ours, off-chain send is specified. Ship the direction.
5. **Wire `pollOffchain`** when Q2 is answered, in whichever of the three shapes
   Tachi provides. `watchAddress("offchain", …)` follows from the same answer.
   **`swap_out` goes live here**, and not before.
6. **Answer Q4 before either direction touches real money at scale.** Steps 2–5
   make the plumbing real; Q4 is what makes an LP's advertised capacity mean
   something.
7. **Run the existing suite against Tachi's hosted regtest.** No test changes
   expected; if any are needed they are adapter-level fixtures.

### Honest effort estimate

Assume the endpoints are published and Q2 has an answer:

- On-chain half (step 2): **2–3 days.** Not hard, but it is real Bitcoin wallet
  code — descriptor management, reorg handling, fee estimation, change — and it
  is the part most likely to be underestimated because it sounds routine.
- Off-chain send + vault bootstrap (steps 3–4): **~1 day**, mostly endpoint
  plumbing, given Q1 is settled.
- Off-chain receive (step 5): **1–2 days** if the answer is a push feed or a
  cursor query; longer, and with a harder correctness story, if we have to
  reconstruct credits by scanning.
- Validation against hosted regtest: **~1 day.**

So roughly **a week of focused work for both directions**, of which `swap_in`
alone is the first three-ish days — *provided the answers exist*. That estimate
is worth nothing while Q2 is open: an unanswered design question has no duration.
Q4 is deliberately not in the estimate; it is a design decision with a product
shape, not a wiring task.

---

## Relationship to OpenTill

OpenSluice shares [OpenTill's](../opentill) adapter philosophy exactly — one
interface, a mock that is the shipping mode, a documented stub that refuses to
boot rather than pretending, and an integration spec that says plainly what is
unknown. Several patterns are inherited outright: the cursor poller committing
events and cursor in one transaction, transition-map state machines, sats as
`bigint` across boundaries, HMAC webhooks enqueued in the same transaction as the
state change.

OpenTill's three open questions apply here unchanged — co-signing (answered the
same way, by the same reply), receiver-side detection (open in both, and blocking
strictly more here), and hosted node access (pending in both). OpenSluice adds a
fourth of its own: **LP-side vault funding**. OpenTill has one merchant receiving
its own money. OpenSluice has a marketplace of counterparties fronting other
people's money, and until an LP's solvency is provable rather than self-reported,
the routing engine is allocating capacity it cannot verify exists.
