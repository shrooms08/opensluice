import { BPS_DENOMINATOR, SATS_PER_BTC } from "./constants";

/** Parse a decimal string of satoshis into a non-negative bigint. Throws on anything else. */
export function parseSats(input: string): bigint {
  if (!/^\d+$/.test(input)) {
    throw new RangeError(`invalid sats value: ${JSON.stringify(input)}`);
  }
  return BigInt(input);
}

/** Format sats as a BTC decimal string with 8 places, trailing zeros trimmed. */
export function satsToBtc(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = (abs % SATS_PER_BTC).toString().padStart(8, "0").replace(/0+$/, "");
  const body = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/**
 * Fee an LP charges on a chunk: bps applied (floor) plus the fixed component.
 * Lives here because the router, the quoting service and the tests must all
 * agree on the rounding to the sat.
 */
export function feeForAmount(amountSats: bigint, feeBps: number, feeFixedSats: bigint): bigint {
  return (amountSats * BigInt(feeBps)) / BPS_DENOMINATOR + feeFixedSats;
}
