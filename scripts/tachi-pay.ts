/**
 * Pay a real off-chain swap leg from a wallet you control.
 *
 * This is the "user" side of a real swap_out: OpenSluice hands out a genuine
 * Tachi address for the leg, and somebody has to actually send sats to it.
 * The wallet lives in .tachi-e2e-state.json (gitignored) and is deliberately
 * NOT the coordinator's — it stands in for a real user.
 *
 *   ADDRESS=bcrt1p… AMOUNT_SATS=1500 npm run pay:tachi
 *   npm run pay:tachi                      # no ADDRESS → just print the balance
 *
 * Waits for the block commit before returning, because a wallet cannot spend
 * its own change while that change is pending (`code=5 vtxo already pending in
 * mempool`) — paying the legs of a split swap has to serialise.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory } from "bip32";
import * as bip39 from "bip39";
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import {
  deriveUserKey,
  getAccountNonce,
  normalizeTaprootSigner,
  resolveWalletNetwork,
  waitForTachiTxCommit,
  xOnlyFromAddress,
} from "@tachibtc/taurus-vault-core";
import { buildSignedTransferHex } from "../packages/adapter/src/index";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const RPC = process.env.OPENSLUICE_TACHI_RPC_URL ?? process.env.TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
const STATE = ".tachi-e2e-state.json";
const client = new TachiClient({ baseUrl: RPC });
const net = bitcoin.networks.regtest;

async function wallet() {
  const persisted = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
  const mnemonic: string = persisted?.userMnemonic ?? bip39.generateMnemonic(128);
  const root = bip32.fromSeed(await bip39.mnemonicToSeed(mnemonic), net);
  const descriptor = deriveUserKey(mnemonic, resolveWalletNetwork("regtest"), { index: 0 });
  const node = root.derivePath(descriptor.path);
  const xOnly = Buffer.from(node.publicKey).subarray(1, 33);
  const address = bitcoin.payments.p2tr({ pubkey: xOnly, network: net }).address!;
  writeFileSync(STATE, JSON.stringify({ userMnemonic: mnemonic, address }, null, 2));
  return { node, xOnly, address };
}

async function main() {
  const w = await wallet();
  const balance = (await client.getBalance(w.address)).balance_sat;
  console.log(`wallet : ${w.address}`);
  console.log(`balance: ${balance} sats`);

  const toAddress = process.env.ADDRESS;
  if (!toAddress) {
    console.log("\n(no ADDRESS given — nothing sent. Fund this wallet from the operator float to use it.)");
    return;
  }
  const amountSats = BigInt(process.env.AMOUNT_SATS ?? "0");
  if (amountSats <= 0n) throw new Error("AMOUNT_SATS must be a positive integer");

  const res = await client.getAddressVtxos(w.address, false);
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
  if (inSum < need) throw new Error(`wallet holds ${inSum} spendable sats, needs ${need}`);

  const change = inSum - need;
  const outputs = [{ owner: xOnlyFromAddress(toAddress, net), amountSats }];
  if (change > 0n) outputs.push({ owner: w.xOnly, amountSats: change });

  const hex = await buildSignedTransferHex({
    signer: normalizeTaprootSigner(w.node),
    spenderXOnly: w.xOnly,
    inputs,
    outputs,
    feeSats: fee,
    nonce: await getAccountNonce(w.xOnly, { baseUrl: RPC }),
  });

  const bc = (await client.broadcastTxSync(hex)) as { result?: { code?: number; log?: string; hash?: string } };
  if (bc?.result?.code !== 0) throw new Error(`payment rejected: code=${bc?.result?.code} log=${bc?.result?.log}`);
  const hash = String(bc.result!.hash).toLowerCase();
  const st = await waitForTachiTxCommit(hash, { baseUrl: RPC, overallTimeoutMs: 90_000 });
  if (!st.committed) throw new Error(`payment ${hash} never committed: ${st.log}`);

  console.log(`\nPAID ${amountSats} sats → ${toAddress}`);
  console.log(`TX   ${hash}`);
  console.log(`left ${(await client.getBalance(w.address)).balance_sat} sats`);
}

main().catch((err: unknown) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
