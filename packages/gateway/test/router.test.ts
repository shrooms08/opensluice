import { describe, expect, it } from "vitest";
import { routeQuote, type RouterLp } from "../src/domain/router";

/** Book entry with generous defaults; override what the case cares about. */
function lp(partial: Partial<RouterLp> & { lpId: string }): RouterLp {
  return {
    lpName: partial.lpId.toUpperCase(),
    availableSats: 1_000_000n,
    feeBps: 10,
    feeFixedSats: 0n,
    minSats: 1n,
    maxSats: 1_000_000_000n,
    estSeconds: 60,
    ...partial,
  };
}

describe("router — single-LP routes", () => {
  it("routes the whole amount through the cheapest LP", () => {
    const res = routeQuote(
      [lp({ lpId: "a", feeBps: 50 }), lp({ lpId: "b", feeBps: 10 }), lp({ lpId: "c", feeBps: 30 })],
      100_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0]).toMatchObject({ lpId: "b", amountSats: 100_000n, feeSats: 100n });
    expect(res.totalFeeSats).toBe(100n);
  });

  it("total fee = bps floor + fixed", () => {
    const res = routeQuote([lp({ lpId: "a", feeBps: 25, feeFixedSats: 7n })], 10_001n);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // floor(10001 * 25 / 10000) = 25, + 7 fixed
    expect(res.totalFeeSats).toBe(32n);
  });

  it("prefers a pricier single LP over any split (fewest legs first)", () => {
    // b+c combined would be cheaper, but a covers alone.
    const res = routeQuote(
      [
        lp({ lpId: "a", feeBps: 100, availableSats: 200_000n }),
        lp({ lpId: "b", feeBps: 1, availableSats: 60_000n }),
        lp({ lpId: "c", feeBps: 1, availableSats: 60_000n }),
      ],
      100_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0]!.lpId).toBe("a");
  });

  it("tie-breaks equal fees on est_seconds", () => {
    const res = routeQuote(
      [lp({ lpId: "slow", feeBps: 10, estSeconds: 600 }), lp({ lpId: "fast", feeBps: 10, estSeconds: 30 })],
      50_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legs[0]!.lpId).toBe("fast");
  });

  it("tie-breaks equal fee and speed on larger available capacity", () => {
    const res = routeQuote(
      [
        lp({ lpId: "small", feeBps: 10, availableSats: 200_000n }),
        lp({ lpId: "big", feeBps: 10, availableSats: 900_000n }),
      ],
      50_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legs[0]!.lpId).toBe("big");
  });

  it("is deterministic on full ties (lpId order)", () => {
    const book = [lp({ lpId: "zeta" }), lp({ lpId: "alpha" })];
    const a = routeQuote(book, 10_000n);
    const b = routeQuote([...book].reverse(), 10_000n);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.legs[0]!.lpId).toBe("alpha");
    expect(b.legs[0]!.lpId).toBe("alpha");
  });

  it("respects per-LP min: an amount below minSats is not routed to that LP", () => {
    const res = routeQuote(
      [lp({ lpId: "picky", minSats: 50_000n }), lp({ lpId: "easy", feeBps: 99 })],
      10_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legs[0]!.lpId).toBe("easy");
  });

  it("respects per-LP max: an amount above maxSats falls through to a split", () => {
    const res = routeQuote(
      [lp({ lpId: "capped", maxSats: 40_000n, feeBps: 1 }), lp({ lpId: "open", feeBps: 5 })],
      100_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // "open" can cover alone -> single beats split despite capped's better rate.
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0]!.lpId).toBe("open");
  });
});

