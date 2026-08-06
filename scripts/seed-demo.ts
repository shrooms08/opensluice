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

/** Distinct enough that routing decisions are visible in the UI. */
const LPS: SeedLp[] = [
  {
    name: "Fjord Liquidity",
    fundOnchain: "2000000",
    fundOffchain: "60000",
    swapIn: { capacitySats: "60000", feeBps: 10, feeFixedSats: "0", minSats: "1000", maxSats: "60000", estSeconds: 60 },
    swapOut: { capacitySats: "2000000", feeBps: 20, feeFixedSats: "0", minSats: "5000", maxSats: "1500000", estSeconds: 120 },
  },
  {
    name: "Meridian Bridge",
    fundOnchain: "1200000",
    fundOffchain: "80000",
    swapIn: { capacitySats: "80000", feeBps: 25, feeFixedSats: "10", minSats: "1000", maxSats: "80000", estSeconds: 90 },
    swapOut: { capacitySats: "1200000", feeBps: 35, feeFixedSats: "50", minSats: "2000", maxSats: "1200000", estSeconds: 90 },
  },
  {
    name: "Tidepool",
    fundOnchain: "500000",
    fundOffchain: "300000",
    swapIn: { capacitySats: "300000", feeBps: 60, feeFixedSats: "100", minSats: "10000", maxSats: "250000", estSeconds: 45 },
    swapOut: { capacitySats: "500000", feeBps: 80, feeFixedSats: "0", minSats: "10000", maxSats: "500000", estSeconds: 45 },
  },
];

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
  console.log(`Seeding demo LPs against ${BASE}`);
  for (const lp of LPS) {
    const registered = await call("POST", "/api/lps", { name: lp.name }, OPERATOR_KEY!);
    const id = registered.id as string;
    const apiKey = registered.apiKey as string;

    await call("POST", "/api/lp/fund", { lpId: id, chain: "onchain", amountSats: lp.fundOnchain }, OPERATOR_KEY!);
    await call("POST", "/api/lp/fund", { lpId: id, chain: "offchain", amountSats: lp.fundOffchain }, OPERATOR_KEY!);
    await call("PUT", "/api/lp/liquidity", { swapIn: lp.swapIn, swapOut: lp.swapOut }, apiKey);

    console.log(`  ${lp.name}: ${id}`);
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
