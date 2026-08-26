# OpenSluice × Tachi — live end-to-end

- when: 2026-08-25T17:49:11.250Z
- rpc: `https://rpc-regtest.tachibtc.com`
- node: v24.14.0

## 0. Boot — what this gateway actually settles

`GET /healthz` →

```json
{
  "ok": true,
  "adapterMode": "tachi",
  "dbOk": true,
  "settlement": {
    "onchainReal": false,
    "offchainReal": true,
    "label": "tachi-regtest-1",
    "chainId": "tachi-regtest-1"
  }
}
```

The `settlement` object is the single source of truth: off-chain legs are REAL on `tachi-regtest-1`, L1 legs are simulated.

Operator float: `bcrt1p5qzlafkz34gl6ecs2ghksscvkv82xrsg2l0pmsnxvn8xnkpz9uyqvnz87w` holding 6 995 sats.
Float is low — topping up from the regtest faucet + a ledger deposit…
  faucet → HTTP 200 txid ca373312f9887137be65eef5cada10b7b5a13ecc2da91d25895081f185d52444
  → real deposit tx `f430fec15838203e4059bdd2b5ed2681dfa5b2106789e6176e5557bbaf03fd7d`
  operator float now holds 56 995 sats
User wallet (external): `bcrt1pnq7q5f9q9h36sa0dv2ztma498fwp5w639l5hlul962n3e5z8p49sepsy7l` holding 3 397 sats.
Topping the user wallet up with 6 000 sats from the operator float (a real transfer)…
  → real tx `d84f910b80af06269d9d66c098469540e867884a6939ac5bd307bf8186de72f8`
  user wallet now holds 9 397 sats

LP Penstock: funded 3 000 sats off-chain — REAL tx `8486a46de498270c9fe9ea17998f64452bb6d6c7264f730db8ea5bcfdbf06ebf`
  LP account address: `bcrt1pg6xy9gvg5vpsm8zcwydsjwd9c0awvtmexkz22fppdl7jr7955p9sk2trh8`

LP Headwater: funded 2 500 sats off-chain — REAL tx `c72616cf62d7e26bdc855647634a3573047d968495db657c94da31a6c322eacf`
  LP account address: `bcrt1pcaq5440gmhr3mqmnaj3fe8jnwdkmnq9jekwy5ejz3hts9wejyy7sw7xrg7`

## 1. LP funding is real

- **Penstock** → `bcrt1pg6xy9gvg5vpsm8zcwydsjwd9c0awvtmexkz22fppdl7jr7955p9sk2trh8` funded by real ledger transfer `8486a46de498270c9fe9ea17998f64452bb6d6c7264f730db8ea5bcfdbf06ebf`
- **Headwater** → `bcrt1pcaq5440gmhr3mqmnaj3fe8jnwdkmnq9jekwy5ejz3hts9wejyy7sw7xrg7` funded by real ledger transfer `c72616cf62d7e26bdc855647634a3573047d968495db657c94da31a6c322eacf`

This is the piece OpenTill never needed: a provider must hold actual sats inside Tachi before it can front a swap. The route books the `lp_ledger` row only after the transfer commits — a failed transfer writes nothing.

### Swap 1 — swap_out (user pays off-chain for real)
swap `sw_41928d6d-9601-40f0-aebe-4c0dd955005a` · leg pays 1 800 sats to REAL address `bcrt1pc0wvy2vvvks9frf596ej87zhrhawkx64lkkkda35q50908ptyffq7z4735`
user paid for REAL: tx `a82ac9b4bca834c92da045a42ad9f53f74595f39b56265cb1a2d4a486722ba73`
poller detected it: leg → `broadcasting`
swap_out completed · LP payout tx (SIMULATED L1) `mocktx_c789fc90490a23e02d3d8708b4bf1568`

## 2. swap_out — the user-facing leg is real

