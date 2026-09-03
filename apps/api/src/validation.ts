import { z } from "zod";

export const postgresBigintIdSchema = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
);

export function isSignedMoney(value: number): boolean {
  return Number.isFinite(value)
    && Math.abs(value) <= 99_999_999_999.99
    && Math.round(value * 100) / 100 === value;
}

export const signedMoneySchema = z.number().refine(isSignedMoney, "金额必须是有效的两位小数范围数字");

export const nonnegativeMoneySchema = signedMoneySchema.min(0);

export const pageNumberSchema=z.coerce.number().int().min(1).max(1_000_000);
export const pageSizeSchema=z.coerce.number().int().refine((value)=>[10,20,50,100].includes(value));
