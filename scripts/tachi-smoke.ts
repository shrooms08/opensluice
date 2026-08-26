/**
 * Live smoke against the Tachi regtest daemon — Step 1 of the real-settlement
 * gate. Nothing here is adapter code: it prints every real response verbatim
 * and writes docs/tachi-smoke-output.md, the ground truth the real adapter is
 * written against.
 *
 * OpenSluice needs one thing OpenTill never exercised: a coordinator must be
 * able to move real off-chain value to a liquidity provider's account, and the
 * provider must then be able to pay a user. So this script proves a two-hop
 * chain — operator → LP → user — not just a single transfer.
 *
 *   npm run smoke:tachi       (needs network; regtest coins only)
 *
 * Key material (a BIP-39 mnemonic) comes from TACHI_SMOKE_MNEMONIC or is
 * generated once and persisted to .tachi-smoke-state.json (gitignored) so the
 * funded keys can be reused by the e2e run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory, type BIP32Interface } from "bip32";
import * as bip39 from "bip39";
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import {
  buildTachiTxDeposit,
  computeVtxoId,
  deriveUserKey,
  encodeTachiTx,
  getAccountNonce,
  normalizeTaprootSigner,
  resolveWalletNetwork,
  signTachiTx,
  waitForTachiTxCommit,
  xOnlyFromAddress,
  TACHI_TX_TYPE_TRANSFER,
  TACHI_TX_VERSION,
  type TachiTx,
} from "@tachibtc/taurus-vault-core";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const RPC = process.env.TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
const FAUCET = process.env.TACHI_FAUCET_URL ?? "https://faucet.tachibtc.com";
const STATE_FILE = ".tachi-smoke-state.json";
const OUT_FILE = "docs/tachi-smoke-output.md";
const WATCH_MS = 30_000;

const client = new TachiClient({ baseUrl: RPC });
const net = bitcoin.networks.regtest;

// ---- recording -------------------------------------------------------------
const sections: string[] = [];
const j = (x: unknown) =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : Buffer.isBuffer(v) ? v.toString("hex") : v), 2);
function record(title: string, body: string) {
  console.log(`\n## ${title}\n${body}`);
  sections.push(`## ${title}\n\n${body}`);
}
function rec(title: string, value: unknown, note?: string) {
  record(title, `${note ? note + "\n\n" : ""}\`\`\`json\n${j(value)}\n\`\`\``);
}
function recErr(title: string, err: unknown) {
  record(title, `**ERROR** (verbatim):\n\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``);
}

// ---- keys ------------------------------------------------------------------
interface KeySet {
  index: number;
  role: string;
  path: string;
  xOnly: Buffer;
  address: string;
  node: BIP32Interface;
}
function keyAt(root: BIP32Interface, mnemonic: string, index: number, role: string): KeySet {
  const descriptor = deriveUserKey(mnemonic, resolveWalletNetwork("regtest"), { index });
  const node = root.derivePath(descriptor.path);
  const xOnly = Buffer.from(node.publicKey).subarray(1, 33);
  const address = bitcoin.payments.p2tr({ pubkey: xOnly, network: net }).address!;
  if (!xOnlyFromAddress(address, net).equals(xOnly)) throw new Error("address/x-only round-trip mismatch");
  return { index, role, path: descriptor.path, xOnly, address, node };
}

// ---- watch (WebSocket async iterator) ---------------------------------------
function startWatch(label: string, address: string, ms: number) {
  const ac = new AbortController();
  const events: unknown[] = [];
  const done = (async () => {
    try {
      for await (const ev of client.watch({ address }, { signal: ac.signal })) {
        events.push(ev);
        console.log(`[watch:${label}]`, JSON.stringify(ev));
      }
    } catch (e) {
      if (!ac.signal.aborted) events.push({ watchError: e instanceof Error ? e.message : String(e) });
    }
  })();
  const timer = setTimeout(() => ac.abort(), ms);
  return { events, stop: async () => { clearTimeout(timer); ac.abort(); await done; } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build + sign + encode a plain key→key ledger TRANSFER (no vault, empty PSBT). */
async function transferHex(args: {
  from: KeySet;
  inputs: Array<{ id: string; amount: number }>;
  outputs: Array<{ owner: Buffer; amount: bigint }>;
  fee: bigint;
  nonce: bigint;
}): Promise<string> {
  const tx: TachiTx = {
    version: TACHI_TX_VERSION,
    type: TACHI_TX_TYPE_TRANSFER,
    inputs: args.inputs.map((i) => ({
      vtxoId: Buffer.from(i.id, "hex"),
      txid: Buffer.alloc(32, 0),
      vout: 0,
      valueSats: BigInt(i.amount),
      sigScript: Buffer.alloc(0),
    })),
    outputs: args.outputs.map((o) => ({ owner: o.owner, amount: o.amount, script: Buffer.alloc(0) })),
    fee: args.fee,
    nonce: args.nonce,
    pubKey: args.from.xOnly,
    signature: Buffer.alloc(0),
    psbtPayload: Buffer.alloc(0),
    vaultPayload: Buffer.alloc(0),
  };
  const signed = await signTachiTx(tx, normalizeTaprootSigner(args.from.node));
  return encodeTachiTx(signed).toString("hex");
}

