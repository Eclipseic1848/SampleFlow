import assert from "node:assert/strict";
import test from "node:test";
import { nonnegativeMoneySchema } from "./validation.js";

test("金额只接受非负且最多两位小数的有限数字", () => {
  assert.equal(nonnegativeMoneySchema.safeParse(12.34).success, true);
  assert.equal(nonnegativeMoneySchema.safeParse(85_521_505_025.01).success, true);
  for (const value of [-0.01, 0.001, Number.POSITIVE_INFINITY]) {
    assert.equal(nonnegativeMoneySchema.safeParse(value).success, false);
  }
});
