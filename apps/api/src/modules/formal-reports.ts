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
  achievementRate: string | null;
}>;

export type FormalReportResult =
  | { ok: true; report: FormalReport }
  | { ok: false; statusCode: 403 | 404 | 409; body: { code?: string; message: string } };

export async function loadFormalReport(
  database: Database,
  user: CurrentUser,
  goalId: number,
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
    owner_name: string;
    target_amount: string | null;
  }>(
    `select g.id::text as goal_id, to_char(g.period_month,'YYYY-MM') as period_month,
            g.goal_level as level, g.owner_person_id::text, p.display_name as owner_name,
            active.amount::numeric(14,2)::text as target_amount
     from goals g
     join people p on p.id=g.owner_person_id
     left join goal_versions active on active.goal_id=g.id and active.status='active'
     where g.id=$1 and ($2::boolean or g.owner_person_id=any($3::bigint[]))`,
    [goalId, access.all, access.ownerPersonIds],
  );
  const goal = found.rows[0];
  if (!goal) return { ok: false, statusCode: 404, body: { message: "目标不存在" } };
  if (goal.target_amount === null) {
    return {
      ok: false,
      statusCode: 409,
      body: { code: "TARGET_NOT_ACTIVE", message: "目标尚未生效，不能生成正式业绩报表" },
    };
  }

  let scopeSql = "true";
  let scopeValues: unknown[] = [];
  if (goal.level === "personal") {
    scopeSql = "e.salesperson_person_id=$3";
    scopeValues = [goal.owner_person_id];
  } else if (goal.level === "group" || goal.level === "department") {
    return {
      ok: false,
      statusCode: 409,
      body: { code: "REPORT_SCOPE_UNRESOLVED", message: "目标尚未绑定稳定组织单元，不能生成正式业绩报表" },
    };
  }

  const calculated = await database.query<{ actual_amount: string; achievement_rate: string | null }>(
    `select coalesce(sum(e.delta_amount),0)::numeric(14,2)::text as actual_amount,
            case when $2::numeric=0 then null
                 else round(coalesce(sum(e.delta_amount),0)*100/$2::numeric,2)::text end as achievement_rate
     from performance_events e
     where e.accounting_month=$1 and ${scopeSql}`,
    [`${goal.period_month}-01`, goal.target_amount, ...scopeValues],
  );
  const metrics = calculated.rows[0]!;
  return {
    ok: true,
    report: {
      goalId: goal.goal_id,
      periodMonth: goal.period_month,
      level: goal.level,
      ownerName: goal.owner_name,
      targetAmount: goal.target_amount,
      actualAmount: metrics.actual_amount,
      achievementRate: metrics.achievement_rate,
    },
  };
}
