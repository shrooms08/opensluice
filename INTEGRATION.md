# OpenSluice × Tachi — integration status

**OpenSluice settles off-chain value on Tachi for real.** Running with
`ADAPTER_MODE=tachi`, every leg that moves value *inside* Tachi is a real,
signed, committed ledger transaction on `tachi-regtest-1`. Every leg that would
cross to Bitcoin L1 is simulated, clearly labelled, and reported as such by the
adapter itself.

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
| `sendOnchain(...)` | *simulated* | Logs `SIMULATED L1 payout — no Bitcoin moved` and returns a `mocktx_…` id. |

### What that means per direction

- **swap_out** — the user pays their leg **for real** to a Tachi address the
  adapter derived; the poller detects the committed VTXO; the LP's payout to
  Bitcoin is simulated.
- **swap_in** — the user's Bitcoin deposit is simulated; the LP's payout to the
  user is a **real** Tachi transfer.

Either way, the leg that moves value inside Tachi is real. In the e2e run a
user's real balance moved `7 596 → 8 795 sats`, matching the quoted receive of
1 199 sats exactly.

## 2. The L1 boundary — quoted, not worked around

The Tachi team's position, confirmed directly:

> A vault is the only vessel for L1 entry/exit, and on-the-fly exit from Tachi
> to L1 has no cryptographic support yet — it "will be addressed soon". A
> vault-less receiver exiting to L1 was mentioned as possible, but it is
> unconfirmed and has no SDK builder.

So there is no honest way to implement `sendOnchain` today. The options were to
fake it, to refuse to run at all, or to simulate it and say so on every call.
We chose the third: `capabilities.onchainReal` is `false`, every simulated
action logs that it is simulated, the mock L1 hands out addresses that could
never be mistaken for Bitcoin addresses, and the UI carries a persistent
`PARTIAL` bar reading *"Off-chain settlement live on tachi-regtest-1 · L1 legs
simulated"*.

**What changes when on-the-fly exit ships.** Only the three on-chain methods,
and only inside the adapter:

1. `createOnchainDepositAddress` returns a real watched Bitcoin address (vault
   deposit or a derived L1 address).
2. `pollOnchain` reads real confirmations — the daemon's Bitcoin RPC proxy
   already works (`scantxoutset` is exercised in the smoke record), so this is
   the smaller half.
3. `sendOnchain` builds the exit/withdrawal transaction with whatever builder
   ships, and applies the same discipline `sendOffchain` already does: verify
   the verdict, wait for the commit, and only then report success.

Then `onchainReal` flips to `true` and the banner disappears on its own. Nothing
outside the adapter changes: the router, the ledger, the state machines, the
LP console and all 197 tests are adapter-agnostic.

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

### Still open

1. **The ledger → vault bridge.** The one blocker for `onchainReal: true`, and
   the question that governs whether OpenSluice's L1 legs could ever be real. A
   vault is currently the only vessel for L1 entry/exit (§2), and there is no
   on-the-fly exit from the ledger. Will there be an SDK builder for the
   wire-level `TxWithdraw`, and is the vault-less receiver exit real?
   Everything else on our side is ready.
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
