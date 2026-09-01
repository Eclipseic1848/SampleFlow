import { z } from "zod";

export const postgresBigintIdSchema = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
);