/** Broadcast, enforce "a resolved promise is not success", wait for commit. */
async function broadcastAndCommit(label: string, hex: string): Promise<string | null> {
  const bc = await client.broadcastTxSync(hex);
  rec(`${label} broadcastTxSync — RAW (HTTP 200 is not success; read result.code/log)`, bc);
  const code = (bc as any)?.result?.code;
  if (code !== 0) {
    record(`${label} verdict`, `Daemon REJECTED: code=${code} log=\`${(bc as any)?.result?.log}\`.`);
    return null;
  }
  const hash = (bc as any).result.hash as string;
  const st = await waitForTachiTxCommit(hash, { baseUrl: RPC, timeoutMs: 60_000 } as any);
  rec(`${label} waitForTachiTxCommit(hash)`, st);
  return hash;
}

// ---- main ------------------------------------------------------------------
async function main() {
  const startedAt = new Date().toISOString();
  record(
    "Run",
    `- when: ${startedAt}\n- rpc: \`${RPC}\`\n- faucet: \`${FAUCET}\`\n- sdk: @tachibtc/tachi-sdk-ts 0.2.1, @tachibtc/taurus-vault-core 0.3.3\n- node: ${process.version}`,
  );

  // 1. connectivity
  rec("1. getHealth()", await client.getHealth());
  const status = await client.getStatus();
  rec("1. getStatus()", status);
  const height = Number((status as any)?.result?.sync_info?.latest_block_height);
  record(
    "1. connectivity summary",
    `network=\`${(status as any)?.result?.node_info?.network}\` height=${height} catching_up=${(status as any)?.result?.sync_info?.catching_up}`,
  );

  // 2. keys — the three roles OpenSluice needs
  let mnemonic = process.env.TACHI_SMOKE_MNEMONIC;
  const persisted: any = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null;
  if (!mnemonic && persisted?.mnemonic) mnemonic = persisted.mnemonic;
  const generated = !mnemonic;
  if (!mnemonic) mnemonic = bip39.generateMnemonic(128);
  const root = bip32.fromSeed(await bip39.mnemonicToSeed(mnemonic), net);
  const operator = keyAt(root, mnemonic, 0, "operator float");
  const lp = keyAt(root, mnemonic, 1, "LP account");
  const user = keyAt(root, mnemonic, 2, "user destination");
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        mnemonic,
        rpc: RPC,
        keys: [operator, lp, user].map((k) => ({ index: k.index, role: k.role, path: k.path, xOnly: k.xOnly.toString("hex"), address: k.address })),
        faucetTxid: persisted?.faucetTxid ?? null,
      },
      null,
      2,
    ),
  );
  record(
    "2. key management — three roles",
    [
      `Mnemonic ${generated ? "GENERATED" : "reused"} (persisted to \`${STATE_FILE}\`, gitignored).`,
      "",
      "Per-key: `deriveUserKey(mnemonic, resolveWalletNetwork(\"regtest\"), { index })` (BIP-84 path `m/84'/1'/0'/0/<index>`) gives the public descriptor; the private key is derived with bip32 along `descriptor.path`; the ledger owner is the 32-byte x-only key; the address is that key as a bech32m P2TR output key, which `xOnlyFromAddress` decodes back — round-trip asserted.",
      "",
      "OpenSluice's three roles: the **operator float** holds the coordinator's real off-chain balance, an **LP account** receives a provider's allocation, and the **user destination** is where a swap actually pays out.",
      "",
      "```json",
      j({
        operator: { path: operator.path, xOnly: operator.xOnly, address: operator.address },
        lp: { path: lp.path, xOnly: lp.xOnly, address: lp.address },
        user: { path: user.path, xOnly: user.xOnly, address: user.address },
      }),
      "```",
    ].join("\n"),
  );

  // 3. empty shapes (what the poller sees before anything arrives)
  try { rec("3. getAddressVtxos(user) — empty", await client.getAddressVtxos(user.address)); } catch (e) { recErr("3. getAddressVtxos", e); }
  try { rec("3. getBalance(user) — empty", await client.getBalance(user.address)); } catch (e) { recErr("3. getBalance", e); }

  // 4. watch on the user address for the whole run
  const wUser = startWatch("user", user.address, WATCH_MS + 120_000);
  await sleep(1500);
  record("4. watch({ address })", `Opened \`client.watch({ address: "${user.address}" })\` (WebSocket async iterator). Events for the whole run are in section 9.`);

  // 5. faucet → operator (L1)
  let faucetTxid: string | null = persisted?.faucetTxid ?? null;
  try {
    const cap = await (await fetch(`${FAUCET}/api/capacity?address=${encodeURIComponent(operator.address)}`)).json();
    rec("5. faucet GET /api/capacity", cap);
    if (faucetTxid) {
      record("5. faucet", `Reusing faucet txid from state: \`${faucetTxid}\` (no new claim).`);
    } else {
      const res = await fetch(`${FAUCET}/api/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: operator.address, amountBtc: 0.001, proof: null }),
      });
      const body = await res.json().catch(async () => ({ nonJson: await res.text() }));
      rec(`5. faucet POST /api/faucet → HTTP ${res.status}`, body, "Request body: `{ address, amountBtc: 0.001, proof: null }`.");
      faucetTxid = (body as any)?.txid ?? null;
      const st = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      writeFileSync(STATE_FILE, JSON.stringify({ ...st, faucetTxid }, null, 2));
    }
  } catch (e) { recErr("5. faucet", e); }

  await sleep(12_000);
  try {
    const r = await client.bitcoinRPC({ method: "scantxoutset", params: ["start", [`addr(${operator.address})`]] });
    rec("5. bitcoinRPC scantxoutset addr(operator) — L1 UTXOs", r, "Note `error` is checked, not just the resolved promise.");
  } catch (e) { recErr("5. scantxoutset", e); }
  try { rec("5. getAddressVtxos(operator) — after faucet (ledger view)", await client.getAddressVtxos(operator.address, true)); } catch (e) { recErr("5. getAddressVtxos after faucet", e); }

  // 6. ledger deposit: give the operator float real ledger value
  let opVtxo: { id: string; amount: number } | null = null;
  try {
    const existing = await client.getAddressVtxos(operator.address, false);
    const spendable = existing.vtxos.filter((v) => !v.spent && !v.locked);
    if (spendable.length > 0) {
      opVtxo = { id: spendable[0]!.id, amount: spendable[0]!.amount };
      record("6. ledger deposit", `Operator already holds a spendable VTXO (\`${opVtxo.id}\`, ${opVtxo.amount} sats) — skipping a fresh deposit.`);
    } else {
      const nonce = await getAccountNonce(operator.xOnly, { baseUrl: RPC });
      const feeEst = await client.getFeeEstimate();
      rec("6. getFeeEstimate()", feeEst, "Ledger deposits need fee ≥ 1 sat (fee 0 → code 8).");
      const depositFee = BigInt(Math.max(1, feeEst.min_fee_sat));
      const draft = buildTachiTxDeposit({ userXOnly: operator.xOnly, amountSats: 50_000n, nonce, feeSats: depositFee });
      const signed = await signTachiTx(draft, normalizeTaprootSigner(operator.node));
      const hex = encodeTachiTx(signed).toString("hex");
      rec("6. buildTachiTxDeposit → signTachiTx → encodeTachiTx", { nonce, amountSats: "50000n", feeSats: depositFee, hexBytes: hex.length / 2 });
      const hash = await broadcastAndCommit("6. deposit", hex);
      if (hash) {
        const after = await client.getAddressVtxos(operator.address, true);
        rec("6. getAddressVtxos(operator, includeSpent) — after deposit", after);
        const v = after.vtxos.find((x) => !x.spent && !x.locked);
        if (v) opVtxo = { id: v.id, amount: v.amount };
        record("6. vtxoId check", `\`computeVtxoId(txHash, 0)\` = \`${computeVtxoId(hash.toLowerCase(), 0).toString("hex")}\` — daemon reports \`${v?.id}\` → **${computeVtxoId(hash.toLowerCase(), 0).toString("hex") === v?.id ? "MATCH" : "MISMATCH"}**`);
      }
    }
  } catch (e) { recErr("6. ledger deposit", e); }

  // 7. HOP 1 — operator → LP. This is OpenSluice's LP funding path.
  let lpVtxo: { id: string; amount: number } | null = null;
  if (opVtxo) {
    try {
      const fee = 1n;
      const fund = 20_000n;
      const change = BigInt(opVtxo.amount) - fund - fee;
      if (change < 0n) throw new Error(`operator VTXO ${opVtxo.amount} cannot cover ${fund} + fee`);
      const nonce = await getAccountNonce(operator.xOnly, { baseUrl: RPC });
      const hex = await transferHex({
        from: operator,
        inputs: [opVtxo],
        outputs: [{ owner: lp.xOnly, amount: fund }, ...(change > 0n ? [{ owner: operator.xOnly, amount: change }] : [])],
        fee,
        nonce,
      });
      rec("7. HOP 1 operator → LP (LP funding) — built", { input: opVtxo, toLp: `${fund}n`, change: `${change}n`, fee: "1n", nonce, hexBytes: hex.length / 2 });
      const hash = await broadcastAndCommit("7. HOP 1", hex);
      if (hash) {
        const lpv = await client.getAddressVtxos(lp.address, true);
        rec("7. HOP 1 — LP account after funding", { vtxos: lpv, balance: await client.getBalance(lp.address) });
        const v = lpv.vtxos.find((x) => !x.spent && !x.locked);
        if (v) lpVtxo = { id: v.id, amount: v.amount };
        record("7. HOP 1 vtxoId check", `\`computeVtxoId(${hash.toLowerCase()}, 0)\` = \`${computeVtxoId(hash.toLowerCase(), 0).toString("hex")}\` vs daemon \`${v?.id}\` → **${computeVtxoId(hash.toLowerCase(), 0).toString("hex") === v?.id ? "MATCH" : "MISMATCH"}**`);
      }
    } catch (e) { recErr("7. HOP 1 operator → LP", e); }
  } else {
    record("7. HOP 1 operator → LP", "Skipped — the operator float holds no spendable ledger VTXO (see 6).");
  }

  // 8. HOP 2 — LP → user. This is a swap payout leg, paid by the provider.
  if (lpVtxo) {
    try {
      const fee = 1n;
      const payout = 12_345n;
      const change = BigInt(lpVtxo.amount) - payout - fee;
      const nonce = await getAccountNonce(lp.xOnly, { baseUrl: RPC });
      const hex = await transferHex({
        from: lp,
        inputs: [lpVtxo],
        outputs: [{ owner: user.xOnly, amount: payout }, ...(change > 0n ? [{ owner: lp.xOnly, amount: change }] : [])],
        fee,
        nonce,
      });
      rec("8. HOP 2 LP → user (swap payout leg) — built", { input: lpVtxo, toUser: `${payout}n`, change: `${change}n`, fee: "1n", nonce, hexBytes: hex.length / 2 });
      // Detection BEFORE commit: what does the poller see while it is pending?
      const preMempool = await client.getMempoolByAddress(user.address).catch((e) => ({ error: String(e) }));
      const hash = await broadcastAndCommit("8. HOP 2", hex);
      rec("8. HOP 2 — getMempoolByAddress(user) sampled just before broadcast", preMempool);
      if (hash) {
        const expectedId = computeVtxoId(hash.toLowerCase(), 0).toString("hex");
        const uv = await client.getAddressVtxos(user.address, true);
        rec("8. HOP 2 — user address after payout (THE DETECTION PATH)", {
          vtxos: uv,
          balance: await client.getBalance(user.address),
          expectedVtxoId: expectedId,
          idMatches: uv.vtxos.some((v) => v.id === expectedId),
        });
        rec("8. HOP 2 — getTransaction(hash)", await client.getTransaction(hash).catch((e) => ({ error: String(e) })));
        rec("8. HOP 2 — LP account after paying out", { vtxos: await client.getAddressVtxos(lp.address, true), balance: await client.getBalance(lp.address) });
      }
    } catch (e) { recErr("8. HOP 2 LP → user", e); }
  } else {
    record("8. HOP 2 LP → user", "Skipped — the LP account holds no spendable ledger VTXO (see 7).");
  }

  // 9. reconciliation + watch events
  try {
    rec("9. final balances (operator / LP / user)", {
      operator: await client.getBalance(operator.address),
      lp: await client.getBalance(lp.address),
      user: await client.getBalance(user.address),
    });
  } catch (e) { recErr("9. final balances", e); }

  await sleep(4000);
  await wUser.stop();
  rec("9. watch events — user address — verbatim", wUser.events);

  mkdirSync("docs", { recursive: true });
  writeFileSync(
    OUT_FILE,
    `# Tachi regtest smoke — real response record\n\nGenerated by \`npm run smoke:tachi\` (scripts/tachi-smoke.ts). Every block is the daemon's verbatim response. This file is the ground truth \`TachiRealSettlementAdapter\` is written against.\n\n${sections.join("\n\n")}\n`,
  );
  console.log(`\nwrote ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  recErr("FATAL", e);
  mkdirSync("docs", { recursive: true });
  writeFileSync(OUT_FILE, `# Tachi regtest smoke — FAILED\n\n${sections.join("\n\n")}\n`);
  process.exit(1);
});
