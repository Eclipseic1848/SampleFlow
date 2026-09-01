import type { Database } from "../db.js";
import type { CurrentUser } from "./auth.js";
import { canReadGoals, resolveGoalAccess } from "./authorization.js";

export type FormalReport = Readonly<{
  goalId: string;
  periodMonth: string;
  level: "sales_manager" | "department" | "group" | "personal";
  ownerName: string;
  targetAmount: string;
  actualAmount: string;
  gapAmount: string;
  achievementRate: string | null;
}>;

export type FormalReportResult =
  | { ok: true; report: FormalReport }
  | { ok: false; statusCode: 403 | 404 | 409; body: { code?: string; message: string } };

export type AchievementCalculationReason = "PERIOD_IN_FUTURE" | "TARGET_NOT_ACTIVE" | "TARGET_AMOUNT_NOT_POSITIVE" | "TARGET_SCOPE_AMBIGUOUS";

export function achievementCalculationReason(periodMonth: string, today: string, targetAmount: string | null, targetAmbiguous = false): AchievementCalculationReason | null {
  if (targetAmbiguous) return "TARGET_SCOPE_AMBIGUOUS";
  if (periodMonth > today.slice(0, 7)) return "PERIOD_IN_FUTURE";
  if (targetAmount === null) return "TARGET_NOT_ACTIVE";
  return Number(targetAmount) <= 0 ? "TARGET_AMOUNT_NOT_POSITIVE" : null;
}

export async function loadFormalReport(
  database: Database,
  user: CurrentUser,
  goalId: string,
  today: string,
): Promise<FormalReportResult> {
  const access = await resolveGoalAccess(database, user);
  if (!canReadGoals(access)) {
    return { ok: false, statusCode: 403, body: { message: "当前角色没有正式报表查看权限" } };
  }

  const found = await database.query<{
    goal_id: string;
    period_month: string;
    level: FormalReport["level"];
    owner_person_id: string;
    org_unit_id: string | null;
    owner_name: string;
    target_amount: string | null;
    active_sales_goal_count: string;
  }>(
    `select g.id::text as goal_id, to_char(g.period_month,'YYYY-MM') as period_month,
            g.goal_level as level, g.owner_person_id::text, g.org_unit_id::text,
            p.display_name as owner_name, active.amount::numeric(14,2)::text as target_amount,
            (select count(*)::text
             from goals root
             join goal_versions root_active on root_active.goal_id=root.id and root_active.status='active'
             where root.period_month=g.period_month and root.goal_level='sales_manager') as active_sales_goal_count
     from goals g
     join people p on p.id=g.owner_person_id
     left join goal_versions active on active.goal_id=g.id and active.status='active'
     where g.id=$1 and ($2::boolean or g.owner_person_id=any($3::bigint[]))`,
    [goalId, access.all, access.ownerPersonIds],
  );
  const goal = found.rows[0];
  if (!goal) return { ok: false, statusCode: 404, body: { message: "目标不存在" } };
  const calculationReason = achievementCalculationReason(
    goal.period_month,
    today,
    goal.target_amount,
    goal.level === "sales_manager" && Number(goal.active_sales_goal_count) !== 1,
  );
  if (calculationReason) {
    const messages: Record<AchievementCalculationReason, string> = {
      PERIOD_IN_FUTURE: "未来月份不能生成正式业绩报表",
      TARGET_NOT_ACTIVE: "目标尚未生效，不能生成正式业绩报表",
      TARGET_AMOUNT_NOT_POSITIVE: "目标金额必须大于零，不能生成正式业绩报表",
      TARGET_SCOPE_AMBIGUOUS: "存在多个生效的销售组织目标，不能生成正式业绩报表",
    };
    return {
      ok: false,
      statusCode: 409,
      body: { code: calculationReason, message: messages[calculationReason] },
    };
  }
  const targetAmount = goal.target_amount!;

  let scopeSql = "true";
  let scopeValues: unknown[] = [];
  if (goal.level === "personal") {
    scopeSql = "e.salesperson_person_id=$3";
    scopeValues = [goal.owner_person_id];
  } else if (goal.level === "group" || goal.level === "department") {
    if (goal.org_unit_id !== null) {
      scopeSql = goal.level === "group" ? "e.group_unit_id=$3" : "e.department_unit_id=$3";
      scopeValues = [goal.org_unit_id];
    } else {
      return {
        ok: false,
        statusCode: 409,
        body: { code: "REPORT_SCOPE_UNRESOLVED", message: "目标尚未绑定稳定组织单元，不能生成正式业绩报表" },
      };
    }
  }

  const calculated = await database.query<{ actual_amount: string; gap_amount: string; achievement_rate: string | null }>(
    `select coalesce(sum(e.delta_amount),0)::numeric(14,2)::text as actual_amount,
            ($2::numeric-coalesce(sum(e.delta_amount),0))::numeric(14,2)::text as gap_amount,
            case when $2::numeric=0 then null
                 else round(coalesce(sum(e.delta_amount),0)*100/$2::numeric,2)::text end as achievement_rate
     from performance_events e
     where e.accounting_month=$1 and ${scopeSql}`,
    [`${goal.period_month}-01`, targetAmount, ...scopeValues],
  );
  const metrics = calculated.rows[0]!;
  return {
    ok: true,
    report: {
      goalId: goal.goal_id,
      periodMonth: goal.period_month,
      level: goal.level,
      ownerName: goal.owner_name,
      targetAmount,
      actualAmount: metrics.actual_amount,
      gapAmount: metrics.gap_amount,
      achievementRate: metrics.achievement_rate,
    },
  };
}