- quote: 1 800 sats out, fee 3 sats, receive 1 797 sats
- leg deposit address (**real Tachi**): `bcrt1pc0wvy2vvvks9frf596ej87zhrhawkx64lkkkda35q50908ptyffq7z4735`
- user's payment (**real ledger tx**): `a82ac9b4bca834c92da045a42ad9f53f74595f39b56265cb1a2d4a486722ba73`
- detected by `getAddressVtxos` polling → leg `broadcasting`
- LP's payout to L1 (**simulated**): `mocktx_c789fc90490a23e02d3d8708b4bf1568`
- final swap status: `completed`

### Swap 2 — swap_in (LP pays the user off-chain for real)
swap `sw_3c039465-84cc-46b6-9e69-e16c2cf7e4dc` · user must deposit 1 200 sats to SIMULATED L1 address `mockbtc1qgdtm0cjraecqalecjxq2a2d41`
simulated the user's L1 deposit (operator-authenticated dev route)
swap_in completed · LP's REAL off-chain payout tx `cc500206d08bef77d91f3e8123154ee8f74c417ab35ab3881b65f73e2453dc3b`
user's real Tachi balance 7 596 sats → 8 795 sats (+1 199 sats)

## 3. swap_in — the LP's payout is real

- quote: 1 200 sats in, fee 1 sats, receive 1 199 sats
- user's L1 deposit (**simulated**) to `mockbtc1qgdtm0cjraecqalecjxq2a2d41`
- LP's payout (**real ledger tx**): `cc500206d08bef77d91f3e8123154ee8f74c417ab35ab3881b65f73e2453dc3b`
- user's real balance moved 7 596 sats → 8 795 sats, i.e. **+1 199 sats** — matching the quoted receive of 1 199 sats
- final swap status: `completed`

### Swap 3 — split swap_out, two LPs, two real payments
quote routed across 2 providers: Penstock 2000, Headwater 1000
  paid leg 2 000 sats → `bcrt1phga97y0720cuanng84dtnhul8wmwjxq77jr9qamcumwt38e8gw4sws5jh4` · REAL tx `9e5a09bfc7336d1be86fc1bd7b8f1b8f426eeb8314a64a3c9d3b42a8cbf53e6b` (committed)
  paid leg 1 000 sats → `bcrt1pj5v7n7aupvy3cr6qfzthut8stm4jkzay46edasrraayfrq9j8pssr5a9g7` · REAL tx `dbc6ff52ffdae2d5d90567a6fdec9447b92585d6f43045858f6ac55599e15640` (committed)

## 4. Split swap — two providers, two real payments

- quote: 3 000 sats across 2 providers
  - Penstock: 2 000 sats · **real tx** `9e5a09bfc7336d1be86fc1bd7b8f1b8f426eeb8314a64a3c9d3b42a8cbf53e6b`
  - Headwater: 1 000 sats · **real tx** `dbc6ff52ffdae2d5d90567a6fdec9447b92585d6f43045858f6ac55599e15640`
- final swap status: `completed`

## 5. Reconciliation

- **Penstock** — ledger says off-chain 5 601 sats, fees earned 8 sats; the LP's real Tachi account `bcrt1pg6xy9gvg5vpsm8zcwydsjwd9c0awvtmexkz22fppdl7jr7955p9sk2trh8` holds 797 sats
- **Headwater** — ledger says off-chain 3 500 sats, fees earned 3 sats; the LP's real Tachi account `bcrt1pcaq5440gmhr3mqmnaj3fe8jnwdkmnq9jekwy5ejz3hts9wejyy7sw7xrg7` holds 10 000 sats
- operator float: 47 993 sats
- user wallet: 5 793 sats

The internal `lp_ledger` and the real Tachi balances are **separate books** and are expected to differ: the ledger tracks each LP's entitlement inside the coordinator, while the coordinator's keys hold the pooled float that actually pays. Reconciling the two automatically is not implemented — see GAPS.md.
