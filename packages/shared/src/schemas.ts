import { z } from "zod";
import { LEDGER_CHAINS, SWAP_DIRECTIONS, SWAP_STATUSES } from "./types";

/** Decimal string of sats. Bigints never ride JSON as numbers. */
export const satsStringSchema = z
  .string()
  .regex(/^\d+$/, "must be a decimal string of satoshis");

const positiveSatsSchema = satsStringSchema.refine((s) => BigInt(s) > 0n, {
  message: "must be greater than zero",
});

export const registerLpSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const updateLpSchema = z.object({
  status: z.enum(["active", "paused"]),
});

const liquidityOfferSchema = z
  .object({
    capacitySats: satsStringSchema,
    feeBps: z.number().int().min(0).max(10_000),
    feeFixedSats: satsStringSchema,
    minSats: positiveSatsSchema,
    maxSats: positiveSatsSchema,
    estSeconds: z.number().int().min(1).max(24 * 60 * 60),
  })
  .refine((o) => BigInt(o.minSats) <= BigInt(o.maxSats), {
    message: "minSats must be <= maxSats",
  });

export const setLiquiditySchema = z
  .object({
    swapIn: liquidityOfferSchema.optional(),
    swapOut: liquidityOfferSchema.optional(),
  })
  .refine((o) => o.swapIn !== undefined || o.swapOut !== undefined, {
    message: "at least one of swapIn / swapOut is required",
  });

export const fundLpSchema = z.object({
  lpId: z.string().min(1),
  chain: z.enum(LEDGER_CHAINS),
  amountSats: positiveSatsSchema,
});

export const quoteRequestSchema = z.object({
  direction: z.enum(SWAP_DIRECTIONS),
  amountSats: positiveSatsSchema,
});

export const createSwapSchema = z.object({
  quoteId: z.string().min(1),
  destination: z.string().trim().min(4).max(200),
  webhookUrl: z.string().url().optional(),
});

export const idParamsSchema = z.object({
  id: z.string().min(1),
});

export const listSwapsQuerySchema = z.object({
  status: z.enum(SWAP_STATUSES).optional(),
  direction: z.enum(SWAP_DIRECTIONS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Shared pagination for the LP read endpoints. */
export const lpPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const lpHistoryQuerySchema = lpPageQuerySchema.extend({
  status: z.enum(["settled", "failed"]).optional(),
  direction: z.enum(SWAP_DIRECTIONS).optional(),
});

export const simulateDepositSchema = z.object({
  address: z.string().min(4),
  amountSats: positiveSatsSchema,
});

export const advanceBlocksSchema = z.object({
  blocks: z.number().int().min(1).max(1000),
});

export type RegisterLpBody = z.infer<typeof registerLpSchema>;
export type UpdateLpBody = z.infer<typeof updateLpSchema>;
export type LiquidityOfferBody = z.infer<typeof liquidityOfferSchema>;
export type SetLiquidityBody = z.infer<typeof setLiquiditySchema>;
export type FundLpBody = z.infer<typeof fundLpSchema>;
export type QuoteRequestBody = z.infer<typeof quoteRequestSchema>;
export type CreateSwapBody = z.infer<typeof createSwapSchema>;
export type ListSwapsQuery = z.infer<typeof listSwapsQuerySchema>;
export type LpPageQuery = z.infer<typeof lpPageQuerySchema>;
export type LpHistoryQuery = z.infer<typeof lpHistoryQuerySchema>;
