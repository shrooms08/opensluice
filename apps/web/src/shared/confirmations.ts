/**
 * How many on-chain confirmations a deposit needs before its leg settles.
 *
 * ONE constant, deliberately: the quote panel promises "seconds after N
 * confirmations" and the progress chips count "(n/N)" toward the same N. Those
 * two numbers are the same promise made twice — a user who is told 3 and then
 * watches a bar count to 2 has been lied to. Importing both from here makes
 * them incapable of diverging; `confirmation-copy.test.tsx` asserts it.
 *
 * Mirrors MOCK_CONFIRMATIONS in packages/adapter/src/types.ts, which is what
 * the mock settlement adapter actually waits for. A real adapter with a
 * different confirmation policy changes this value and both surfaces follow.
 */
export const CONFIRMATION_TARGET = 3;

/** "seconds after 3 confirmations" — the quote panel's arrival promise. */
export function arrivalCopy(direction: "swap_in" | "swap_out"): string {
  return direction === "swap_in"
    ? `seconds after ${CONFIRMATION_TARGET} confirmations`
    : `on-chain after ${CONFIRMATION_TARGET} confirmations`;
}

/** "CONFIRMING (2/3)" — the progress chip's live count toward the same target. */
export function confirmingLabel(confirmations: number): string {
  const n = Math.min(confirmations, CONFIRMATION_TARGET);
  return `CONFIRMING (${n}/${CONFIRMATION_TARGET})`;
}
