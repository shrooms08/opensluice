# OpenSluice × Tachi — integration status

**OpenSluice settles off-chain value on Tachi for real.** Running with
`ADAPTER_MODE=tachi`, every leg that moves value *inside* Tachi is a real,
signed, committed ledger transaction on `tachi-regtest-1`. Every leg that would
cross to Bitcoin L1 is simulated, clearly labelled, and reported as such by the
adapter itself — not because the protocol lacks a ledger→L1 route (it has one:
lock a ledger VTXO into a vault with `TxLockForVault`, then take the vault exit
already proven on L1) but because the shipped TypeScript SDK provides no builder
for the lock step. See §2.

The evidence is in this repository and reproducible:

- [`docs/tachi-smoke-output.md`](docs/tachi-smoke-output.md) — verbatim daemon
  responses (`npm run smoke:tachi`). The ground truth the adapter is written against.
- [`docs/tachi-e2e-output.md`](docs/tachi-e2e-output.md) — three real swaps end
  to end through a real gateway (`npm run e2e:tachi`), with transaction ids.

## 1. What is real, and what is not

The adapter answers this itself; nothing else in the system is allowed to guess.
`GET /healthz` returns:

```json
{
  "adapterMode": "tachi",
  "settlement": {
    "onchainReal": false,
    "offchainReal": true,
    "label": "tachi-regtest-1",
    "chainId": "tachi-regtest-1"
  }
}
```

The UI's settlement bar, this document and the README all describe that object
rather than restating it, so they cannot drift apart.

| Adapter method | Real? | What it does |
| --- | --- | --- |
| `createOffchainAddress(ref)` | **REAL** | Derives a BIP-84 key for `ref` and returns its bech32m P2TR encoding. Memoised by `ref`: asking twice returns the same address, so a retried accept cannot orphan a payment. |
| `pollOffchain(cursor)` | **REAL** | `getAddressVtxos` over every watched address; a VTXO is emitted once, when its commit height first exceeds the cursor watermark. |
| `sendOffchain(...)` | **REAL** | Builds a plain key→key ledger TRANSFER, signs BIP-340 over the TachiTx sighash, `broadcastTxSync`, then **verifies `result.code === 0` and waits for the block commit** before returning. |
| `fundOffchainAccount(...)` | **REAL** | The same primitive, operator float → an LP's own derived account. This is how a provider comes to hold sats it can front. |
| `createOnchainDepositAddress(ref)` | *simulated* | Returns a `mockbtc1q…` address — unmistakably not a Bitcoin address — and logs `SIMULATED L1 deposit address`. |
| `pollOnchain(cursor)` | *simulated* | Mock confirmations, driven by the operator-only `/dev/advance-blocks` route. |
| `sendOnchain(...)` | *simulated* | Logs `SIMULATED L1 payout — no Bitcoin moved` and returns a `mocktx_…` id. The real implementation locks the leg's ledger VTXO into a vault (`TxLockForVault`) and exits that vault to L1; blocked on an SDK builder for the lock step, not on the protocol (§2). |

### What that means per direction

- **swap_out** — the user pays their leg **for real** to a Tachi address the
  adapter derived; the poller detects the committed VTXO; the LP's payout to
  Bitcoin is simulated.
- **swap_in** — the user's Bitcoin deposit is simulated; the LP's payout to the
  user is a **real** Tachi transfer.

Either way, the leg that moves value inside Tachi is real. In the e2e run a
user's real balance moved `7 596 → 8 795 sats`, matching the quoted receive of
1 199 sats exactly.

## 2. The L1 boundary — an SDK gap, not a protocol gap

**Correction (August 2026).** This section previously stated that a vault was
the only vessel for L1 entry/exit and that no on-the-fly ledger→L1 exit existed.
That was our reading of an earlier exchange, and it is **wrong**. The Tachi team
has since set out the actual picture *(Telegram, August 2026; paraphrased)*:

- **`TxVaultOpen`** registers an L1-funded vault directly against an **L1
  outpoint**. It never touches the ledger-VTXO pool at all.
- **`TxLockForVault` / `TxUnlockFromVault`** are the real ledger→vault bridge:
  they lock an existing ledger VTXO under a vault address and release it back.
  This is the path for putting ordinary receipt VTXOs into vault custody.
- **`TxWithdraw`** was described as a plain ledger→L1 exit needing no vault.
  **This has since been retracted — see the correction immediately below.**

Their recommendation at the time was that `TxWithdraw` was the more direct route
for "real value in → real payout out", with `TxLockForVault` reserved for cases
wanting the quorum-cosigned / unilateral-exit guarantees.

### Second correction — `TxWithdraw` is a dead end

*(Tachi team, Telegram, August 2026; paraphrased. They inspected their own source
and corrected the recommendation above.)*

