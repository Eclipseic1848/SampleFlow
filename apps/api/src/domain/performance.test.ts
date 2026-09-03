import assert from "node:assert/strict";
import test from "node:test";
import { decidePerformanceEvent, PerformanceRuleError, type PerformanceState } from "./performance.js";

test("营业额修改只产生新旧金额差额", () => {
  const state: PerformanceState = { currentRevenue: 110, countedAmount: 110, lifecycle: "active" };
  const result = decidePerformanceEvent(state, { type: "revenue_change", newAmount: 100 });
  assert.equal(result.deltaAmount, -10);
  assert.deepEqual(result.next, { currentRevenue: 100, countedAmount: 100, lifecycle: "active" });
});

test("修改后暂停按当前营业额全额扣减", () => {
  const changed = decidePerformanceEvent({ currentRevenue: 110, countedAmount: 110, lifecycle: "active" }, { type: "revenue_change", newAmount: 100 });
  const paused = decidePerformanceEvent(changed.next, { type: "pause" });
  assert.equal(paused.deltaAmount, -100);
  assert.deepEqual(paused.next, { currentRevenue: 100, countedAmount: 0, lifecycle: "paused" });
});

test("暂停订单不能修改营业额", () => {
  assert.throws(() => decidePerformanceEvent({ currentRevenue: 100, countedAmount: 0, lifecycle: "paused" }, { type: "revenue_change", newAmount: 90 }), PerformanceRuleError);
});

test("零金额订单通过首次计入事件转为正向计入", () => {
  const result = decidePerformanceEvent({ currentRevenue: 0, countedAmount: 0, lifecycle: "zero" }, { type: "first_include", amount: 88 });
  assert.equal(result.deltaAmount, 88);
  assert.equal(result.next.lifecycle, "active");
});

test("首次计入金额舍入为零时拒绝改变账本状态", () => {
  assert.throws(
    () => decidePerformanceEvent({ currentRevenue: 0, countedAmount: 0, lifecycle: "zero" }, { type: "first_include", amount: 0.001 }),
    PerformanceRuleError,
  );
});

test("负数首次入账表示应收未收并可通过营业额调整解除", () => {
  const pending = decidePerformanceEvent({ currentRevenue: 0, countedAmount: 0, lifecycle: "draft" }, { type: "initial", amount: -2000 });
  assert.deepEqual(pending.next, { currentRevenue: -2000, countedAmount: -2000, lifecycle: "receivable_pending" });
  const settled = decidePerformanceEvent(pending.next, { type: "revenue_change", newAmount: 2000 });
  assert.equal(settled.deltaAmount, 4000);
  assert.deepEqual(settled.next, { currentRevenue: 2000, countedAmount: 2000, lifecycle: "active" });
});
