import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InsufficientFundsError,
  MockSettlementAdapter,
  TachiBroadcastError,
  TachiRealSettlementAdapter,
  vtxoIdFor,
  type TachiRealAdapterDeps,
} from "@opensluice/adapter";

/**
 * Unit tests for the real adapter against an injected fake daemon speaking the
 * exact response shapes recorded in docs/tachi-smoke-output.md. No network.
 * (Live coverage: `npm run smoke:tachi` / `npm run e2e:tachi`.)
 */

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TX_HASH = "b2ed933f95dbab3c315b3060920cc50f129a3d71046939cbfe7d14c7c3ce14ba";

interface FakeVtxo {
  id: string;
  owner: string;
  amount: number;
  spent: boolean;
  height: number;
  script: string;
  locked: boolean;
}

function makeFake(opts: { chainId?: string; height?: number } = {}) {
  const state = {
    height: opts.height ?? 487_530,
    chainId: opts.chainId ?? "tachi-regtest-1",
    vtxos: new Map<string, FakeVtxo[]>(),
    balances: new Map<string, number>(),
    broadcasts: [] as string[],
    broadcastResult: { code: 0, log: "", hash: TX_HASH.toUpperCase() },
  };
  const client = {
    getHealth: async () => ({ status: "ok", validators: 1 }),
    getStatus: async () => ({
      jsonrpc: "2.0",
      id: -1,
      result: {
        node_info: { network: state.chainId },
        sync_info: { latest_block_height: String(state.height), catching_up: false },
      },
    }),
    getAddressVtxos: async (address: string, includeSpent = false) => {
      const all = state.vtxos.get(address) ?? [];
      const vtxos = includeSpent ? all : all.filter((v) => !v.spent);
      return { pubkey: "", count: vtxos.length, vtxos };
    },
    getMempoolByAddress: async () => ({ pubkey: "", count: 0, transactions: [] }),
    getBalance: async (address: string) => ({ pubkey: "", balance_sat: state.balances.get(address) ?? 0 }),
    getFeeEstimate: async () => ({ min_fee_sat: 1, avg_fee_sat: 0, recommended_fee_sat: 1 }),
    broadcastTxSync: async (hex: string) => {
      state.broadcasts.push(hex);
      return { jsonrpc: "2.0", id: -1, result: { ...state.broadcastResult, data: "", codespace: "" } };
    },
    bitcoinRPC: async () => ({ jsonrpc: "2.0", id: "t", error: null, result: {} }),
  };
  return { state, client: client as unknown as NonNullable<TachiRealAdapterDeps["client"]> };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opensluice-tachi-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function adapter(
  fake: ReturnType<typeof makeFake>,
  extra: Partial<TachiRealAdapterDeps> = {},
  statePath = join(dir, "state.json"),
) {
  return new TachiRealSettlementAdapter(
    { rpcUrl: "https://rpc-regtest.tachibtc.com", network: "regtest", mnemonic: MNEMONIC, statePath },
    {
      client: fake.client,
      nonce: async () => 0n,
      waitCommit: async () => ({ committed: true, code: 0, log: "" }),
      now: () => 1_700_000_000_000,
      l1: new MockSettlementAdapter({ mockBlockTimeMs: 10 ** 9 }),
      ...extra,
    },
  );
}

/** Give an address a spendable VTXO owned by the right key. */
async function fund(fake: ReturnType<typeof makeFake>, a: TachiRealSettlementAdapter, address: string, amount: number, height = 487_000) {
  const key = a.keys().find((k) => k.address === address)!;
  fake.state.vtxos.set(address, [
    { id: "a".repeat(64), owner: key.xOnlyHex, amount, spent: false, height, script: "", locked: false },
  ]);
  fake.state.balances.set(address, amount);
}

describe("TachiRealSettlementAdapter — boot", () => {
  it("refuses a daemon on the wrong chain", async () => {
    const fake = makeFake({ chainId: "tachi-signet-1" });
    await expect(adapter(fake).init()).rejects.toThrow(/network=regtest.*tachi-signet-1/);
  });

  it("connects and seeds the operator float key", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    const keys = a.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.ref).toBe("operator");
    expect(keys[0]!.change).toBe(false);
    expect(a.operatorAddress()).toMatch(/^bcrt1p/);
  });

  it("requires a mnemonic and an rpc url", () => {
    expect(() => new TachiRealSettlementAdapter({ rpcUrl: "x", network: "regtest", mnemonic: "", statePath: "s" })).toThrow(/mnemonic is required/);
    expect(() => new TachiRealSettlementAdapter({ rpcUrl: "", network: "regtest", mnemonic: MNEMONIC, statePath: "s" })).toThrow(/rpcUrl is required/);
  });

  it("reports honest capabilities: off-chain real, L1 simulated", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    expect(a.capabilities).toMatchObject({ onchainReal: false, offchainReal: true });
    await a.init();
    expect(a.capabilities.chainId).toBe("tachi-regtest-1");
    expect(a.capabilities.label).toBe("tachi-regtest-1");
  });
});

