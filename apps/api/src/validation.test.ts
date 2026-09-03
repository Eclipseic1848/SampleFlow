import assert from "node:assert/strict";
import test from "node:test";
import { nonnegativeMoneySchema, signedMoneySchema } from "./validation.js";

test("金额只接受非负且最多两位小数的有限数字", () => {
  assert.equal(nonnegativeMoneySchema.safeParse(12.34).success, true);
  assert.equal(nonnegativeMoneySchema.safeParse(85_521_505_025.01).success, true);
  for (const value of [-0.01, 0.001, Number.POSITIVE_INFINITY]) {
    assert.equal(nonnegativeMoneySchema.safeParse(value).success, false);
  }
});

test("系统营业额允许以负数表示应收未收", () => {
  assert.equal(signedMoneySchema.safeParse(-12.34).success, true);
  assert.equal(signedMoneySchema.safeParse(-85_521_505_025.01).success, true);
  assert.equal(signedMoneySchema.safeParse(36_582_488_170.77).success, true);
  assert.equal(signedMoneySchema.safeParse(-0.001).success, false);
});
