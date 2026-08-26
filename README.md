<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
  <img src="docs/brand/lockup-light.svg" alt="OpenSluice" width="260">
</picture>

**A liquidity marketplace that makes Bitcoin's off-chain layer feel instant.**

OpenSluice moves value between on-chain Bitcoin and off-chain [Tachi](https://tachi.sh)
balance in both directions, in seconds, by letting independent liquidity providers front
the funds and absorb the timelock and vault commitments the user never sees. A public
marketplace and a deterministic routing engine pick the cheapest execution, splitting a
swap across up to three providers when no single one can cover it. Users get plain
language and real numbers; providers get a console that speaks in timelocks, exposure and
basis points.

**Status:** feature-complete, and **settling real off-chain value on Tachi**. With
`ADAPTER_MODE=tachi` every leg that moves value inside Tachi is a real signed, committed
ledger transaction on `tachi-regtest-1`; Bitcoin L1 legs are simulated and labelled as
such, because the shipped Tachi TypeScript SDK provides no builder for the ledger→L1 exit
— the protocol has one (`TxWithdraw`, no vault required), the tooling does not. The mock
adapter remains the default and the test/demo/CI mode. Evidence:
[`docs/tachi-smoke-output.md`](docs/tachi-smoke-output.md) (verbatim daemon responses)
and [`docs/tachi-e2e-output.md`](docs/tachi-e2e-output.md) (three real swaps, with
transaction ids). The boundary is quoted and explained in
[INTEGRATION.md](INTEGRATION.md).

## Try it

- **Mock demo (always works):** <https://opensluice-demo.fly.dev>
- **Real off-chain settlement on `tachi-regtest-1`:** <https://opensluice-live.fly.dev> — real
  VTXO transactions against a small regtest float, so it may run dry.

**Verified real settlement on `opensluice-live`** (every id below is a committed Tachi
ledger transaction, verifiable on the daemon):

| What | Transaction |
|---|---|
| swap_out — the user's own payment leg | `2cad6f67f7501448c21dc465776f874bd81a31a11a22b2797751792d9b3303ea` |
| split swap_out — Penstock leg (5 000 sats) | `83855bd83a149485999e4d77dfe6612ec4e28d65398f953ca35b80fb0d7994a8` |
| split swap_out — Headwater leg (2 000 sats) | `165943387aef696bd48d5d1210595b1740f792059075877d9ad8762093e541c2` |
| LP funding — operator float → Penstock | `ab36a00da9fed2e6da2e08c37208f383e97bd85f6fa0291091a6c8b912b8dff4` |
| LP funding — operator float → Headwater | `7157a48fbce54ac568d3522cd6812ad641e5f8a462abc8955b8765492394ebcd` |
| LP funding — operator float → Weir Labs | `56a5062e8fb138353e1f9b6e0c9f5704ecdc4e3f981e69286723d8c39d7484f9` |
| operator float top-up (faucet + ledger deposit) | `b21bec8339436c0bb545da87214d275c948b233c092ee61e05e5865baa727a5f` |

The other real leg — an **LP paying a user off-chain** (the swap_in direction) — is proven
by `npm run e2e:tachi`, e.g. `cc500206d08bef77d91f3e8123154ee8f74c417ab35ab3881b65f73e2453dc3b`,
where the user's real Tachi balance moved 7 596 → 8 795 sats against a quoted receive of
1 199. Full transcript: [`docs/tachi-e2e-output.md`](docs/tachi-e2e-output.md).

**Bitcoin L1 legs are simulated, and the live instance says so.** This is an SDK gap, not
a protocol gap: Tachi's `TxWithdraw` offboards any ledger VTXO straight to L1 with no vault
involved, but the shipped TypeScript SDK ships no builder and no documented payload
semantics for it, and we will not hand-roll a withdrawal we have never seen accepted — the
failure mode is a user's payout silently going nowhere. We have asked for a payload
reference or the Go-side builder to mirror; details in
[INTEGRATION.md §2](INTEGRATION.md#2-the-l1-boundary--an-sdk-gap-not-a-protocol-gap). The
adapter reports `onchainReal: false` on `/healthz` and the provider console carries a
persistent `PARTIAL` bar reading *"Off-chain settlement live on tachi-regtest-1 · L1 legs
simulated"*.

**`opensluice-live` therefore advertises swap_out only.** A swap_in's user-side leg is an
L1 deposit, which on this instance is simulated — the address handed out is a
`mockbtc1q…` placeholder nobody can pay, and the routes that would fake its arrival are
switched off in production, as they must be. Rather than leave that dead end in front of
users, the live LPs publish zero swap_in capacity, so the widget honestly reports no
liquidity in that direction. Both directions work fully on the mock demo and under
`npm run e2e:tachi`.

**Custody caveat.** In real mode every LP account is a key derived from the coordinator's
single mnemonic, so the coordinator can spend an LP's balance. That is acceptable for a
regtest demonstration and not for real money; delegated LP-owned keys are an open question
with the Tachi team (INTEGRATION.md §5, "Still open" question 2).

## Settlement modes

| | `ADAPTER_MODE=mock` (default) | `ADAPTER_MODE=tachi` |
|---|---|---|
| Off-chain legs (Tachi ledger) | simulated | **real** — derived taproot addresses, `getAddressVtxos` detection, signed TRANSFERs verified to `code === 0` **and** block commit |
| On-chain legs (Bitcoin L1) | simulated | simulated, and logged as such on every call |
| swap_out | fully simulated | user's payment leg **real**; LP's L1 payout simulated |
| swap_in | fully simulated | user's L1 deposit simulated; LP's payout to the user **real** |
| LP funding | ledger bookkeeping | **real** transfer, operator float → LP account; the ledger row is written only if it commits |
| Demo pay-leg buttons | available | refused — the gateway will not boot with `OPENSLUICE_DEV_PUBLIC_SIMULATE=true` outside mock mode |
| Used by | `npm test`, the demo, CI | `npm run e2e:tachi` |

What is running is never inferred from the mode string: the adapter reports
`settlement: { onchainReal, offchainReal, label, chainId }` on `GET /healthz`, and the
UI's settlement bar, this table and INTEGRATION.md all describe that one object.

```sh
# real off-chain settlement on regtest
npm run smoke:tachi     # generates + funds a wallet, records every daemon response
npm run e2e:tachi       # three real swaps through a real gateway

ADAPTER_MODE=tachi \
OPENSLUICE_TACHI_MNEMONIC="$(jq -r .mnemonic .tachi-smoke-state.json)" \
OPENSLUICE_OPERATOR_KEY=... OPENSLUICE_WEBHOOK_SECRET=... npm run dev
```

## What the bounty asked for, and where it lives

| Requirement | Where | Notes |
|---|---|---|
| On-chain → off-chain flow | `/` → `/swap/:id` | User pays a Bitcoin address; the LP fronts off-chain sats. Leg walks `pending → seen → confirmed → settled`; e2e-tested both directions. |
| Off-chain → on-chain flow | same surfaces, `swap_out` | Mirror image: user pays off-chain, LP broadcasts on-chain. Leg walks `pending → committed → broadcasting → settled`. |
| Clear fee / timing / liquidity display | quote panel + `/market` | Fee always shown **both ways** ("1 330 sats · 0.44%"), arrival stated as "seconds after 3 confirmations" from one shared constant, and live availability with per-provider min–max and est. time. Below-min and ceiling states name the real numbers in amber, never red. |
| Timelock-abstraction UX | the vocabulary split | User surfaces are **jargon-banned** — "timelock", "vault" and "VTXO" cannot appear, and render tests fail the build if they do. The LP console **requires** the same words, because professionals pricing exposure are owed precision. Same swap, two honest vocabularies: to a user it is `CONFIRMING (2/3)`; to its provider it is locked capital with a settlement state. |
| LP marketplace with routing logic | `/market`, `/lp`, `domain/router.ts` | Public book with a server-computed best-rate marker; deterministic split allocator (cheapest effective rate first, one-step rebalance, ≤3 legs) with its own unit-test suite; per-LP console with strict cross-LP isolation, asserted on every endpoint. |

## Quickstart

```sh
npm install
npm test                # 200 tests: router, state machines, adapter, auth, LP isolation, e2e, SSE, UI
npm run typecheck
npm run build           # builds apps/web into apps/web/dist (gateway serves it)

cp .env.example .env    # set OPENSLUICE_OPERATOR_KEY + OPENSLUICE_WEBHOOK_SECRET
                        # set OPENSLUICE_DEV_PUBLIC_SIMULATE=true for the demo pay buttons
npm run dev             # gateway on :8080 — serves /, /swap/:id, /lp and /market
npm run seed:demo       # 3 demo LPs (Penstock, Headwater, Weir Labs) with distinct profiles
```

Frontend dev loop: `npm run dev:web` starts Vite with HMR on :5173, proxying
`/api`, `/dev` and `/swap` data requests to the gateway (`OPENSLUICE_GATEWAY_URL`
to point elsewhere). Production is build-then-serve: the gateway serves
`apps/web/dist` itself via @fastify/static — one process.

## The four surfaces

**Swap widget — `/`.** Two direction cards using nav-pill logic (the selected one
fills orange), an oversized sat input with thin-space grouping, a live BTC line and
MAX (= the book's current `maxRoutableSats`). ~400 ms after typing stops the quote
panel shows the **receive** hero — what lands, not what leaves — the fee both ways
("1 330 sats · 0.44%"), the arrival promise ("seconds after 3 confirmations"), and the
route. A split is sold as the feature: an accent "Routed across 3 providers" caption, a
proportional bar in dimmed steps of the one privileged hue, and a quiet row per leg. A
3 px countdown bar labelled "Rate held for you" auto-refreshes on expiry, and the fresh
quote states the delta honestly before asking for the click ("You'd now receive 40 sats
less"). Limits are amber, never red — nothing failed — and the liquidity ceiling offers
the routable number as one tap ("Swap 390 000 instead").

**Swap progress — `/swap/:id`.** SSE-driven (snapshot on connect, event on every
swap/leg change, 15 s heartbeats, 5 s polling fallback). A single-leg swap gets the
"SEND EXACTLY" hero, QR and address well with COPY. A split gets "PART n OF N" cards
with the "order doesn't matter" line, exactly one card live at a time (orange border, QR
expanded) while funded parts collapse to receipt rows, and an "X of N parts funded"
aggregate. Chips walk `WAITING → PAYMENT SEEN → CONFIRMING (n/3) → SETTLED`; the 15-minute
funding countdown runs quiet gray, amber under 5:00, red pulse under 1:00, never moving
position. Terminal states: the 88 px green **Swapped** money shot with per-leg refs, and
calm expired / partially-funded / failed cards that answer "where is my money" in the
first sentence. The swap id is the only capability — the public serializer never exposes
LP identity, quote ids, webhook URLs or raw engine errors (allowlist-tested).

**Provider console — `/lp`.** Key-gated (see [the LP guide](#the-lp-guide)). Overview
leads with the earned-orange fees card — dark at zero, solid orange the moment it is
positive — beside both ledger balances, with utilization bars per direction that go amber
near cap as a prompt to add liquidity rather than an error. Liquidity is edited inline
with a live "position in the book" preview. Exposure and History are white sheets. All
views poll every 5 s, pause on a hidden tab, and carry the mock-settlement footer.

**Marketplace — `/market`, public.** The liquidity book as an artifact: direction tabs,
a totals header (total available, best rate, providers quoting), and provider rows on the
white sheet sharing the widget's route-row anatomy. Best rate gets the only orange in the
sheet — a filled chip plus a row wash — computed server-side with the router's own
preference order, so the highlighted provider is the one quotes actually drain first. The
empty book recruits.

Words like "timelock", "vault", and "VTXO" never appear on user surfaces —
render tests enforce it. The LP dashboard deliberately inverts this: LPs are
professionals pricing timelock exposure, so there the precise words are
required, and a render test asserts the vault language IS present.

## The LP guide

### Registering — operator curl, on purpose

There is no LP self-registration UI: an operator vouches for every provider.
Registration returns the LP's API key **exactly once**; it is hashed at rest
and can never be shown again.

```sh
curl -s -X POST :8080/api/lps \
  -H "Authorization: Bearer $OPENSLUICE_OPERATOR_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Penstock"}'
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
- `POST /api/lp/fund` (operator, non-production) — credit an LP. In mock mode a ledger row; in tachi mode a **real** off-chain transfer to the LP's account, booked only if it commits
- `GET /api/marketplace` (public) — the live book, capacity net of in-flight locks, per-direction `bestRate` marker computed server-side
- `POST /api/quotes` (public) — route an amount; 409 + `maxRoutableSats` when the book can't cover it
- `POST /api/swaps` (public) — accept a quote: re-validate, lock, return per-leg payment instructions; optional `webhookUrl` (HMAC-signed `X-OpenSluice-Signature`, retried with backoff)
- `GET /api/swaps/:id` (public, id = capability), `GET /api/swaps` (operator)
- `POST /dev/simulate-onchain-deposit`, `POST /dev/simulate-offchain-payment`, `POST /dev/advance-blocks` (operator, dev/mock only)

## Run it with Docker

```sh
cp .env.example .env                              # operator key + webhook secret
docker compose up --build                         # gateway on :8080, SQLite on a named volume
```

The demo compose adds the unauthenticated pay-leg buttons used in the walkthrough:

```sh
docker compose -f docker-compose.demo.yml up --build
# then seed the book against the running container:
OPENSLUICE_OPERATOR_KEY=demo_operator_key OPENSLUICE_GATEWAY_URL=http://localhost:8080 npm run seed:demo
```

It sets `NODE_ENV=development` on purpose — the image bakes in
`NODE_ENV=production`, and `loadConfig` gates *both* the dev routes and the public
simulate route on `NODE_ENV !== "production"`. Without the override the container boots
fine and the demo buttons silently do nothing.

## Deploy to Fly.io

Two configs ship: `fly.toml` (the mock demo) and `fly.live.toml` (real off-chain
settlement). Both run one always-on 512 MB machine with SQLite on a volume at `/data`;
secrets are always `fly secrets`, never `[env]`.

```sh
# mock demo
fly launch --no-deploy                # or: fly apps create <your-app>; edit app = in fly.toml
fly volumes create opensluice_data --size 1 --region jnb
fly secrets set OPENSLUICE_OPERATOR_KEY=... OPENSLUICE_WEBHOOK_SECRET=...
fly deploy
```

```sh
# real off-chain settlement (tachi-regtest-1)
fly apps create opensluice-live
fly volumes create opensluice_live_data --region jnb --size 1 --app opensluice-live
fly secrets set --app opensluice-live \
  OPENSLUICE_OPERATOR_KEY=$(openssl rand -hex 24) \
  OPENSLUICE_WEBHOOK_SECRET=$(openssl rand -hex 24) \
  OPENSLUICE_DEV_PUBLIC_SIMULATE=false \
  OPENSLUICE_TACHI_MNEMONIC="<throwaway BIP-39 mnemonic>"
fly deploy --config fly.live.toml --remote-only

# then fund the float and the providers (both are REAL transfers)
OPENSLUICE_TACHI_MNEMONIC="<same>" AMOUNT_SATS=60000 npm run fund:tachi
OPENSLUICE_SEED_PROFILE=regtest OPENSLUICE_OPERATOR_KEY=<key> \
  OPENSLUICE_GATEWAY_URL=https://opensluice-live.fly.dev npm run seed:demo
```

`fly.live.toml` keeps the adapter's key index at `/data/tachi-state.json`, **on the
volume**: lose that file and the adapter forgets which addresses it handed out, orphaning
LP accounts and any leg a user has already been told to pay. `OPENSLUICE_DEV_PUBLIC_SIMULATE`
must stay `false` — in real mode an unauthenticated pay-leg call would mint a simulated L1
deposit that triggers a **real** LP payout, and `loadConfig` refuses to boot if it is ever
set true outside mock mode.

### Operating a real-mode instance

```sh
OPENSLUICE_TACHI_MNEMONIC="…" npm run fund:tachi                    # faucet + ledger deposit
OPENSLUICE_TACHI_MNEMONIC="…" TO_ADDRESS=bcrt1p… AMOUNT_SATS=20000 npm run fund:tachi
ADDRESS=bcrt1p… AMOUNT_SATS=2000 npm run pay:tachi                  # pay a real leg as a user
fly logs --app opensluice-live                                      # real broadcasts + SIMULATED L1 lines
```

Check the operator and LP floats before a demo and refill from the faucet; a small regtest
float runs dry quickly. A wallet paying a multi-leg swap must let each payment commit
before making the next (`code=5 vtxo already pending in mempool`), so expect a split swap
to take roughly a block per leg.

`npm run fund:tachi` mints ledger value with a self-signed deposit that carries no L1
backing. The Tachi team has confirmed this is intended below mainnet — the L1 verification
gate is mainnet-only — so it is sanctioned testnet behaviour rather than a workaround, and
**signet behaves the same way**, making a signet deployment feasible with this exact
funding path (change `OPENSLUICE_TACHI_NETWORK` and the RPC URL). On mainnet the path does
not exist: ledger value would have to enter through an L1-backed deposit attested by the
validator set. See [INTEGRATION.md §5](INTEGRATION.md#5-questions-for-the-tachi-team) and
[GAPS.md](GAPS.md).

## Screenshots

See [docs/screenshots/](docs/screenshots/) for the slots and what each must show.

## Limitations, stated plainly

- **Bitcoin L1 legs are simulated, in every mode.** Off-chain settlement is real under
  `ADAPTER_MODE=tachi`, but no Bitcoin moves in either mode. The cause is tooling, not the
  protocol: `TxWithdraw` exits any ledger VTXO to L1 without a vault, but the shipped TS
  SDK has no builder for it. The adapter says so through `capabilities.onchainReal: false`
  rather than through prose. See [INTEGRATION.md](INTEGRATION.md).
- **Real mode is custodial.** The coordinator's mnemonic controls the operator float,
  every LP account and every swap-leg key, so an LP's balance is sats under a key the
  coordinator can spend. Fine for a regtest demonstration, not for real money.
- **The live instance can only demonstrate swap_out.** swap_in needs a real L1 deposit
  from the user, and L1 is simulated — see [Try it](#try-it). Both directions run fully
  on the mock demo and under `npm run e2e:tachi`.
- **No LP fee payout.** Providers can see every sat they have earned, down to the leg,
  but there is no withdrawal path — fees accumulate as ledger balance and stay there.
- **Single node, single operator, SQLite.** The coordinator is fully trusted: it books
  both sides of every ledger entry with no external attestation, and quote-lock
  re-validation relies on one process serializing on one database.

[GAPS.md](GAPS.md) is the complete, honest list.

## Sibling project

OpenSluice is built on the patterns of [OpenTill](../opentill), a self-hosted Bitcoin
point-of-sale on the same stack: the same hand-written SQL migrations, transition-map
state machines, cursor poller, HMAC webhooks, settlement-adapter seam and v2 design
token sheet. The two marks are a family: OpenTill is value dropping into an open till,
OpenSluice is the gate raised so value can move between levels — same 1.5-unit open gap,
orange always on the element in motion. See [docs/brand/](docs/brand/).

## License

MIT — see [LICENSE](LICENSE).

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
