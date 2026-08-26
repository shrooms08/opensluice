/**
 * Demo seed: 3 LPs with distinct fees/capacities on both directions, funded
 * on both chains. Reusable every gate:
 *
 *   OPENSLUICE_OPERATOR_KEY=op_dev_key npm run seed:demo
 *
 * Talks to a RUNNING gateway (default http://localhost:8080, override with
 * OPENSLUICE_GATEWAY_URL). Each run registers a fresh set of LPs — pointing
 * it at a fresh database gives the canonical demo book.
 */

const BASE = process.env.OPENSLUICE_GATEWAY_URL ?? "http://localhost:8080";
const OPERATOR_KEY = process.env.OPENSLUICE_OPERATOR_KEY;

if (!OPERATOR_KEY) {
  console.error("OPENSLUICE_OPERATOR_KEY is required (the gateway's operator key)");
  process.exit(1);
}

interface SeedLp {
  name: string;
  fundOnchain: string;
  fundOffchain: string;
  swapIn: { capacitySats: string; feeBps: number; feeFixedSats: string; minSats: string; maxSats: string; estSeconds: number };
  swapOut: { capacitySats: string; feeBps: number; feeFixedSats: string; minSats: string; maxSats: string; estSeconds: number };
}

/**
 * Two profiles.
 *
 * `mock` (default) uses comfortable round numbers, because nothing there is
 * real. `regtest` is for ADAPTER_MODE=tachi, where every off-chain sat handed
 * to an LP is a REAL ledger transfer out of the coordinator's float: the
 * amounts are small, the swap_in capacity is capped at exactly what was
 * actually transferred (an LP cannot front what it does not hold), and
 * swap_out maxSats is deliberately low so a modest swap still demonstrates
 * routing across several providers.
 *
 *   OPENSLUICE_SEED_PROFILE=regtest npm run seed:demo
 */
const MOCK_LPS: SeedLp[] = [
  {
    name: "Penstock",
    fundOnchain: "2000000",
    fundOffchain: "60000",
    swapIn: { capacitySats: "60000", feeBps: 10, feeFixedSats: "0", minSats: "1000", maxSats: "60000", estSeconds: 60 },
    swapOut: { capacitySats: "2000000", feeBps: 20, feeFixedSats: "0", minSats: "5000", maxSats: "1500000", estSeconds: 120 },
  },
  {
    name: "Headwater",
    fundOnchain: "1200000",
    fundOffchain: "80000",
    swapIn: { capacitySats: "80000", feeBps: 25, feeFixedSats: "10", minSats: "1000", maxSats: "80000", estSeconds: 90 },
    swapOut: { capacitySats: "1200000", feeBps: 35, feeFixedSats: "50", minSats: "2000", maxSats: "1200000", estSeconds: 90 },
  },
  {
    name: "Weir Labs",
    fundOnchain: "500000",
    fundOffchain: "300000",
    swapIn: { capacitySats: "300000", feeBps: 60, feeFixedSats: "100", minSats: "10000", maxSats: "250000", estSeconds: 45 },
    swapOut: { capacitySats: "500000", feeBps: 80, feeFixedSats: "0", minSats: "10000", maxSats: "500000", estSeconds: 45 },
  },
];

/** Real off-chain sats. On-chain figures stay large — L1 legs are simulated. */
const REGTEST_LPS: SeedLp[] = [
  {
    name: "Penstock",
    fundOnchain: "2000000",
    fundOffchain: "12000",
    swapIn: { capacitySats: "12000", feeBps: 10, feeFixedSats: "0", minSats: "500", maxSats: "12000", estSeconds: 30 },
    swapOut: { capacitySats: "2000000", feeBps: 20, feeFixedSats: "0", minSats: "500", maxSats: "5000", estSeconds: 60 },
  },
  {
    name: "Headwater",
    fundOnchain: "1200000",
    fundOffchain: "10000",
    swapIn: { capacitySats: "10000", feeBps: 25, feeFixedSats: "10", minSats: "500", maxSats: "10000", estSeconds: 45 },
    swapOut: { capacitySats: "1200000", feeBps: 35, feeFixedSats: "0", minSats: "500", maxSats: "5000", estSeconds: 45 },
  },
  {
    name: "Weir Labs",
    fundOnchain: "500000",
    fundOffchain: "8000",
    swapIn: { capacitySats: "8000", feeBps: 60, feeFixedSats: "0", minSats: "500", maxSats: "8000", estSeconds: 30 },
    swapOut: { capacitySats: "500000", feeBps: 80, feeFixedSats: "0", minSats: "500", maxSats: "5000", estSeconds: 30 },
  },
];

const PROFILE = process.env.OPENSLUICE_SEED_PROFILE === "regtest" ? "regtest" : "mock";
const LPS: SeedLp[] = PROFILE === "regtest" ? REGTEST_LPS : MOCK_LPS;

async function call(
  method: string,
  path: string,
  body: unknown,
  key: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main(): Promise<void> {
  console.log(`Seeding demo LPs against ${BASE} (profile: ${PROFILE})`);
  if (PROFILE === "regtest") {
    console.log("  off-chain amounts are REAL ledger transfers from the operator float");
  }
  for (const lp of LPS) {
    const registered = await call("POST", "/api/lps", { name: lp.name }, OPERATOR_KEY!);
    const id = registered.id as string;
    const apiKey = registered.apiKey as string;

    await call("POST", "/api/lp/fund", { lpId: id, chain: "onchain", amountSats: lp.fundOnchain }, OPERATOR_KEY!);
    const funded = await call("POST", "/api/lp/fund", { lpId: id, chain: "offchain", amountSats: lp.fundOffchain }, OPERATOR_KEY!);
    const settlement = funded.settlement as { real?: boolean; transferId?: string; address?: string } | undefined;
    await call("PUT", "/api/lp/liquidity", { swapIn: lp.swapIn, swapOut: lp.swapOut }, apiKey);

    console.log(`  ${lp.name}: ${id}`);
    if (settlement?.real) {
      console.log(`    off-chain ${lp.fundOffchain} sats → ${settlement.address}`);
      console.log(`    REAL transfer: ${settlement.transferId}`);
    }
    console.log(`    LP API key (shown once): ${apiKey}`);
  }

  const market = await fetch(`${BASE}/api/marketplace`).then((r) => r.json());
  console.log("\nMarketplace now:");
  console.log(JSON.stringify(market, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
