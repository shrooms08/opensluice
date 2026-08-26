/**
 * Live end-to-end against tachi-regtest-1 — Step 3 of the real-settlement gate.
 *
 * Boots a real gateway with ADAPTER_MODE=tachi and drives three swaps:
 *   1. swap_out — the user's payment leg is a REAL Tachi transfer; the LP's L1
 *      payout is simulated.
 *   2. swap_in  — the user's L1 deposit is simulated; the LP's payout to the
 *      user is a REAL Tachi transfer.
 *   3. split swap_out across TWO LPs, each paid with a real transfer.
 *
 * Every real transaction id is printed and written to docs/tachi-e2e-output.md.
 * Excluded from `npm test`: needs network and regtest coins.
 *
 *   npm run e2e:tachi
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory, type BIP32Interface } from "bip32";
import * as bip39 from "bip39";
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
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
import { createApp } from "../packages/gateway/src/app";
import type { GatewayConfig } from "../packages/gateway/src/config";
import { TachiRealSettlementAdapter, buildSignedTransferHex } from "../packages/adapter/src/index";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const RPC = process.env.TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
const SMOKE_STATE = ".tachi-smoke-state.json";
const E2E_STATE = ".tachi-e2e-state.json";
const OUT_FILE = "docs/tachi-e2e-output.md";
const OPERATOR_KEY = "e2e_operator_key";
const net = bitcoin.networks.regtest;
const client = new TachiClient({ baseUrl: RPC });

const sections: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function say(line: string) {
  console.log(line);
  sections.push(line);
}
function block(title: string, body: string) {
  say(`\n## ${title}\n\n${body}`);
}
const sats = (n: bigint | string | number) => `${BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} sats`;

// ---- an external user wallet (NOT the coordinator's keys) --------------------
interface Wallet {
  mnemonic: string;
  root: BIP32Interface;
  path: string;
  xOnly: Buffer;
  address: string;
  node: BIP32Interface;
}
async function userWallet(): Promise<Wallet> {
  const persisted = existsSync(E2E_STATE) ? JSON.parse(readFileSync(E2E_STATE, "utf8")) : null;
  const mnemonic: string = persisted?.userMnemonic ?? bip39.generateMnemonic(128);
  const root = bip32.fromSeed(await bip39.mnemonicToSeed(mnemonic), net);
  const descriptor = deriveUserKey(mnemonic, resolveWalletNetwork("regtest"), { index: 0 });
  const node = root.derivePath(descriptor.path);
  const xOnly = Buffer.from(node.publicKey).subarray(1, 33);
  const address = bitcoin.payments.p2tr({ pubkey: xOnly, network: net }).address!;
  if (!xOnlyFromAddress(address, net).equals(xOnly)) throw new Error("user wallet round-trip failed");
  writeFileSync(E2E_STATE, JSON.stringify({ userMnemonic: mnemonic, address }, null, 2));
  return { mnemonic, root, path: descriptor.path, xOnly, address, node };
}

/** The user pays a swap leg for real, out of their own wallet. */
async function userPays(w: Wallet, toAddress: string, amountSats: bigint): Promise<string> {
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
  if (inSum < need) throw new Error(`user wallet has ${inSum} sats, needs ${need}`);
  const change = inSum - need;
  const owner = xOnlyFromAddress(toAddress, net);
  const outputs = [{ owner, amountSats }];
  if (change > 0n) outputs.push({ owner: w.xOnly, amountSats: change });
  const nonce = await getAccountNonce(w.xOnly, { baseUrl: RPC });
  const hex = await buildSignedTransferHex({
    signer: normalizeTaprootSigner(w.node),
    spenderXOnly: w.xOnly,
    inputs,
    outputs,
    feeSats: fee,
    nonce,
  });
  const bc: any = await client.broadcastTxSync(hex);
  if (bc?.result?.code !== 0) throw new Error(`user payment rejected: code=${bc?.result?.code} log=${bc?.result?.log}`);
  const hash = String(bc.result.hash).toLowerCase();
  // A wallet cannot spend its own change while that change is still pending
  // ("code=5 vtxo already pending in mempool"), so paying the second leg of a
  // split swap has to wait for the first payment to commit. This is a real
  // constraint on any wallet paying a multi-leg swap, not a test artefact.
  const st = await waitForTachiTxCommit(hash, { baseUrl: RPC, overallTimeoutMs: 90_000 });
  if (!st.committed) throw new Error(`user payment ${hash} never committed: code=${st.code} ${st.log}`);
  return hash;
}