**`TxWithdraw` (0x05) is unimplemented, not merely undocumented.** It carries no
special-case handling anywhere in consensus or mempool beyond the generic format
checks: it is validated exactly like a transfer — inputs, outputs, a valid
signature, a balance — and it simply moves VTXOs around inside the ledger. There
is **no L1 broadcast, no destination-address semantics, and nothing
withdraw-specific implemented at all**. There is no payload for us to mirror
because the daemon does nothing with the type beyond generic validation.

The practical consequence is severe and worth stating bluntly: a payout built on
`TxWithdraw` would be accepted, would commit, and would move **nothing** to L1.
It would look like a successful payout and silently be a no-op. That is the
single worst failure mode this codebase could ship, and it is exactly what we
would have built had we taken the earlier recommendation at face value.

So the ledger→L1 route for a plain-key VTXO is **not** `TxWithdraw`. It is:

> merchant/leg receipts (plain-key ledger VTXOs) → **`TxLockForVault`** into a
> vault → the vault exit path already proven on L1.

The vault exit half is not speculative. The sibling project drove both exits for
real on `tachi-regtest-1`: a **cooperative refund** with five validator partial
signatures (`b78cdb628a118fdb95090601914dedbaab4ba3c895432fbb10ea7bf25982f86b`)
and a **unilateral exit** with user signature only, sweeping 299 500 sats back to
L1 (`5bb2960bf27b6715228abe784a47bbb354b3aff3d7182e352fec882a7a67d0c3`) — see
[`../opentill/docs/tachi-vault-spike.md`](../opentill/docs/tachi-vault-spike.md).
Cooperative refund is the normal payout path; unilateral exit is the sovereignty
backstop. What that spike could not do was exit *earned* value, because
`TxVaultOpen` binds an L1 outpoint rather than ledger VTXOs. `TxLockForVault` is
the missing link between the two halves.

### `TxLockForVault` (0x06) — a real contract, even without a builder

Tachi gave us the wire contract directly:

- Same base fields as any transaction: inputs, outputs, fee, `pubKey`,
  `signature`, `nonce`.
- **`PSBTPayload` is required**, and must be a **finalized PSBT with exactly one
  P2TR output**. The daemon decodes that output's witness program straight into
  the vault's bech32m address. Zero taproot outputs fails; more than one fails.
- Referenced input VTXOs must exist and must not already be locked.
- Only a fee-balance check applies, since the lock creates no new VTXO outputs —
  although the generic format check still expects `Outputs` to be non-empty.
  What that path actually accepts for a lock is worth confirming empirically
  rather than assuming.
- To build one: construct a PSBT whose single output pays the target vault's
  taproot address (the same address derived at vault open), finalize it, and put
  the raw bytes in `PSBTPayload`.

`TxUnlockFromVault` is the corresponding release path.

### Why OpenSluice's L1 legs are still simulated

The blocker is tooling, not the protocol — but it is a bigger piece of tooling
than we thought a week ago. The shipped TypeScript SDK
(`@tachibtc/tachi-sdk-ts` 0.2.1, `@tachibtc/taurus-vault-core` 0.3.3) ships **no
builder for `TxLockForVault` or `TxUnlockFromVault`**. Unlike `TxWithdraw`,
though, these are not dead ends: their contract is now specified (above), so
they are implementable without a reference implementation to copy — a PSBT with
one P2TR output, finalized, in `PSBTPayload`.

We can construct a `TRANSFER` because `buildSignedTransferHex` had a documented
shape to copy and we verified it against the live daemon. A payout is a longer
chain — lock into a vault, then exit that vault — and each link needs the same
verification before a user's money depends on it. The sibling project is spiking
the lock step now (`npm run spike:lock`; results will land in
[`../opentill/docs/tachi-lock-spike.md`](../opentill/docs/tachi-lock-spike.md)).
OpenSluice will adopt whatever that proves rather than guessing in parallel.

Until then `sendOnchain` stays simulated and says so on every call:
`capabilities.onchainReal` is `false`, the mock L1 hands out addresses that could
never be mistaken for Bitcoin addresses, and the UI carries a persistent
`PARTIAL` bar reading *"Off-chain settlement live on tachi-regtest-1 · L1 legs
simulated"*.

**What changes when the lock step is proven.** Only the three on-chain methods,
and only inside the adapter:

1. `createOnchainDepositAddress` returns a real watched Bitcoin address.
2. `pollOnchain` reads real confirmations — the daemon's Bitcoin RPC proxy
   already works (`scantxoutset` is exercised in the smoke record), so this is
   the smaller half.
3. `sendOnchain` becomes a two-stage payout: `TxLockForVault` moves the leg's own
   ledger VTXO into vault custody, then the already-proven vault exit pays the
   user on L1 (cooperative refund normally, unilateral exit as the backstop). The
   same discipline `sendOffchain` already applies carries over to both stages —
   verify the verdict, wait for the commit, and only then report success.

