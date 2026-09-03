export type PerformanceState = {
  currentRevenue: number;
  countedAmount: number;
  lifecycle: "draft" | "active" | "paused" | "zero" | "receivable_pending";
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
    const amount = money(command.amount);
    const lifecycle = amount > 0 ? "active" : amount < 0 ? "receivable_pending" : "zero";
    return { eventType: "initial", deltaAmount: amount, next: { currentRevenue: amount, countedAmount: amount, lifecycle } };
  }
  if (command.type === "revenue_change") {
    if (!['active','receivable_pending'].includes(state.lifecycle) || state.countedAmount !== state.currentRevenue || state.currentRevenue === 0) throw new PerformanceRuleError("只有正向计入或应收未收订单可以修改营业额");
    const newAmount = money(command.newAmount);
    const delta = money(newAmount - state.currentRevenue);
    if (delta === 0) throw new PerformanceRuleError("新营业额与当前营业额相同");
    const lifecycle = newAmount > 0 ? "active" : newAmount < 0 ? "receivable_pending" : "zero";
    return { eventType: "revenue_change", deltaAmount: delta, next: { currentRevenue: newAmount, countedAmount: money(state.countedAmount + delta), lifecycle } };
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
  const amount = money(command.amount);
  if (amount <= 0) throw new PerformanceRuleError("首次计入金额必须大于零");
  return { eventType: "first_include", deltaAmount: amount, next: { currentRevenue: amount, countedAmount: amount, lifecycle: "active" } };
}
