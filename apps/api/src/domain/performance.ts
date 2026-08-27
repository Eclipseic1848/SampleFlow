export type PerformanceState = {
  currentRevenue: number;
  countedAmount: number;
  lifecycle: "draft" | "active" | "paused" | "zero";
};

export type PerformanceCommand =
  | { type: "initial"; amount: number }
  | { type: "revenue_change"; newAmount: number }
  | { type: "pause" }
  | { type: "restart" }
  | { type: "first_include"; amount: number };

export type PerformanceDecision = {
  eventType: PerformanceCommand["type"];
  deltaAmount: number;
  next: PerformanceState;
};

export class PerformanceRuleError extends Error {}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function decidePerformanceEvent(state: PerformanceState, command: PerformanceCommand): PerformanceDecision {
  if (command.type === "initial") {
    if (state.lifecycle !== "draft") throw new PerformanceRuleError("只有草稿订单可以首次入账");
    if (command.amount < 0) throw new PerformanceRuleError("首次录入金额不能为负数");
    const amount = money(command.amount);
    return { eventType: "initial", deltaAmount: amount, next: { currentRevenue: amount, countedAmount: amount, lifecycle: amount > 0 ? "active" : "zero" } };
  }
  if (command.type === "revenue_change") {
    if (state.lifecycle !== "active" || state.countedAmount <= 0 || state.currentRevenue <= 0) throw new PerformanceRuleError("只有正向计入订单可以修改营业额");
    if (command.newAmount < 0) throw new PerformanceRuleError("新营业额不能为负数");
    const newAmount = money(command.newAmount);
    const delta = money(newAmount - state.currentRevenue);
    if (delta === 0) throw new PerformanceRuleError("新营业额与当前营业额相同");
    return { eventType: "revenue_change", deltaAmount: delta, next: { currentRevenue: newAmount, countedAmount: money(state.countedAmount + delta), lifecycle: newAmount > 0 ? "active" : "zero" } };
  }
  if (command.type === "pause") {
    if (state.lifecycle !== "active" || state.countedAmount <= 0) throw new PerformanceRuleError("只有正向计入订单可以暂停");
    return { eventType: "pause", deltaAmount: money(-state.currentRevenue), next: { ...state, countedAmount: 0, lifecycle: "paused" } };
  }
  if (command.type === "restart") {
    if (state.lifecycle !== "paused") throw new PerformanceRuleError("只有暂停订单可以重启");
    return { eventType: "restart", deltaAmount: money(state.currentRevenue), next: { ...state, countedAmount: state.currentRevenue, lifecycle: state.currentRevenue > 0 ? "active" : "zero" } };
  }
  if (state.lifecycle !== "zero" || state.currentRevenue !== 0 || state.countedAmount !== 0) throw new PerformanceRuleError("只有零金额订单可以首次计入");
  if (command.amount <= 0) throw new PerformanceRuleError("首次计入金额必须大于零");
  const amount = money(command.amount);
  return { eventType: "first_include", deltaAmount: amount, next: { currentRevenue: amount, countedAmount: amount, lifecycle: "active" } };
}

