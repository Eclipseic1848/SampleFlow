import { z } from "zod";

export const postgresBigintIdSchema = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
);

export const pageNumberSchema=z.coerce.number().int().min(1).max(1_000_000);
export const pageSizeSchema=z.coerce.number().int().refine((value)=>[10,20,50,100].includes(value));