describe("router — split routes", () => {
  it("splits across 2 LPs when no single LP covers, cheapest first", () => {
    const res = routeQuote(
      [
        lp({ lpId: "a", feeBps: 10, availableSats: 60_000n }),
        lp({ lpId: "b", feeBps: 20, availableSats: 60_000n }),
      ],
      100_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legs).toHaveLength(2);
    expect(res.legs[0]).toMatchObject({ lpId: "a", amountSats: 60_000n });
    expect(res.legs[1]).toMatchObject({ lpId: "b", amountSats: 40_000n });
    // fees: floor(60000*10/10000)=60, floor(40000*20/10000)=80
    expect(res.totalFeeSats).toBe(140n);
  });

  it("splits across 3 LPs, honors max 3 legs, est is max of legs", () => {
    const res = routeQuote(
      [
        lp({ lpId: "a", availableSats: 50_000n, estSeconds: 30 }),
        lp({ lpId: "b", availableSats: 50_000n, estSeconds: 300 }),
        lp({ lpId: "c", availableSats: 50_000n, estSeconds: 60 }),
      ],
      150_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legs).toHaveLength(3);
    expect(res.estSeconds).toBe(300);
    expect(res.legs.reduce((s, l) => s + l.amountSats, 0n)).toBe(150_000n);
  });

  it("fails when only a 4-way split would cover (max 3 legs)", () => {
    const res = routeQuote(
      [
        lp({ lpId: "a", availableSats: 30_000n }),
        lp({ lpId: "b", availableSats: 30_000n }),
        lp({ lpId: "c", availableSats: 30_000n }),
        lp({ lpId: "d", availableSats: 30_000n }),
      ],
      100_000n,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.maxRoutableSats).toBe(90_000n);
  });

  it("caps each leg at the LP's maxSats even with capacity to spare", () => {
    const res = routeQuote(
      [
        lp({ lpId: "a", feeBps: 1, maxSats: 70_000n, availableSats: 500_000n }),
        lp({ lpId: "b", feeBps: 50 }),
      ],
      100_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // b could cover alone -> single wins; force the split by shrinking b.
    const forced = routeQuote(
      [
        lp({ lpId: "a", feeBps: 1, maxSats: 70_000n, availableSats: 500_000n }),
        lp({ lpId: "b", feeBps: 50, availableSats: 80_000n, maxSats: 80_000n }),
      ],
      100_000n,
    );
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.legs[0]).toMatchObject({ lpId: "a", amountSats: 70_000n });
    expect(forced.legs[1]).toMatchObject({ lpId: "b", amountSats: 30_000n });
  });

  it("rebalances the previous leg so a leftover clears the next LP's minimum", () => {
    // Greedy would leave 20k for b, below b's 50k min. The router pulls 30k
    // back from a's leg so b gets exactly its minimum.
    const res = routeQuote(
      [
        lp({ lpId: "a", feeBps: 1, availableSats: 100_000n }),
        lp({ lpId: "b", feeBps: 10, availableSats: 100_000n, minSats: 50_000n }),
      ],
      120_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legs[0]).toMatchObject({ lpId: "a", amountSats: 70_000n });
    expect(res.legs[1]).toMatchObject({ lpId: "b", amountSats: 50_000n });
  });

  it("skips an LP whose minimum cannot be met at all", () => {
    const res = routeQuote(
      [
        lp({ lpId: "a", feeBps: 1, availableSats: 100_000n, minSats: 90_000n }),
        lp({ lpId: "b", feeBps: 10, availableSats: 100_000n }),
        lp({ lpId: "c", feeBps: 20, availableSats: 100_000n }),
      ],
      150_000n,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // a takes 100k first (cheapest); leftover 50k < a-min irrelevant, b covers it.
    expect(res.legs.map((l) => l.lpId)).toEqual(["a", "b"]);
  });

  it("same book, same amount -> identical route (determinism)", () => {
    const book = [
      lp({ lpId: "a", feeBps: 10, availableSats: 60_000n }),
      lp({ lpId: "b", feeBps: 10, availableSats: 60_000n }),
      lp({ lpId: "c", feeBps: 20, availableSats: 60_000n }),
    ];
    const runs = Array.from({ length: 5 }, () => routeQuote(book, 150_000n));
    for (const r of runs) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.legs.map((l) => `${l.lpId}:${l.amountSats}`)).toEqual(
        // a and b tie on fees; lpId breaks the tie deterministically.
        ["a:60000", "b:60000", "c:30000"],
      );
    }
  });
});

describe("router — exclusions and insufficiency", () => {
  it("empty book -> insufficient with zero routable", () => {
    const res = routeQuote([], 1_000n);
    expect(res).toEqual({ ok: false, maxRoutableSats: 0n });
  });

  it("zero-available LPs contribute nothing", () => {
    const res = routeQuote([lp({ lpId: "a", availableSats: 0n })], 1_000n);
    expect(res).toEqual({ ok: false, maxRoutableSats: 0n });
  });

  it("reports the max currently routable amount on insufficiency", () => {
    const res = routeQuote(
      [
        lp({ lpId: "a", availableSats: 40_000n }),
        lp({ lpId: "b", availableSats: 25_000n }),
        lp({ lpId: "c", availableSats: 10_000n }),
        lp({ lpId: "d", availableSats: 5_000n }),
      ],
      1_000_000n,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // top-3 chunks: 40k + 25k + 10k
    expect(res.maxRoutableSats).toBe(75_000n);
  });

  it("maxRoutable respects per-LP maxSats", () => {
    const res = routeQuote(
      [lp({ lpId: "a", availableSats: 500_000n, maxSats: 100_000n })],
      1_000_000n,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.maxRoutableSats).toBe(100_000n);
  });

  it("excludes an LP whose fee would eat the whole amount", () => {
    const res = routeQuote(
      [lp({ lpId: "greedy", feeFixedSats: 2_000n, availableSats: 100_000n })],
      1_000n,
    );
    expect(res.ok).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    expect(routeQuote([lp({ lpId: "a" })], 0n).ok).toBe(false);
  });
});
