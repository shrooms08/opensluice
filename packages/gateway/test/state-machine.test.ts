import { describe, expect, it } from "vitest";
import { LEG_STATUSES, SWAP_STATUSES, type LegStatus, type SwapStatus } from "@opensluice/shared";
import {
  InvalidTransitionError,
  SWAP_IN_LEG_TRANSITIONS,
  SWAP_OUT_LEG_TRANSITIONS,
  SWAP_TRANSITIONS,
  assertLegTransition,
  assertSwapTransition,
  canTransitionLeg,
  canTransitionSwap,
  isSwapTerminal,
} from "../src/domain/state-machine";

const LEGAL_SWAP: ReadonlyArray<[SwapStatus, SwapStatus]> = [
  ["pending", "funding"],
  ["pending", "settling"],
  ["pending", "expired"],
  ["funding", "settling"],
  ["funding", "partially_funded"],
  ["funding", "failed"],
  ["settling", "completed"],
  ["settling", "failed"],
];

describe("swap state machine", () => {
  it("allows exactly the documented transitions and rejects every other pair", () => {
    for (const from of SWAP_STATUSES) {
      for (const to of SWAP_STATUSES) {
        const legal = LEGAL_SWAP.some(([f, t]) => f === from && t === to);
        expect(canTransitionSwap(from, to), `${from} -> ${to}`).toBe(legal);
        if (legal) {
          expect(() => assertSwapTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertSwapTransition(from, to)).toThrow(InvalidTransitionError);
        }
      }
    }
  });

  it("has exactly four terminal statuses", () => {
    const terminal = SWAP_STATUSES.filter(isSwapTerminal);
    expect(terminal.sort()).toEqual(["completed", "expired", "failed", "partially_funded"]);
  });

  it("every transition target is a known status", () => {
    for (const targets of Object.values(SWAP_TRANSITIONS)) {
      for (const t of targets) expect(SWAP_STATUSES).toContain(t);
    }
  });
});

const LEGAL_SWAP_IN_LEG: ReadonlyArray<[LegStatus, LegStatus]> = [
  ["pending", "seen"],
  ["pending", "expired"],
  ["seen", "confirmed"],
  ["confirmed", "settled"],
  ["confirmed", "failed"],
];

const LEGAL_SWAP_OUT_LEG: ReadonlyArray<[LegStatus, LegStatus]> = [
  ["pending", "committed"],
  ["pending", "expired"],
  ["committed", "broadcasting"],
  ["committed", "failed"],
  ["broadcasting", "settled"],
  ["broadcasting", "failed"],
];

describe("leg state machines", () => {
  it("swap_in legs allow exactly the documented transitions", () => {
    for (const from of LEG_STATUSES) {
      for (const to of LEG_STATUSES) {
        const legal = LEGAL_SWAP_IN_LEG.some(([f, t]) => f === from && t === to);
        expect(canTransitionLeg("swap_in", from, to), `swap_in ${from} -> ${to}`).toBe(legal);
      }
    }
  });

  it("swap_out legs allow exactly the documented transitions", () => {
    for (const from of LEG_STATUSES) {
      for (const to of LEG_STATUSES) {
        const legal = LEGAL_SWAP_OUT_LEG.some(([f, t]) => f === from && t === to);
        expect(canTransitionLeg("swap_out", from, to), `swap_out ${from} -> ${to}`).toBe(legal);
      }
    }
  });

  it("a swap_in leg can never enter off-chain-only statuses and vice versa", () => {
    for (const from of LEG_STATUSES) {
      expect(canTransitionLeg("swap_in", from, "committed")).toBe(false);
      expect(canTransitionLeg("swap_in", from, "broadcasting")).toBe(false);
      expect(canTransitionLeg("swap_out", from, "seen")).toBe(false);
      expect(canTransitionLeg("swap_out", from, "confirmed")).toBe(false);
    }
  });

  it("assertLegTransition throws a typed error carrying from/to", () => {
    try {
      assertLegTransition("swap_in", "settled", "pending", "leg-x");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect((err as InvalidTransitionError).from).toBe("settled");
      expect((err as InvalidTransitionError).to).toBe("pending");
    }
  });

  it("both leg maps cover every status as a source", () => {
    for (const status of LEG_STATUSES) {
      expect(SWAP_IN_LEG_TRANSITIONS[status]).toBeDefined();
      expect(SWAP_OUT_LEG_TRANSITIONS[status]).toBeDefined();
    }
  });
});
