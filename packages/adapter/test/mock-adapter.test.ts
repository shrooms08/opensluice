import { describe, expect, it } from "vitest";
import { MOCK_CONFIRMATIONS, MockSettlementAdapter, TachiSettlementAdapter, createAdapter } from "../src";

/** Block time / commit latency far in the future: tests drive time explicitly. */
async function makeMock(offchainCommitMs = 0): Promise<MockSettlementAdapter> {
  const mock = new MockSettlementAdapter({
    mockBlockTimeMs: 10 ** 9,
    mockOffchainCommitMs: offchainCommitMs,
  });
  await mock.init();
  return mock;
}

describe("mock settlement adapter — on-chain leg", () => {
  it("mints unique addresses per call", async () => {
    const mock = await makeMock();
    const a = await mock.createOnchainDepositAddress("ref1");
    const b = await mock.createOnchainDepositAddress("ref1");
    expect(a.address).not.toEqual(b.address);
    expect(a.address.startsWith("mockbtc1q")).toBe(true);
  });

  it("reports a simulated deposit as seen, then confirmed after 3 blocks", async () => {
    const mock = await makeMock();
    const { address } = await mock.createOnchainDepositAddress("dep");
    await mock.watchAddress("onchain", address);

    const { txId } = mock.simulateOnchainDeposit(address, 50_000n);

    const first = await mock.pollOnchain(null);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ txId, toAddress: address, status: "seen" });
    expect(first.events[0]!.amountSats).toBe(50_000n);

    // Not confirmed yet: no new events past the cursor.
    const second = await mock.pollOnchain(first.nextCursor);
    expect(second.events).toHaveLength(0);

    mock.advanceBlocks(MOCK_CONFIRMATIONS);
    const third = await mock.pollOnchain(second.nextCursor);
    expect(third.events).toHaveLength(1);
    expect(third.events[0]).toMatchObject({ txId, status: "confirmed" });
    expect(third.events[0]!.confirmations).toBeGreaterThanOrEqual(MOCK_CONFIRMATIONS);
    expect(mock.addressBalance("onchain", address)).toBe(50_000n);
  });

  it("does not report events for unwatched addresses but still advances the cursor", async () => {
    const mock = await makeMock();
    const { address } = await mock.createOnchainDepositAddress("unwatched");
    mock.simulateOnchainDeposit(address, 1_000n);

    const res = await mock.pollOnchain(null);
    expect(res.events).toHaveLength(0);
    expect(res.nextCursor).not.toBe("0");
  });

  it("sendOnchain produces a tx that confirms like a deposit", async () => {
    const mock = await makeMock();
    await mock.watchAddress("onchain", "userdest1");
    const { txId } = await mock.sendOnchain({ toAddress: "userdest1", amountSats: 7_000n, ref: "leg" });

    const first = await mock.pollOnchain(null);
    expect(first.events[0]).toMatchObject({ txId, status: "seen" });

    mock.advanceBlocks(MOCK_CONFIRMATIONS);
    const second = await mock.pollOnchain(first.nextCursor);
    expect(second.events[0]).toMatchObject({ txId, status: "confirmed" });
  });

  it("replaying an old cursor returns the same events (idempotent reads)", async () => {
    const mock = await makeMock();
    const { address } = await mock.createOnchainDepositAddress("replay");
    await mock.watchAddress("onchain", address);
    mock.simulateOnchainDeposit(address, 123n);

    const a = await mock.pollOnchain(null);
    const b = await mock.pollOnchain(null);
    expect(b.events.map((e) => e.eventId)).toEqual(a.events.map((e) => e.eventId));
  });
});

describe("mock settlement adapter — off-chain leg", () => {
  it("commits a simulated payment on the next poll when latency is zero", async () => {
    const mock = await makeMock(0);
    const { address } = await mock.createOffchainAddress("off");
    await mock.watchAddress("offchain", address);

    const { transferId } = mock.simulateOffchainPayment(address, 9_000n);
    const res = await mock.pollOffchain(null);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ transferId, toAddress: address, status: "committed" });
    expect(mock.addressBalance("offchain", address)).toBe(9_000n);
  });

  it("holds the committed event back until the latency elapses", async () => {
    const mock = await makeMock(60_000);
    const { address } = await mock.createOffchainAddress("slow");
    await mock.watchAddress("offchain", address);
    mock.simulateOffchainPayment(address, 1n);

    const res = await mock.pollOffchain(null);
    expect(res.events).toHaveLength(0);
  });

  it("sendOffchain resolves with a transferId", async () => {
    const mock = await makeMock(0);
    const { transferId } = await mock.sendOffchain({
      toAddress: "anywhere",
      amountSats: 5n,
      ref: "x",
    });
    expect(transferId.startsWith("mockxfer_")).toBe(true);
  });

  it("rejects non-positive sends on both chains", async () => {
    const mock = await makeMock(0);
    await expect(mock.sendOffchain({ toAddress: "a", amountSats: 0n, ref: "r" })).rejects.toThrow();
    await expect(mock.sendOnchain({ toAddress: "a", amountSats: -1n, ref: "r" })).rejects.toThrow();
  });
});

describe("adapter factory + tachi scaffold", () => {
  it("factory builds the mock", async () => {
    const adapter = createAdapter({ mode: "mock" });
    expect(adapter).toBeInstanceOf(MockSettlementAdapter);
  });

  it("tachi mode constructs but refuses to init, pointing at INTEGRATION.md", async () => {
    const adapter = createAdapter({ mode: "tachi" });
    expect(adapter).toBeInstanceOf(TachiSettlementAdapter);
    await expect(adapter.init()).rejects.toThrow(/INTEGRATION\.md/);
  });

  it("mock refuses use before init", async () => {
    const mock = new MockSettlementAdapter();
    await expect(mock.createOnchainDepositAddress("x")).rejects.toThrow(/init/);
  });
});