describe("TachiRealSettlementAdapter — off-chain addresses", () => {
  it("derives one key per ref and returns the SAME address when a ref repeats", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    const first = await a.createOffchainAddress("leg:abc");
    const again = await a.createOffchainAddress("leg:abc");
    const other = await a.createOffchainAddress("leg:def");
    expect(again.address).toBe(first.address); // a retried accept must not orphan a payment
    expect(other.address).not.toBe(first.address);
  });

  it("survives a restart via the state file", async () => {
    const fake = makeFake();
    const statePath = join(dir, "shared.json");
    const a = adapter(fake, {}, statePath);
    await a.init();
    const addr = (await a.createOffchainAddress("leg:persist")).address;

    const b = adapter(fake, {}, statePath);
    await b.init();
    expect((await b.createOffchainAddress("leg:persist")).address).toBe(addr);
  });

  it("refuses to watch an off-chain address it does not own", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    await expect(a.watchAddress("offchain", "bcrt1pnotours")).rejects.toThrow(/not one of our off-chain keys/);
  });
});

describe("TachiRealSettlementAdapter — pollOffchain", () => {
  it("reports committed VTXOs above the cursor, with a watermark that cannot skip a mid-tick block", async () => {
    const fake = makeFake({ height: 500 });
    const a = adapter(fake);
    await a.init();
    const { address } = await a.createOffchainAddress("leg:1");
    await a.watchAddress("offchain", address);
    const key = a.keys().find((k) => k.address === address)!;
    fake.state.vtxos.set(address, [
      { id: "b".repeat(64), owner: key.xOnlyHex, amount: 12_345, spent: false, height: 450, script: "", locked: false },
      { id: "c".repeat(64), owner: key.xOnlyHex, amount: 999, spent: false, height: 300, script: "", locked: false },
    ]);

    const out = await a.pollOffchain("400");
    expect(out.events).toHaveLength(1); // height 300 is at/below the cursor
    expect(out.events[0]).toMatchObject({
      transferId: "b".repeat(64),
      toAddress: address,
      amountSats: 12_345n,
      status: "committed",
    });
    // watermark = height at START of tick minus one, so 500 is re-scanned
    expect(out.nextCursor).toBe("499");
  });

  it("never reports a pending credit as committed", async () => {
    const fake = makeFake({ height: 500 });
    const a = adapter(fake);
    await a.init();
    const { address } = await a.createOffchainAddress("leg:pending");
    await a.watchAddress("offchain", address);
    // Nothing committed yet — the mempool is deliberately not consulted.
    const out = await a.pollOffchain(null);
    expect(out.events).toHaveLength(0);
  });

  it("ignores unwatched keys and VTXOs owned by someone else", async () => {
    const fake = makeFake({ height: 500 });
    const a = adapter(fake);
    await a.init();
    const watched = (await a.createOffchainAddress("leg:watched")).address;
    const unwatched = (await a.createOffchainAddress("leg:unwatched")).address;
    await a.watchAddress("offchain", watched);
    const wrongOwner = "f".repeat(64);
    fake.state.vtxos.set(watched, [
      { id: "d".repeat(64), owner: wrongOwner, amount: 1, spent: false, height: 490, script: "", locked: false },
    ]);
    fake.state.vtxos.set(unwatched, [
      { id: "e".repeat(64), owner: a.keys().find((k) => k.address === unwatched)!.xOnlyHex, amount: 5, spent: false, height: 490, script: "", locked: false },
    ]);
    const out = await a.pollOffchain(null);
    expect(out.events).toHaveLength(0);
  });

  it("emits a stable eventId derived from the VTXO id, so replays are idempotent", async () => {
    const fake = makeFake({ height: 500 });
    const a = adapter(fake);
    await a.init();
    const { address } = await a.createOffchainAddress("leg:stable");
    await a.watchAddress("offchain", address);
    const key = a.keys().find((k) => k.address === address)!;
    fake.state.vtxos.set(address, [
      { id: "9".repeat(64), owner: key.xOnlyHex, amount: 7, spent: false, height: 490, script: "", locked: false },
    ]);
    const first = await a.pollOffchain(null);
    const second = await a.pollOffchain(null);
    expect(first.events[0]!.eventId).toBe(second.events[0]!.eventId);
    expect(first.events[0]!.eventId).toContain("9".repeat(64));
  });
});

