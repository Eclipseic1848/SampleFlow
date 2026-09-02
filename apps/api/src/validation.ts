import { z } from "zod";

export const postgresBigintIdSchema = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
);

export const nonnegativeMoneySchema = z.number().finite().min(0).max(99_999_999_999.99)
  .refine((value) => {
    const cents = value * 100;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(cents)) * 4;
    return Math.abs(cents - Math.round(cents)) <= tolerance;
  }, "金额最多保留两位小数");

export const pageNumberSchema=z.coerce.number().int().min(1).max(1_000_000);
export const pageSizeSchema=z.coerce.number().int().refine((value)=>[10,20,50,100].includes(value));
