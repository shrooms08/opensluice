/** U+2009 THIN SPACE — receipt-style digit grouping: `50 000`. */
const THIN_SPACE = " ";
const SATS_PER_BTC = 100_000_000n;

/** `"50000"` -> `"50 000"`. Input is a decimal string of sats. */
export function formatSats(sats: string): string {
  return sats.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

/** `"50000"` -> `"0.00050000"` — always 8 decimals (v2 type rule: BTC 8-decimal). */
export function formatBtc(sats: string): string {
  const abs = BigInt(sats);
  const whole = abs / SATS_PER_BTC;
  const frac = (abs % SATS_PER_BTC).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

/** `sw_9f3k2m7xq0a2c7` -> `sw_9f3k…a2c7` for receipt rows; short ids pass through. */
export function truncateId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** Long addresses -> `mockbtc1qm75…b191` (middle-truncated for headers). */
export function truncateAddress(address: string): string {
  return address.length > 24 ? `${address.slice(0, 12)}…${address.slice(-4)}` : address;
}

/** Milliseconds remaining -> `mm:ss`, clamped at 00:00. Overflows hours into minutes. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Honest human estimate from est_seconds: `~45 s`, `~2 min`, `~1 h 10 min`. */
export function formatEstimate(seconds: number): string {
  if (seconds < 120) return `~${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `~${hours} h ${rest} min` : `~${hours} h`;
}

/** Fee as effective bps of the amount: `"170 sats · 0.17%"`'s right half. */
export function formatFeePct(feeSats: string, amountSats: string): string {
  const amount = BigInt(amountSats);
  if (amount === 0n) return "0%";
  // Two decimals of percent = fee * 10000 / amount basis points.
  const hundredths = (BigInt(feeSats) * 10_000n) / amount;
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

/**
 * QR/URI payload for a leg instruction. On-chain gets a BIP21-ish URI (the
 * real Tachi scheme lands with the real adapter); off-chain addresses are
 * encoded bare.
 */
export function buildPaymentUri(payChain: "onchain" | "offchain", address: string, amountSats: string): string {
  if (payChain === "offchain") return address;
  const params = new URLSearchParams({ amount: trimBtc(formatBtc(amountSats)) });
  return `bitcoin:${address}?${params.toString()}`;
}

function trimBtc(btc: string): string {
  return btc.replace(/0+$/, "").replace(/\.$/, "");
}