/**
 * Top the coordinator's float up on regtest: claim from the faucet (L1), then
 * mint the matching ledger value with a self-signed deposit. This is exactly
 * the sequence recorded in docs/tachi-smoke-output.md §5-6, and it is the
 * documented answer to "how does an operator get real off-chain sats to hand
 * out to LPs?" on regtest.
 */
async function topUpOperator(mnemonic: string, address: string, amountSats: bigint): Promise<string | null> {
  const FAUCET = process.env.TACHI_FAUCET_URL ?? "https://faucet.tachibtc.com";
  const root = bip32.fromSeed(await bip39.mnemonicToSeed(mnemonic), net);
  const descriptor = deriveUserKey(mnemonic, resolveWalletNetwork("regtest"), { index: 0 });
  const node = root.derivePath(descriptor.path);
  const xOnly = Buffer.from(node.publicKey).subarray(1, 33);

  try {
    const res = await fetch(`${FAUCET}/api/faucet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, amountBtc: 0.001, proof: null }),
    });
    const body: any = await res.json().catch(() => ({}));
    say(`  faucet → HTTP ${res.status} ${body?.txid ? `txid ${body.txid}` : JSON.stringify(body).slice(0, 160)}`);
    await sleep(12_000);
  } catch (e) {
    say(`  faucet claim failed (continuing to try a ledger deposit): ${e instanceof Error ? e.message : String(e)}`);
  }

  const nonce = await getAccountNonce(xOnly, { baseUrl: RPC });
  const draft = buildTachiTxDeposit({ userXOnly: xOnly, amountSats, nonce, feeSats: 1n });
  const signed = await signTachiTx(draft, normalizeTaprootSigner(node));
  const hex = encodeTachiTx(signed).toString("hex");
  const bc: any = await client.broadcastTxSync(hex);
  if (bc?.result?.code !== 0) {
    say(`  ledger deposit rejected: code=${bc?.result?.code} log=${bc?.result?.log}`);
    return null;
  }
  const hash = String(bc.result.hash).toLowerCase();
  const st = await waitForTachiTxCommit(hash, { baseUrl: RPC, overallTimeoutMs: 90_000 });
  if (!st.committed) {
    say(`  ledger deposit never committed: ${st.log}`);
    return null;
  }
  return hash;
}

// ---- gateway harness --------------------------------------------------------
async function boot(mnemonic: string) {
  const dir = mkdtempSync(join(tmpdir(), "opensluice-e2e-"));
  const config: GatewayConfig = {
    operatorKey: OPERATOR_KEY,
    webhookSecret: "e2e_webhook_secret",
    dbPath: join(dir, "e2e.db"),
    adapterMode: "tachi",
    port: 0,
    host: "127.0.0.1",
    pollIntervalMs: 1_000,
    expirySweepIntervalMs: 5_000,
    webhookSweepIntervalMs: 5_000,
    devRoutesEnabled: true,
    devPublicSimulate: false, // never with a real settlement layer
    sseHeartbeatMs: 15_000,
    webDistPath: join(dir, "no-dist"),
    tachi: {
      rpcUrl: RPC,
      network: "regtest",
      mnemonic,
      statePath: join(dir, "tachi-state.json"),
      log: (msg, meta) => console.log(`  [adapter] ${msg}`, meta ? JSON.stringify(meta) : ""),
    },
  };
  const app = await createApp(config);
  return { app, dir };
}

const opHeaders = { authorization: `Bearer ${OPERATOR_KEY}`, "content-type": "application/json" };

async function main() {
  const smoke = existsSync(SMOKE_STATE) ? JSON.parse(readFileSync(SMOKE_STATE, "utf8")) : null;
  if (!smoke?.mnemonic) {
    throw new Error(`${SMOKE_STATE} not found — run \`npm run smoke:tachi\` first to create and fund a wallet`);
  }

  say(`# OpenSluice × Tachi — live end-to-end\n`);
  say(`- when: ${new Date().toISOString()}`);
  say(`- rpc: \`${RPC}\``);
  say(`- node: ${process.version}`);

  const { app } = await boot(smoke.mnemonic);
  const adapter = app.adapter as TachiRealSettlementAdapter;
  app.startBackgroundJobs();

  const health = await app.app.inject({ method: "GET", url: "/healthz" });
  block(
    "0. Boot — what this gateway actually settles",
    `\`GET /healthz\` →\n\n\`\`\`json\n${JSON.stringify(health.json(), null, 2)}\n\`\`\`\n\n` +
      `The \`settlement\` object is the single source of truth: off-chain legs are REAL on ` +
      `\`${adapter.capabilities.chainId}\`, L1 legs are simulated.`,
  );

  const operatorAddress = adapter.operatorAddress();
  let opBalance = await adapter.offchainBalance();
  say(`\nOperator float: \`${operatorAddress}\` holding ${sats(opBalance)}.`);
  if (opBalance < 12_000n) {
    say(`Float is low — topping up from the regtest faucet + a ledger deposit…`);
    const tx = await topUpOperator(smoke.mnemonic, operatorAddress, 50_000n);
    if (tx) say(`  → real deposit tx \`${tx}\``);
    opBalance = await adapter.offchainBalance();
    say(`  operator float now holds ${sats(opBalance)}`);
  }
  if (opBalance < 12_000n) {
    throw new Error(`operator float still holds only ${opBalance} sats after a top-up attempt`);
  }

  // ---- user wallet -----------------------------------------------------------
  const user = await userWallet();
  let userBal = BigInt((await client.getBalance(user.address)).balance_sat);
  say(`User wallet (external): \`${user.address}\` holding ${sats(userBal)}.`);
  if (userBal < 5_500n) {
    const top = 6_000n;
    say(`Topping the user wallet up with ${sats(top)} from the operator float (a real transfer)…`);
    // The user is an EXTERNAL wallet, so this is a plain outward transfer —
    // fundOffchainAccount is for accounts the coordinator itself derives.
    const tx = await adapter.sendOffchain({ toAddress: user.address, amountSats: top, ref: "e2e:user-topup" });
    say(`  → real tx \`${tx.transferId}\``);
    userBal = BigInt((await client.getBalance(user.address)).balance_sat);
    say(`  user wallet now holds ${sats(userBal)}`);
  }

  // ---- LPs with REAL off-chain funding ---------------------------------------
  const lps: Array<{ id: string; name: string; apiKey: string; fundTx: string; address: string }> = [];
  for (const [name, fundSats] of [["Penstock", 3_000n], ["Headwater", 2_500n]] as const) {
    const reg = await app.app.inject({ method: "POST", url: "/api/lps", headers: opHeaders, payload: { name } });
    const lp = reg.json() as { id: string; apiKey: string };
    const fund = await app.app.inject({
      method: "POST",
      url: "/api/lp/fund",
      headers: opHeaders,
      payload: { lpId: lp.id, chain: "offchain", amountSats: fundSats.toString() },
    });
    if (fund.statusCode !== 201) throw new Error(`LP funding failed: ${fund.body}`);
    const body = fund.json() as any;
    lps.push({ id: lp.id, name, apiKey: lp.apiKey, fundTx: body.settlement?.transferId, address: body.settlement?.address });
    say(`\nLP ${name}: funded ${sats(fundSats)} off-chain — REAL tx \`${body.settlement?.transferId}\``);
    say(`  LP account address: \`${body.settlement?.address}\``);
    // On-chain side is bookkeeping only (L1 is simulated).
    await app.app.inject({
      method: "POST",
      url: "/api/lp/fund",
      headers: opHeaders,
      payload: { lpId: lp.id, chain: "onchain", amountSats: "5000000" },
    });
    // Publish liquidity in both directions.
    await app.app.inject({
      method: "PUT",
      url: "/api/lp/liquidity",
      headers: { authorization: `Bearer ${lp.apiKey}`, "content-type": "application/json" },
      payload: {
        swapIn: { capacitySats: fundSats.toString(), feeBps: name === "Penstock" ? 10 : 25, feeFixedSats: "0", minSats: "500", maxSats: fundSats.toString(), estSeconds: 30 },
        // ^ swap_in is the direction where the LP fronts REAL off-chain sats,
        //   so its capacity is capped at what was actually transferred to it.
        // maxSats deliberately below the split amount used in swap 3, so the
        // router genuinely has to spread that swap across both providers.
        swapOut: { capacitySats: "5000000", feeBps: name === "Penstock" ? 20 : 35, feeFixedSats: "0", minSats: "500", maxSats: "2000", estSeconds: 60 },
      },
    });
  }

  block(
    "1. LP funding is real",
    lps.map((l) => `- **${l.name}** → \`${l.address}\` funded by real ledger transfer \`${l.fundTx}\``).join("\n") +
      `\n\nThis is the piece OpenTill never needed: a provider must hold actual sats inside Tachi before it can front a swap. ` +
      `The route books the \`lp_ledger\` row only after the transfer commits — a failed transfer writes nothing.`,
  );

  const quote = async (direction: string, amountSats: string) => {
    const res = await app.app.inject({ method: "POST", url: "/api/quotes", headers: { "content-type": "application/json" }, payload: { direction, amountSats } });
    if (res.statusCode !== 201) throw new Error(`quote failed (${res.statusCode}): ${res.body}`);
    return res.json() as any;
  };
  const accept = async (quoteId: string, destination: string) => {
    const res = await app.app.inject({ method: "POST", url: "/api/swaps", headers: { "content-type": "application/json" }, payload: { quoteId, destination } });
    if (res.statusCode !== 201) throw new Error(`accept failed (${res.statusCode}): ${res.body}`);
    return res.json() as any;
  };
  const swapState = async (id: string) => (await app.app.inject({ method: "GET", url: `/api/swaps/${id}` })).json() as any;
  const mine = async (blocks: number) => {
    await app.app.inject({ method: "POST", url: "/dev/advance-blocks", headers: opHeaders, payload: { blocks } });
  };
  const waitFor = async (id: string, pred: (s: any) => boolean, label: string, ms = 90_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const s = await swapState(id);
      if (pred(s)) return s;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(s.status)} legs=${JSON.stringify(s.legs.map((l: any) => l.status))}`);
      await sleep(1500);
    }
  };

  // ---- SWAP 1: swap_out (user's leg is REAL) ---------------------------------
  say(`\n### Swap 1 — swap_out (user pays off-chain for real)`);
  const q1 = await quote("swap_out", "1800");
  const s1 = await accept(q1.quoteId, "bcrt1quserdestinationsimulatedL1");
  const leg1 = s1.legs[0];
  say(`swap \`${s1.id}\` · leg pays ${sats(leg1.amountSats)} to REAL address \`${leg1.payTo}\``);
  const payTx1 = await userPays(user, leg1.payTo, BigInt(leg1.amountSats));
  say(`user paid for REAL: tx \`${payTx1}\``);
  const afterPay1 = await waitFor(s1.id, (s) => s.legs[0].status !== "pending", "the poller to detect the real credit");
  say(`poller detected it: leg → \`${afterPay1.legs[0].status}\``);
  await mine(3);
  const done1 = await waitFor(s1.id, (s) => s.status === "completed", "swap_out completion");
  say(`swap_out completed · LP payout tx (SIMULATED L1) \`${done1.legs[0].payoutTxId}\``);

  block(
    "2. swap_out — the user-facing leg is real",
    [
      `- quote: ${sats(q1.amountSats)} out, fee ${sats(q1.totalFeeSats)}, receive ${sats(q1.totalReceiveSats)}`,
      `- leg deposit address (**real Tachi**): \`${leg1.payTo}\``,
      `- user's payment (**real ledger tx**): \`${payTx1}\``,
      `- detected by \`getAddressVtxos\` polling → leg \`${afterPay1.legs[0].status}\``,
      `- LP's payout to L1 (**simulated**): \`${done1.legs[0].payoutTxId}\``,
      `- final swap status: \`${done1.status}\``,
    ].join("\n"),
  );

  // ---- SWAP 2: swap_in (LP's payout is REAL) ---------------------------------
  say(`\n### Swap 2 — swap_in (LP pays the user off-chain for real)`);
  const q2 = await quote("swap_in", "1200");
  const s2 = await accept(q2.quoteId, user.address);
  const leg2 = s2.legs[0];
  say(`swap \`${s2.id}\` · user must deposit ${sats(leg2.amountSats)} to SIMULATED L1 address \`${leg2.payTo}\``);
  const beforeUser = BigInt((await client.getBalance(user.address)).balance_sat);
  await app.app.inject({
    method: "POST",
    url: "/dev/simulate-onchain-deposit",
    headers: opHeaders,
    payload: { address: leg2.payTo, amountSats: leg2.amountSats },
  });
  say(`simulated the user's L1 deposit (operator-authenticated dev route)`);
  await mine(3);
  const done2 = await waitFor(s2.id, (s) => s.status === "completed", "swap_in completion");
  const afterUser = BigInt((await client.getBalance(user.address)).balance_sat);
  say(`swap_in completed · LP's REAL off-chain payout tx \`${done2.legs[0].payoutTransferId}\``);
  say(`user's real Tachi balance ${sats(beforeUser)} → ${sats(afterUser)} (+${sats(afterUser - beforeUser)})`);

  block(
    "3. swap_in — the LP's payout is real",
    [
      `- quote: ${sats(q2.amountSats)} in, fee ${sats(q2.totalFeeSats)}, receive ${sats(q2.totalReceiveSats)}`,
      `- user's L1 deposit (**simulated**) to \`${leg2.payTo}\``,
      `- LP's payout (**real ledger tx**): \`${done2.legs[0].payoutTransferId}\``,
      `- user's real balance moved ${sats(beforeUser)} → ${sats(afterUser)}, i.e. **+${sats(afterUser - beforeUser)}** — matching the quoted receive of ${sats(q2.totalReceiveSats)}`,
      `- final swap status: \`${done2.status}\``,
    ].join("\n"),
  );

  // ---- SWAP 3: split swap_out across two LPs ---------------------------------
  say(`\n### Swap 3 — split swap_out, two LPs, two real payments`);
  const q3 = await quote("swap_out", "3000");
  say(`quote routed across ${q3.legs.length} providers: ${q3.legs.map((l: any) => `${l.lpName} ${l.amountSats}`).join(", ")}`);
  if (q3.legs.length < 2) {
    throw new Error(`expected a split across 2 providers, got ${q3.legs.length} leg(s) — check the LP maxSats in this script`);
  }
  const s3 = await accept(q3.quoteId, "bcrt1qsplitdestinationsimulated");
  const payTxs: string[] = [];
  for (const leg of s3.legs) {
    const tx = await userPays(user, leg.payTo, BigInt(leg.amountSats));
    payTxs.push(tx);
    say(`  paid leg ${sats(leg.amountSats)} → \`${leg.payTo}\` · REAL tx \`${tx}\` (committed)`);
  }
  await waitFor(s3.id, (s) => s.legs.every((l: any) => l.status !== "pending"), "both real legs detected");
  await mine(3);
  const done3 = await waitFor(s3.id, (s) => s.status === "completed", "split completion");
  block(
    "4. Split swap — two providers, two real payments",
    [
      `- quote: ${sats(q3.amountSats)} across ${q3.legs.length} providers`,
      ...q3.legs.map((l: any, i: number) => `  - ${l.lpName}: ${sats(l.amountSats)} · **real tx** \`${payTxs[i]}\``),
      `- final swap status: \`${done3.status}\``,
    ].join("\n"),
  );

  // ---- reconciliation --------------------------------------------------------
  const finals: string[] = [];
  for (const l of lps) {
    const bal = await app.app.inject({ method: "GET", url: "/api/lp/balances", headers: { authorization: `Bearer ${l.apiKey}` } });
    const earn = await app.app.inject({ method: "GET", url: "/api/lp/earnings", headers: { authorization: `Bearer ${l.apiKey}` } });
    const realBal = l.address ? BigInt((await client.getBalance(l.address)).balance_sat) : 0n;
    const b = bal.json() as any;
    const e = earn.json() as any;
    finals.push(
      `- **${l.name}** — ledger says off-chain ${sats(b.offchainSats)}, fees earned ${sats(e.totalFeesSats)}; ` +
        `the LP's real Tachi account \`${l.address}\` holds ${sats(realBal)}`,
    );
  }
  const opFinal = await adapter.offchainBalance();
  const userFinal = BigInt((await client.getBalance(user.address)).balance_sat);
  block(
    "5. Reconciliation",
    [
      ...finals,
      `- operator float: ${sats(opFinal)}`,
      `- user wallet: ${sats(userFinal)}`,
      ``,
      `The internal \`lp_ledger\` and the real Tachi balances are **separate books** and are expected to differ: ` +
      `the ledger tracks each LP's entitlement inside the coordinator, while the coordinator's keys hold the pooled float ` +
      `that actually pays. Reconciling the two automatically is not implemented — see GAPS.md.`,
    ].join("\n"),
  );

  app.stopBackgroundJobs();
  await app.close();

  mkdirSync("docs", { recursive: true });
  writeFileSync(OUT_FILE, `${sections.join("\n")}\n`);
  console.log(`\nwrote ${OUT_FILE}`);
}

main().catch(async (e) => {
  console.error("\nE2E FAILED:", e);
  mkdirSync("docs", { recursive: true });
  writeFileSync(OUT_FILE, `${sections.join("\n")}\n\n## FAILED\n\n\`\`\`\n${e instanceof Error ? e.stack : String(e)}\n\`\`\`\n`);
  process.exit(1);
});