describe("TachiRealSettlementAdapter — sendOffchain", () => {
  it("broadcasts a balanced transfer and returns the hash only after code 0 + commit", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    await fund(fake, a, a.operatorAddress(), 50_000);
    const dest = (await a.createOffchainAddress("leg:dest")).address;

    const out = await a.sendOffchain({ toAddress: dest, amountSats: 12_345n, ref: "leg:x" });
    expect(out.transferId).toBe(TX_HASH);
    expect(fake.state.broadcasts).toHaveLength(1);
    expect(fake.state.broadcasts[0]).toMatch(/^[0-9a-f]+$/); // hex, no 0x prefix
  });

  it("treats a resolved broadcast with code != 0 as failure (the SDK's #1 trap)", async () => {
    const fake = makeFake();
    fake.state.broadcastResult = { code: 8, log: "insufficient fee", hash: "" };
    const a = adapter(fake);
    await a.init();
    await fund(fake, a, a.operatorAddress(), 50_000);
    const dest = (await a.createOffchainAddress("leg:dest")).address;

    await expect(a.sendOffchain({ toAddress: dest, amountSats: 100n, ref: "r" })).rejects.toThrow(TachiBroadcastError);
  });

  it("fails when the mempool accepted but the block never committed", async () => {
    const fake = makeFake();
    const a = adapter(fake, { waitCommit: async () => ({ committed: false, code: 0, log: "timeout" }) });
    await a.init();
    await fund(fake, a, a.operatorAddress(), 50_000);
    const dest = (await a.createOffchainAddress("leg:dest")).address;

    await expect(a.sendOffchain({ toAddress: dest, amountSats: 100n, ref: "r" })).rejects.toThrow(/not committed|timeout/);
  });

  it("needs one key to cover amount + fee — no cross-key spends", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    const dest = (await a.createOffchainAddress("leg:dest")).address;
    const spare = (await a.createOffchainAddress("leg:spare")).address;
    // 60 + 60 = 120 total, but one TachiTx has one signer.
    await fund(fake, a, a.operatorAddress(), 60);
    await fund(fake, a, spare, 60);

    await expect(a.sendOffchain({ toAddress: dest, amountSats: 100n, ref: "r" })).rejects.toThrow(InsufficientFundsError);
  });

  it("rejects a non-taproot destination", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    await fund(fake, a, a.operatorAddress(), 50_000);
    await expect(a.sendOffchain({ toAddress: "not-an-address", amountSats: 1n, ref: "r" })).rejects.toThrow();
  });

  it("rejects a non-positive amount before touching the daemon", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    await expect(a.sendOffchain({ toAddress: a.operatorAddress(), amountSats: 0n, ref: "r" })).rejects.toThrow(RangeError);
    expect(fake.state.broadcasts).toHaveLength(0);
  });
});

describe("TachiRealSettlementAdapter — LP funding", () => {
  it("funds an LP account with a real transfer and returns its address + tx id", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    await fund(fake, a, a.operatorAddress(), 50_000);

    const out = await a.fundOffchainAccount({ ref: "lp:lp_123", amountSats: 20_000n });
    expect(out.address).toMatch(/^bcrt1p/);
    expect(out.transferId).toBe(TX_HASH);
    // The LP's account is a real derived key the adapter now owns.
    expect(a.keys().some((k) => k.ref === "lp:lp_123" && k.address === out.address)).toBe(true);
  });

  it("propagates a rejected funding transfer instead of reporting success", async () => {
    const fake = makeFake();
    fake.state.broadcastResult = { code: 5, log: "bad nonce", hash: "" };
    const a = adapter(fake);
    await a.init();
    await fund(fake, a, a.operatorAddress(), 50_000);
    await expect(a.fundOffchainAccount({ ref: "lp:x", amountSats: 10n })).rejects.toThrow(TachiBroadcastError);
  });
});

describe("TachiRealSettlementAdapter — the simulated L1 boundary", () => {
  it("still serves on-chain legs, but never claims they are real", async () => {
    const fake = makeFake();
    const logs: string[] = [];
    const a = new TachiRealSettlementAdapter(
      { rpcUrl: "https://rpc-regtest.tachibtc.com", network: "regtest", mnemonic: MNEMONIC, statePath: join(dir, "l1.json"), log: (m) => logs.push(m) },
      { client: fake.client, nonce: async () => 0n, waitCommit: async () => ({ committed: true, code: 0, log: "" }), l1: new MockSettlementAdapter({ mockBlockTimeMs: 10 ** 9 }) },
    );
    await a.init();

    const dep = await a.createOnchainDepositAddress("leg:l1");
    expect(dep.address).toMatch(/^mockbtc1q/); // unmistakably not a real address
    const sent = await a.sendOnchain({ toAddress: dep.address, amountSats: 1_000n, ref: "leg:l1" });
    expect(sent.txId).toBeTruthy();

    expect(logs.some((l) => /SIMULATED L1 deposit address/.test(l))).toBe(true);
    expect(logs.some((l) => /SIMULATED L1 payout — no Bitcoin moved/.test(l))).toBe(true);
    expect(logs.some((l) => /OFF-CHAIN LEGS ARE REAL, L1 LEGS ARE SIMULATED/.test(l))).toBe(true);
  });
});

describe("vtxoIdFor", () => {
  it("matches the daemon's id for a transfer output (asserted live in the smoke run)", () => {
    // From docs/tachi-smoke-output.md, HOP 2: tx b2ed93… vout 0 → 46fc3975…
    expect(vtxoIdFor(TX_HASH, 0)).toBe("46fc39759b44a6ab55dc33217566df6d3c55933ee1ab5ac2b4448a59c5762397");
  });
});