Then `onchainReal` flips to `true` and the banner disappears on its own. Nothing
outside the adapter changes: the router, the ledger, the state machines, the LP
console and all 200 tests are adapter-agnostic.

## 3. Hard-won facts the code depends on

These were verified live, not read from docs:

- **A resolved promise is not success.** CometBFT reports failure inside an
  HTTP 200 via `result.code` / `result.log`; the Bitcoin RPC proxy uses a
  non-null `error`. `assertBroadcastOk` is the only place either is read, and
  `sendOffchain` additionally waits for the block commit — a mempool accept can
  still be dropped. A unit test pins the `code != 0` case.
- **`vtxoId === computeVtxoId(txHash, vout)`** — asserted MATCH against the live
  daemon three times in the smoke run (one deposit, two transfers). Payment ids
  are therefore stable from broadcast onward.
- **Ledger deposits need `fee ≥ 1` sat** (fee 0 is rejected with code 8).
- **A self-signed deposit with no L1 backing commits below mainnet.** Observed
  in the smoke run and since confirmed as intended: the L1 verification gate is
  mainnet-only (§5). This is what funds the operator float on regtest.
- **Taproot addresses only** for VTXO queries; tx hex carries no `0x`.
- **A wallet cannot spend its own change while that change is pending** —
  `code=5 vtxo already pending in mempool`. This bit the e2e when paying the
  second leg of a split swap, and it is a real constraint on any wallet paying a
  multi-leg swap: wait for the previous payment to commit first. The adapter is
  already safe here because `sendOffchain` awaits the commit before returning.
- **`watch({ address })` works** and streams `state: "pending"` then
  `state: "committed"` for the same `tx_hash` (verbatim in the smoke record).
  It is deliberately **not** load-bearing: polling `getAddressVtxos` is the
  crash-safe correctness path, and a WebSocket that misses a frame while the
  process is restarting must not be able to lose a payment.
- **Pending credits are never reported as committed.** OpenSluice's off-chain
  leg has exactly one terminal status, and that status books the LP's ledger
  rows. Emitting a mempool credit would book money that can still be dropped —
  the worst bug available here — so `pollOffchain` reads committed VTXOs only.

## 4. LP funding on regtest — the piece OpenTill did not need

A provider must actually hold sats inside Tachi before it can front a swap.
`POST /api/lp/fund` (operator-authenticated) does this in real mode:

1. derive/lookup the LP's own account key for `lp:<lpId>`;
2. perform a **real** ledger transfer from the operator float to that address;
3. write the `lp_ledger` row **only if that transfer commits**. A failed
   transfer returns `502 settlement_failed` and books nothing.

Getting sats into the operator float on regtest is the documented two-step from
the smoke record: claim from `https://faucet.tachibtc.com/api/faucet` (an L1
UTXO), then mint the matching ledger value with a self-signed
`buildTachiTxDeposit`. `scripts/tachi-fund.ts` (`npm run fund:tachi`) does
exactly this, and `npm run e2e:tachi` does it automatically when the float runs
low.

That self-signed deposit is **sanctioned testnet behaviour, not a workaround**.
The Tachi team confirmed that the L1 verification gate is enabled only for
mainnet, so below mainnet a deposit with no L1 backing is accepted by design —
see §5. Both the operator float and every LP credit therefore rest on a
deliberate testnet affordance rather than on a gap we found. What that costs us
on mainnet is set out in the same section and in [GAPS.md](GAPS.md).

On-chain LP credits stay bookkeeping-only in both modes, because L1 legs are
simulated.

## 5. Questions for the Tachi team

### Answered

**Self-signed deposits below mainnet — resolved.** *(Tachi team, Telegram,
August 2026; paraphrased.)* Self-signed deposits carrying no L1 backing are
accepted on **both regtest and signet**: the L1 verification gate is enabled
only for mainnet. The sanctioned mechanism already exists in the code and is
simply switched off below mainnet — each validator independently verifies a
claimed deposit against its own `bitcoind`, requiring the amount and the block
height/timestamp to match exactly, signs an attestation, and the deposit
finalizes once those attestations clear a threshold.

Three consequences for OpenSluice:

1. **Our regtest funding path is legitimate.** `scripts/tachi-fund.ts` and the
   operator LP-funding route (`POST /api/lp/fund`) both depend on this
   affordance. They are using testnet as intended, not exploiting a missing
   check.
2. **Mainnet would need a different funding story.** Ledger value could only
   enter through L1-backed deposits that validators attest to, which changes how
   both the operator float and every LP are funded — see [GAPS.md](GAPS.md).
