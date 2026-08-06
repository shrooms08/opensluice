# OpenSluice

OpenSluice is a liquidity-management layer for the Tachi network — Bitcoin's off-chain
vault/VTXO layer. Users move value between on-chain Bitcoin and off-chain Tachi balance
instantly, because liquidity providers (LPs) front the funds and absorb the
timelock/vault commitments. A public marketplace plus a deterministic routing engine
picks the best LP quotes, splitting across up to three LPs when no single one covers
the amount.

**Gate 3 status:** engine + user swap surfaces + the LP dashboard (`/lp`) and public
marketplace (`/market`). Mock settlement adapter, no Docker, no live Tachi integration.
Everything below runs against the mock.

## Quickstart

```sh
npm install
npm test                # 149 tests: router, state machines, adapter, auth, LP isolation, e2e, SSE, UI
npm run typecheck
npm run build           # builds apps/web into apps/web/dist (gateway serves it)

cp .env.example .env    # set OPENSLUICE_OPERATOR_KEY + OPENSLUICE_WEBHOOK_SECRET
                        # set OPENSLUICE_DEV_PUBLIC_SIMULATE=true for demo buttons
npm run dev             # gateway on :8080 — serves the app at / and /swap/:id
npm run seed:demo       # 3 demo LPs with distinct fees/capacities (reusable every gate)
```

Frontend dev loop: `npm run dev:web` starts Vite with HMR on :5173, proxying
`/api`, `/dev` and `/swap` data requests to the gateway (`OPENSLUICE_GATEWAY_URL`
to point elsewhere). Production is build-then-serve: the gateway serves
`apps/web/dist` itself via @fastify/static — one process.

## The user flow (Gate 2 screens)

