/**
 * Top up a coordinator's off-chain float on regtest.
 *
 * Two steps, exactly as recorded in docs/tachi-smoke-output.md §5-6: claim from
 * the faucet (which produces an L1 UTXO), then mint the matching ledger value
 * with a self-signed deposit. Ledger deposits need fee >= 1 sat.
 *
 *   OPENSLUICE_TACHI_MNEMONIC="..." npm run fund:tachi            # 50 000 sats
 *   OPENSLUICE_TACHI_MNEMONIC="..." AMOUNT_SATS=100000 npm run fund:tachi
 *   ... SKIP_FAUCET=true npm run fund:tachi     # ledger deposit only
 *
 * With TO_ADDRESS set it instead moves sats OUT of the float to any taproot
 * address — how you fund a demo user wallet, or hand an LP more headroom:
 *
 *   ... TO_ADDRESS=bcrt1p… AMOUNT_SATS=20000 npm run fund:tachi
 *
 * Operating note: the faucet caps a single claim and rate-limits per address,
 * so a big float is several runs rather than one large one.
 */
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory } from "bip32";
import * as bip39 from "bip39";
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { buildSignedTransferHex } from "../packages/adapter/src/index";
import {
  buildTachiTxDeposit,
  deriveUserKey,
  encodeTachiTx,
  getAccountNonce,
  normalizeTaprootSigner,
  resolveWalletNetwork,
  signTachiTx,
  waitForTachiTxCommit,
  xOnlyFromAddress,
} from "@tachibtc/taurus-vault-core";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const RPC = process.env.OPENSLUICE_TACHI_RPC_URL ?? process.env.TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
const FAUCET = process.env.TACHI_FAUCET_URL ?? "https://faucet.tachibtc.com";
const client = new TachiClient({ baseUrl: RPC });
const net = bitcoin.networks.regtest;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mnemonic = process.env.OPENSLUICE_TACHI_MNEMONIC;
  if (!mnemonic) throw new Error("OPENSLUICE_TACHI_MNEMONIC is required");
  const amountSats = BigInt(process.env.AMOUNT_SATS ?? "50000");

  // Index 0 of the receive chain is the coordinator's operator float — the
  // same key TachiRealSettlementAdapter derives on boot.
  const root = bip32.fromSeed(await bip39.mnemonicToSeed(mnemonic.trim()), net);
  const descriptor = deriveUserKey(mnemonic.trim(), resolveWalletNetwork("regtest"), { index: 0 });
  const node = root.derivePath(descriptor.path);
  const xOnly = Buffer.from(node.publicKey).subarray(1, 33);
  const address = bitcoin.payments.p2tr({ pubkey: xOnly, network: net }).address!;

  console.log(`rpc      : ${RPC}`);
  console.log(`operator : ${address}`);
  console.log(`balance  : ${(await client.getBalance(address)).balance_sat} sats (before)`);

  // ---- outward transfer mode -------------------------------------------------
  const toAddress = process.env.TO_ADDRESS;
  if (toAddress) {
    const res = await client.getAddressVtxos(address, false);
    const spendable = res.vtxos.filter((v) => !v.spent && !v.locked).sort((a, b) => b.amount - a.amount);
    const fee = 1n;
    const need = amountSats + fee;
    const inputs: Array<{ vtxoId: string; valueSats: bigint }> = [];
    let inSum = 0n;
    for (const v of spendable) {
      inputs.push({ vtxoId: v.id, valueSats: BigInt(v.amount) });
      inSum += BigInt(v.amount);
      if (inSum >= need) break;
    }
    if (inSum < need) throw new Error(`float holds ${inSum} spendable sats in one key, needs ${need}`);
    const change = inSum - need;
    const outputs = [{ owner: xOnlyFromAddress(toAddress, net), amountSats }];
    if (change > 0n) outputs.push({ owner: xOnly, amountSats: change });
    const transferHex = await buildSignedTransferHex({
      signer: normalizeTaprootSigner(node),
      spenderXOnly: xOnly,
      inputs,
      outputs,
      feeSats: fee,
      nonce: await getAccountNonce(xOnly, { baseUrl: RPC }),
    });
    const tbc = (await client.broadcastTxSync(transferHex)) as { result?: { code?: number; log?: string; hash?: string } };
    if (tbc?.result?.code !== 0) throw new Error(`transfer rejected: code=${tbc?.result?.code} log=${tbc?.result?.log}`);
    const thash = String(tbc.result!.hash).toLowerCase();
    const tst = await waitForTachiTxCommit(thash, { baseUrl: RPC, overallTimeoutMs: 90_000 });
    if (!tst.committed) throw new Error(`transfer ${thash} never committed: ${tst.log}`);
    console.log(`sent     : ${amountSats} sats → ${toAddress}`);
    console.log(`transfer : ${thash}`);
    console.log(`balance  : ${(await client.getBalance(address)).balance_sat} sats (after)`);
    return;
  }

  if (process.env.SKIP_FAUCET !== "true") {
    try {
      const res = await fetch(`${FAUCET}/api/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, amountBtc: 0.001, proof: null }),
      });
      const body = (await res.json().catch(() => ({}))) as { txid?: string };
      console.log(`faucet   : HTTP ${res.status} ${body?.txid ?? JSON.stringify(body).slice(0, 160)}`);
      await sleep(12_000);
    } catch (err) {
      console.log(`faucet   : claim failed (${err instanceof Error ? err.message : String(err)}) — trying the deposit anyway`);
    }
  }

  const nonce = await getAccountNonce(xOnly, { baseUrl: RPC });
  const draft = buildTachiTxDeposit({ userXOnly: xOnly, amountSats, nonce, feeSats: 1n });
  const signed = await signTachiTx(draft, normalizeTaprootSigner(node));
  const hex = encodeTachiTx(signed).toString("hex");

  // A resolved promise is not success: read the CometBFT verdict, then commit.
  const bc = (await client.broadcastTxSync(hex)) as { result?: { code?: number; log?: string; hash?: string } };
  if (bc?.result?.code !== 0) {
    throw new Error(`deposit rejected: code=${bc?.result?.code} log=${bc?.result?.log}`);
  }
  const hash = String(bc.result!.hash).toLowerCase();
  const st = await waitForTachiTxCommit(hash, { baseUrl: RPC, overallTimeoutMs: 90_000 });
  if (!st.committed) throw new Error(`deposit ${hash} never committed: ${st.log}`);

  console.log(`deposit  : ${hash}`);
  console.log(`balance  : ${(await client.getBalance(address)).balance_sat} sats (after)`);
}

main().catch((err: unknown) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