3. **Signet is a viable target today.** Deposits reportedly behave identically
   there, so a signet deployment works with the funding approach already in the
   repo; only `OPENSLUICE_TACHI_NETWORK` and the RPC URL change.

**The ledger → vault bridge, and the ledger → L1 exit — resolved.** *(Tachi
team, Telegram, August 2026; paraphrased.)* Three distinct transaction types,
which we had previously conflated into one missing capability:

| Type | What it actually does |
| --- | --- |
| `TxVaultOpen` | Registers an **L1-funded** vault against an L1 outpoint. Never touches the ledger-VTXO pool. |
| `TxLockForVault` / `TxUnlockFromVault` | **The ledger→vault bridge.** Locks an existing ledger VTXO under a vault address, and releases it back. This is how ordinary receipt VTXOs enter vault custody. |
| `TxWithdraw` | ~~A plain ledger→L1 exit requiring no vault.~~ **Retracted.** Unimplemented beyond generic format checks — see below. |

**Superseded (same month).** Tachi initially recommended `TxWithdraw` as the more
direct answer to "real value in → real payout out". They then inspected their own
source and withdrew that: `TxWithdraw` (0x05) has no special-case handling in
consensus or mempool, no L1 broadcast and no destination-address semantics, so a
payout built on it would commit and move nothing. The real route is
`TxLockForVault` into a vault followed by the vault exit already proven on L1.
§2 carries the full correction and the `TxLockForVault` wire contract.

This is why the sibling project's vault spike
([`../opentill/docs/tachi-vault-spike.md`](../opentill/docs/tachi-vault-spike.md))
could only ever exit funds it had deposited itself: `TxVaultOpen` binds an L1
outpoint, so a vault opened that way has no relationship to ledger VTXOs earned
from receipts. `TxLockForVault` is the step that was missing, and we did not
know it existed. OpenSluice ran no vault spike of its own; the finding is
recorded here because it changes what this document had called impossible.

**`TxVaultClose` (0x12) is defined but not wired.** The vault `State` field is
hardcoded `"open"` because the closing/closed/breaching writer is not
implemented, and there is no client-side `TxVaultClose` to send. Practical
consequence for anyone building on this: **do not treat the daemon's reported
vault state as liveness**. Track it from your own L1 exit-leaf observation
instead.

**CSV timelock: no protocol minimum.** The protocol enforces only `> 0` and
`<= 65535`. The sibling spike's `csvBlocks=1` was accepted purely because
nothing rejects it — in Tachi's words, that is not a signal it is safe. The
conventional choice is **1008 blocks (~7 days)**; the real lower bound should be
derived from your own monitoring latency, i.e. how long you might fail to notice
a breach and still be able to respond. Any OpenSluice vault work should start
from 1008 and justify downward, never upward from 1.

### Still open

1. **An SDK builder for `TxLockForVault` / `TxUnlockFromVault`.** Now the only
   blocker for `onchainReal: true`. The wire contract is specified (§2) and the
   vault exit on the far side is already proven on L1, so this is implementable
   rather than blocked — it just needs building and verifying against the live
   daemon before a user's payout depends on it. The sibling project is spiking it
   (`npm run spike:lock`). *(The earlier ask here — a payload reference for
   `TxWithdraw` — is closed: there is nothing to reference, because the type is
   unimplemented.)*
2. **Sub-account / delegated ownership.** Today every LP account is a key
   derived from the coordinator's single mnemonic, so the coordinator can spend
   an LP's balance. Is there a supported way for an LP to own its VTXOs under
   its *own* key while still authorising the coordinator to spend them for a
   specific swap leg (a co-signed or conditional spend)? That would remove the
   custody assumption in §6.
3. **Spending pending change.** Is `code=5 vtxo already pending in mempool`
   intended and permanent? A wallet paying a 3-leg split currently has to
   serialise its payments across blocks, which makes a multi-leg swap noticeably
   slower than a single-leg one.
4. **Nonce semantics under concurrency.** `getAccountNonce` is read immediately
   before signing. If two legs of the same swap are paid from one key
   concurrently, is the second guaranteed to be rejected rather than silently
   reordered?

## 6. Custody, stated plainly

In real mode the coordinator's mnemonic controls the operator float, every LP
account and every swap-leg key. An LP's balance is an entry in the coordinator's
`lp_ledger` plus sats sitting under a key the coordinator can spend. That is
acceptable for a regtest demonstration and is not acceptable for real money;
§5's "Still open" question 2 is the path out. See [GAPS.md](GAPS.md).

## Sibling project

OpenSluice shares OpenTill's adapter philosophy and much of its Tachi plumbing
(`tachi/keys.ts`, `client.ts`, `tx.ts`, `state.ts` are deliberate adaptations).
OpenTill's open questions apply here too; OpenSluice adds LP-side funding and
custody, which a single-merchant till never had to answer.