**Swap widget — `/`.** Two plain-language direction cards ("On-chain → Instant
balance" / "Balance → On-chain"), an oversized sat amount input with thin-space
grouping, live BTC line and MAX (= the book's current `maxRoutableSats` from
`GET /api/limits`). ~400ms after typing stops, the live quote panel shows: the
receive hero, total fee in sats *and* effective percent ("1 330 sats · 0.44%"),
an honest time estimate, and the route — one quiet row for a single provider, or
stacked per-LP rows under "Routed across N providers for the best rate" when the
router split. A 60s countdown bar auto-refreshes the rate on expiry. Below min /
above routable amounts get inline errors naming the real numbers ("up to
140 000 sats available right now"). "Get this rate" accepts the quote (409s
requote automatically with a "Rates updated" note) and lands on the progress
page. A compact liquidity-book strip closes the page.

**Swap progress — `/swap/:id`.** SSE-driven (snapshot on connect, event on every
swap/leg change, 15s heartbeats, 5s polling fallback). While awaiting payment:
one instruction card per leg — amount, QR, address well with COPY, a status chip
that walks `waiting → seen → confirming (2/3) → settled` in plain words, and a
dashed DEV simulate button when `OPENSLUICE_DEV_PUBLIC_SIMULATE=true`. The
funding countdown (15 min) shifts amber near the end. Terminal states: the big
green **Swapped** money shot with per-leg settlement refs and the fee line;
calm, honest expired / partly-received / failed cards. The swap id is the only
capability needed — the public serializer never exposes LP identity, quote ids,
webhook URLs, or raw engine errors (allowlist-tested).

Words like "timelock", "vault", and "VTXO" never appear on user surfaces —
render tests enforce it. The LP dashboard deliberately inverts this: LPs are
professionals pricing timelock exposure, so there the precise words are
required, and a render test asserts the vault language IS present.

## The LP guide (Gate 3)

### Registering — operator curl, on purpose

There is no LP self-registration UI: an operator vouches for every provider.
Registration returns the LP's API key **exactly once**; it is hashed at rest
and can never be shown again.

```sh
curl -s -X POST :8080/api/lps \
  -H "Authorization: Bearer $OPENSLUICE_OPERATOR_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Fjord Liquidity"}'
# -> { "id": "lp_…", "apiKey": "slk_…", … }   <- hand the slk_ key to the LP, once
```

(`npm run seed:demo` prints three such keys — use any of them to explore `/lp`.)

### Key handling

The dashboard at **`/lp`** asks for the `slk_` key behind a password-style
gate (OpenTill's pattern): the key lives in sessionStorage only — cleared when
the tab closes, never in a URL or cookie — and rides as a Bearer header to the
LP's own gateway. Any 401 clears it and returns to the prompt; the Lock button
does the same. Every LP endpoint answers only the calling key's data:
cross-LP isolation is enforced server-side and covered by tests.

### Managing liquidity

The **Liquidity** view edits both directions' offers inline — capacity, fee
bps, fixed fee, min/max per swap, est. seconds — and PUTs on save (optimistic,
with revert + the zod error on rejection). The "your position in the book"
line ranks your draft against the live `/api/marketplace` book with the same
ordering the router drains: fee bps, then fixed fee, then est. time. Fees and
capacity take effect on the next quote; already-accepted swaps keep their
locked terms.

### Reading exposure

**Overview** shows your two ledger balances (on-chain / off-chain vault) with
locked amounts as secondary lines, lifetime fees (the hero turns orange once
you've earned anything), and utilization (locked / declared capacity) per
direction. **Exposure** lists every in-flight leg holding your capital: swap
ref (truncated — the full id is the user's capability, LPs never see it),
direction, locked amount, leg status with live confirmation counts on
on-chain legs, and age. A leg leaves exposure only by settling (→ History,
fee booked in Earnings) or dying (→ History as failed/expired). **History**
is the white-sheet record of closed legs, filterable, paginated, fee per row.
All LP views poll every 5s and pause while the tab is hidden. A persistent
footer bar marks mock-settlement mode honestly on every view.

## The marketplace (`/market`, public)

The full liquidity book as a page: direction tabs, one row per provider with
live availability, rate (bps + fixed), min–max per swap and honest time
estimate, a totals header (total available, provider count, best rate), and
the best-rate row emphasized — `bestRate` is computed server-side with the
router's own preference order, so the highlighted provider is the one quotes
actually drain first. Refreshes every 5s; the swap widget's liquidity strip
links here. Public and jargon-free, like every user surface.

Auth model:

| Caller   | Auth                                   | Surface |
|----------|----------------------------------------|---------|
| Operator | `Bearer $OPENSLUICE_OPERATOR_KEY`      | register/pause LPs, list swaps, dev routes |
| LP       | per-LP key (shown once at registration, hashed at rest) | `PUT /api/lp/liquidity` |
| Public   | none — a swap id is its own capability | marketplace, quotes, create/read swap |

## Curl walkthrough (run live against this build)

The transcript below was executed against `npm run dev` with the mock adapter
(`op_dev_key` as the operator key, port 8484). It registers two LPs, funds them, quotes
a **split** 100k-sat swap-in, accepts it, simulates both on-chain legs, and ends with a
completed swap and fees sitting in the LP ledgers.

```sh
OP='Authorization: Bearer op_dev_key'; CT='Content-Type: application/json'

# 1) Register two LPs (operator). The plaintext key appears once, here only.
curl -s -X POST :8484/api/lps -H "$OP" -H "$CT" -d '{"name":"Alpha Liquidity"}'
# -> {"id":"lp_dce1…","apiKey":"slk_c854…", …}
curl -s -X POST :8484/api/lps -H "$OP" -H "$CT" -d '{"name":"Beta Bridge"}'
# -> {"id":"lp_961b…","apiKey":"slk_dc19…", …}

# 2) Fund their mock off-chain ledgers (dev-only route; swap_in is fronted off-chain).
curl -s -X POST :8484/api/lp/fund -H "$OP" -H "$CT" \
  -d '{"lpId":"lp_dce1…","chain":"offchain","amountSats":"60000"}'
curl -s -X POST :8484/api/lp/fund -H "$OP" -H "$CT" \
  -d '{"lpId":"lp_961b…","chain":"offchain","amountSats":"80000"}'

# 3) Each LP publishes its offer with ITS OWN key.
curl -s -X PUT :8484/api/lp/liquidity -H 'Authorization: Bearer slk_c854…' -H "$CT" \
  -d '{"swapIn":{"capacitySats":"60000","feeBps":10,"feeFixedSats":"0","minSats":"1000","maxSats":"60000","estSeconds":60}}'
curl -s -X PUT :8484/api/lp/liquidity -H 'Authorization: Bearer slk_dc19…' -H "$CT" \
  -d '{"swapIn":{"capacitySats":"80000","feeBps":25,"feeFixedSats":"10","minSats":"1000","maxSats":"80000","estSeconds":90}}'

# 4) The public book now shows both offers with live availability.
curl -s :8484/api/marketplace
# -> swapIn: [ Beta Bridge 80000 available @25bps+10, Alpha Liquidity 60000 @10bps ]

# 5) Quote 100k sats in. NO single LP covers it -> the router splits, cheapest first:
curl -s -X POST :8484/api/quotes -H "$CT" -d '{"direction":"swap_in","amountSats":"100000"}'
# -> legs: [ Alpha 60000 (fee 60), Beta 40000 (fee 110) ]
#    totalFeeSats 170, totalReceiveSats 99830, estSeconds 90, expires in 60s

# 6) Accept the quote. Capacity LOCKS now (quotes lock nothing) and each leg
#    returns its own on-chain deposit address.
curl -s -X POST :8484/api/swaps -H "$CT" \
  -d '{"quoteId":"q_04b1…","destination":"mocktachi1pwalkthroughuser"}'
# -> status pending, legs pay-to: mockbtc1qm75…(60000), mockbtc1qdru…(40000)
curl -s :8484/api/marketplace     # during flight: Alpha 0 available, Beta 40000

# 7) The user pays both legs (simulated), three mock blocks confirm them, the
#    engine pays out off-chain instantly per leg.
curl -s -X POST :8484/dev/simulate-onchain-deposit -H "$OP" -H "$CT" \
  -d '{"address":"mockbtc1qm75…","amountSats":"60000"}'
curl -s -X POST :8484/dev/simulate-onchain-deposit -H "$OP" -H "$CT" \
  -d '{"address":"mockbtc1qdru…","amountSats":"40000"}'
curl -s :8484/api/swaps/sw_94a5…   # -> settling, legs [seen, seen]
curl -s -X POST :8484/dev/advance-blocks -H "$OP" -H "$CT" -d '{"blocks":3}'
curl -s :8484/api/swaps/sw_94a5…   # -> completed, both legs settled with payoutTransferIds

# 8) Locks released into REDUCED capacity, fees on the LPs' books:
curl -s :8484/api/marketplace      # Alpha 60 left, Beta 40110 left
# lp_ledger rows for the swap (per LP: +deposit on-chain, -payout off-chain):
#   Alpha: +60000 onchain, -59940 offchain  -> earned 60 sats
#   Beta:  +40000 onchain, -39890 offchain  -> earned 110 sats  (Σ = 170 = quoted fee)
```

Swap-outs run the mirror image: the user pays the leg's **off-chain** address (commits
in ~1s), the LP pays on-chain, and the leg settles after 3 mock confirmations.

## API surface

- `GET /` and `GET /swap/:id` (public) — the swap app (built bundle served by the gateway)
- `GET /lp` (public shell, key-gated in-page) and `GET /market` (public) — LP dashboard + marketplace pages
- `GET /api/lp/me`, `/api/lp/balances`, `/api/lp/exposure`, `/api/lp/earnings`, `/api/lp/history` (LP key) — the calling LP's own profile, ledger balances + locks, in-flight legs, settled fees (paginated), and closed legs (filterable); strict cross-LP isolation
- `GET /swap/api/:id` + `GET /swap/api/:id/events` (public, SSE) — live public swap view
- `GET /api/limits` (public) — `{ swapIn|swapOut: { minSats, maxRoutableSats } }` derived live from the book
- `POST /dev/swaps/:id/pay-leg/:index` (public, triple-guarded demo route: env flag + mock adapter + non-production)
- `POST /api/lps` (operator) — register LP, returns the API key once
- `GET /api/lps`, `PATCH /api/lps/:id` (operator) — list, pause/reactivate
- `PUT /api/lp/liquidity` (LP key) — set capacity/fees/min/max/est per direction
- `POST /api/lp/fund` (operator, dev/mock only) — credit an LP's mock ledger
- `GET /api/marketplace` (public) — the live book, capacity net of in-flight locks, per-direction `bestRate` marker computed server-side
- `POST /api/quotes` (public) — route an amount; 409 + `maxRoutableSats` when the book can't cover it
- `POST /api/swaps` (public) — accept a quote: re-validate, lock, return per-leg payment instructions; optional `webhookUrl` (HMAC-signed `X-OpenSluice-Signature`, retried with backoff)
- `GET /api/swaps/:id` (public, id = capability), `GET /api/swaps` (operator)
- `POST /dev/simulate-onchain-deposit`, `POST /dev/simulate-offchain-payment`, `POST /dev/advance-blocks` (operator, dev/mock only)

## Design notes

- Monorepo of npm workspaces: `packages/shared` (types/schemas/sat math),
  `packages/adapter` (SettlementAdapter: mock + documented `tachi` stub that refuses to
  boot), `packages/gateway` (SQLite + Fastify engine). Patterns are deliberately
  inherited from [OpenTill](../opentill): hand-written SQL migrations run on boot, sats
  as TEXT/bigint at the boundaries, unix-ms timestamps, cursor poller committing events
  + cursor in one transaction, transition-map state machines, HMAC webhooks enqueued in
  the same transaction as the state change.
- Swap aggregate: `pending → funding → settling → completed`, with `expired`,
  `partially_funded`, and `failed` branches. A swap completes only when **all** legs
  settle. Legs have per-direction machines (`seen → confirmed → settled` on-chain in,
  `committed → broadcasting → settled` out).
- Availability = `min(declared capacity, funded ledger balance) − in-flight locks`,
  derived (never stored) so it cannot drift. LP ledgers are double-entry style; a
  completed swap's rows sum to exactly the fees earned — asserted in tests.
- `apps/web` is Vite + React + TS, plain CSS on the OpenTill v2 token sheet
  (`design-reference/tokens.css`, wired in as the app's `tokens.css`): true black
  canvas, white sheets, the accent orange, Space Grotesk 700 display + JetBrains
  Mono data, self-hosted woff2 fonts. One bundle serves all four screens
  (widget, progress, LP dashboard, marketplace): ~69 KB gz JS + ~6 KB gz CSS,
  still under the 80 KB budget.

See [GAPS.md](GAPS.md) for what the gates so far deliberately do not solve.
