import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import {
  decidePerformanceEvent,
  PerformanceRuleError,
  type PerformanceCommand,
  type PerformanceState,
} from "../domain/performance.js";
import { standardBusinessRegionName } from "../domain/business-regions.js";
import { hasAnyRole, PERFORMANCE_EDITOR_ROLES } from "./auth.js";
import { canReadPerformance, pendingGoalSql, pendingGoalValues, performanceScopeSql, performanceScopeValues, resolvePerformanceAccess } from "./authorization.js";
import { loadFormalReport } from "./formal-reports.js";
import { OrganizationResolutionError, resolveOrganization } from "./organization.js";
import {
  accountingMonth,
  AccountingPeriodError,
  assertAccountingPeriodOpen,
  consumeApprovedCorrection,
  lockApprovedCorrection,
  type ApprovedCorrection,
} from "./accounting-periods.js";

const moneySchema = z.number().finite().min(0).max(99_999_999_999.99);
const dateSchema = z.iso.date();
const dashboardQuerySchema = z.object({
  month: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/).optional(),
});
const groupAchievementQuerySchema = dashboardQuerySchema.extend({
  groupId: z.coerce.number().int().positive(),
});

const createOrderSchema = z.strictObject({
  orderNo: z.string().min(1).max(100).refine(
    (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
    "订单编号必须是无首尾空格和控制字符的精确文本",
  ),
  customerName: z.string().trim().min(1).max(200),
  customerUnit: z.string().trim().min(1).max(300),
  businessRegionCode: z.string().refine((value) => standardBusinessRegionName(value) !== undefined, "必须选择标准业务区域"),
  salespersonPersonId: z.coerce.number().int().positive(),
  serviceType: z.string().trim().max(200).optional().default(""),
  sourceReceivedOn: dateSchema,
  amount: moneySchema,
  reason: z.string().trim().max(500).optional().default("首次录入"),
});

const eventBase = {
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(8).max(100),
  correctionRequestId: z.coerce.number().int().positive().optional(),
};
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("revenue_change"), newAmount: moneySchema, ...eventBase }),
  z.strictObject({ type: z.literal("pause"), ...eventBase }),
  z.strictObject({ type: z.literal("restart"), ...eventBase }),
  z.strictObject({ type: z.literal("first_include"), amount: moneySchema.positive(), ...eventBase }),
]);

type OrderRow = {
  id: string;
  qingflow_order_no: string;
  customer_name: string;
  customer_unit: string;
  salesperson_person_id: string;
  salesperson_name: string;
  service_type: string | null;
  source_received_on: string;
  original_amount: string;
  current_revenue: string;
  counted_amount: string;
  lifecycle_state: PerformanceState["lifecycle"]|"historical_review_required";
};

function businessDate(now:Date):string {
  const parts=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const value=(type:Intl.DateTimeFormatPartTypes)=>parts.find((part)=>part.type===type)?.value??"";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

type PersonalAchievementEvent = Readonly<{
  id: string;
  orderId: string;
  orderNo: string;
  customerName: string;
  eventType: string;
  deltaAmount: string;
  accountingMonth: string;
  occurredOn: string;
  sequence: number;
  reason: string | null;
  resultingCountedAmount: string;
  resultingLifecycleState: "active" | "paused" | "zero" | null;
  departmentName: string | null;
  groupName: string | null;
}>;

type AchievementRow = Readonly<{
  goal_id: string | null;
  target_amount: string | null;
  actual_amount: string;
  gap_amount: string | null;
  achievement_rate: string | null;
  event_count: string;
}>;

function timeProgressRate(periodMonth: string, today: string): string | null {
  const currentMonth = today.slice(0, 7);
  if (periodMonth > currentMonth) return null;
  if (periodMonth < currentMonth) return "100.00";
  const [year, month] = periodMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return (Number(today.slice(8, 10)) * 100 / daysInMonth).toFixed(2);
}

async function loadPersonalAchievement(database: Database, personId: string, periodMonth: string, today: string) {
  const result = await database.query<AchievementRow>(
    `with active_goal as (
       select g.id::text as goal_id,version.amount::numeric(14,2) as target_amount
       from goals g
       join goal_versions version on version.goal_id=g.id and version.status='active'
       where g.period_month=$1::date and g.goal_level='personal' and g.owner_person_id=$2
     )
     select (select goal_id from active_goal) as goal_id,
            (select target_amount::text from active_goal) as target_amount,
            coalesce(sum(event.delta_amount),0)::numeric(14,2)::text as actual_amount,
            case when (select target_amount from active_goal)>0
                 then ((select target_amount from active_goal)-coalesce(sum(event.delta_amount),0))::numeric(14,2)::text
                 else null end as gap_amount,
            case when (select target_amount from active_goal)>0
                 then round(coalesce(sum(event.delta_amount),0)*100/(select target_amount from active_goal),2)::text
                 else null end as achievement_rate,
            count(event.id)::text as event_count
     from performance_events event
     where event.accounting_month=$1::date and event.salesperson_person_id=$2`,
    [`${periodMonth}-01`, personId],
  );
  return formatAchievement(result.rows[0]!, periodMonth, today);
}

function formatAchievement(row: AchievementRow, periodMonth: string, today: string) {
  const currentMonth = today.slice(0, 7);
  const calculationReason = periodMonth > currentMonth
    ? "PERIOD_IN_FUTURE"
    : row.target_amount === null
      ? "TARGET_NOT_ACTIVE"
      : Number(row.target_amount) <= 0
        ? "TARGET_AMOUNT_NOT_POSITIVE"
        : null;
  const timeProgress = timeProgressRate(periodMonth, today);
  const achievementRate = calculationReason === null ? row.achievement_rate : null;
  return {
    goalId: row.goal_id,
    periodMonth,
    targetAmount: row.target_amount,
    actualAmount: row.actual_amount,
    gapAmount: calculationReason === null ? row.gap_amount : null,
    achievementRate,
    timeProgressRate: calculationReason === null ? timeProgress : null,
    progressVariance: achievementRate !== null && timeProgress !== null
      ? (Number(achievementRate) - Number(timeProgress)).toFixed(2)
      : null,
    calculationReason,
    eventCount: Number(row.event_count),
  };
}

async function loadPersonalAchievementEvents(database: Database, personId: string, periodMonth: string, today: string) {
  const result = await database.query<AchievementRow & { events: PersonalAchievementEvent[] }>(
    `with active_goal as (
       select g.id::text as goal_id,version.amount::numeric(14,2) as target_amount
       from goals g
       join goal_versions version on version.goal_id=g.id and version.status='active'
       where g.period_month=$1::date and g.goal_level='personal' and g.owner_person_id=$2
     ),personal_events as (
       select event.id,event.order_id,orders.qingflow_order_no,orders.customer_name,
              event.event_type,event.delta_amount,event.resulting_current_revenue,event.resulting_counted_amount,
              event.accounting_month,event.occurred_on,event.order_sequence,event.reason,
              event.department_name,event.group_name
       from performance_events event
       join performance_orders orders on orders.id=event.order_id
       where event.accounting_month=$1::date and event.salesperson_person_id=$2
     )
     select (select goal_id from active_goal) as goal_id,
            (select target_amount::text from active_goal) as target_amount,
            coalesce(sum(event.delta_amount),0)::numeric(14,2)::text as actual_amount,
            case when (select target_amount from active_goal)>0
                 then ((select target_amount from active_goal)-coalesce(sum(event.delta_amount),0))::numeric(14,2)::text
                 else null end as gap_amount,
            case when (select target_amount from active_goal)>0
                 then round(coalesce(sum(event.delta_amount),0)*100/(select target_amount from active_goal),2)::text
                 else null end as achievement_rate,
            count(event.id)::text as event_count,
            coalesce(jsonb_agg(jsonb_build_object(
              'id',event.id::text,
              'orderId',event.order_id::text,
              'orderNo',event.qingflow_order_no,
              'customerName',event.customer_name,
              'eventType',event.event_type,
              'deltaAmount',event.delta_amount::numeric(14,2)::text,
              'accountingMonth',to_char(event.accounting_month,'YYYY-MM'),
              'occurredOn',event.occurred_on::text,
              'sequence',event.order_sequence,
              'reason',event.reason,
              'resultingCountedAmount',event.resulting_counted_amount::numeric(14,2)::text,
              'resultingLifecycleState',case when event.event_type='legacy_adjustment' then null
                when event.event_type='pause' then 'paused'
                when event.event_type in ('restart','first_include') then 'active'
                when event.resulting_current_revenue>0 then 'active' else 'zero' end,
              'departmentName',event.department_name,
              'groupName',event.group_name
            ) order by event.occurred_on desc,event.order_sequence desc,event.id desc)
              filter(where event.id is not null),'[]'::jsonb) as events
     from personal_events event`,
    [`${periodMonth}-01`, personId],
  );
  const row = result.rows[0]!;
  return { ...formatAchievement(row, periodMonth, today), events: row.events };
}

type GroupAchievementEventRow = PersonalAchievementEvent & Readonly<{
  salespersonPersonId: string;
  salespersonName: string;
  memberActualAmount: string;
  orderActualAmount: string;
}>;

async function loadLedGroupIds(database: Database, personId: string, today: string): Promise<string[]> {
  const result = await database.query<{ group_id: string }>(
    `select distinct responsibility.org_unit_id::text as group_id
     from org_responsibilities responsibility
     join org_units unit on unit.id=responsibility.org_unit_id and unit.unit_type='group'
     where responsibility.person_id=$1 and responsibility.responsibility_type='leader'
       and responsibility.effective_from<=$2::date
       and (responsibility.effective_to is null or responsibility.effective_to>=$2::date)
     order by group_id`,
    [personId, today],
  );
  return result.rows.map((row) => row.group_id);
}

async function loadGroupAchievements(database: Database, personId: string, groupIds: string[], periodMonth: string, today: string) {
  if (groupIds.length === 0) return [];
  const result = await database.query<AchievementRow & {
    group_id: string;
    group_name: string;
    member_count: string;
  }>(
    `with selected_groups as (
       select id,name from org_units where id=any($2::bigint[]) and unit_type='group'
     ),active_goals as (
       select goal.id::text as goal_id,goal.org_unit_id,version.amount::numeric(14,2) as target_amount
       from goals goal
       join goal_versions version on version.goal_id=goal.id and version.status='active'
       where goal.period_month=$1::date and goal.goal_level='group'
         and goal.owner_person_id=$3 and goal.org_unit_id=any($2::bigint[])
     )
     select selected.id::text as group_id,selected.name as group_name,
            goal.goal_id,goal.target_amount::text,
            coalesce(sum(event.delta_amount),0)::numeric(14,2)::text as actual_amount,
            case when goal.target_amount>0
                 then (goal.target_amount-coalesce(sum(event.delta_amount),0))::numeric(14,2)::text
                 else null end as gap_amount,
            case when goal.target_amount>0
                 then round(coalesce(sum(event.delta_amount),0)*100/goal.target_amount,2)::text
                 else null end as achievement_rate,
            count(event.id)::text as event_count,
            count(distinct event.salesperson_person_id)::text as member_count
     from selected_groups selected
     left join active_goals goal on goal.org_unit_id=selected.id
     left join performance_events event on event.group_unit_id=selected.id and event.accounting_month=$1::date
     group by selected.id,selected.name,goal.goal_id,goal.target_amount
     order by selected.name,selected.id`,
    [`${periodMonth}-01`, groupIds, personId],
  );
  return result.rows.map((row) => ({
    groupId: row.group_id,
    groupName: row.group_name,
    memberCount: Number(row.member_count),
    ...formatAchievement(row, periodMonth, today),
  }));
}

async function loadGroupAchievementDetails(database: Database, personId: string, groupId: string, periodMonth: string, today: string) {
  const result = await database.query<AchievementRow & {
    group_name: string;
    member_count: string;
    events: GroupAchievementEventRow[];
  }>(
    `with selected_group as (
       select id,name from org_units where id=$2 and unit_type='group'
     ),active_goal as (
       select goal.id::text as goal_id,version.amount::numeric(14,2) as target_amount
       from goals goal
       join goal_versions version on version.goal_id=goal.id and version.status='active'
       where goal.period_month=$1::date and goal.goal_level='group'
         and goal.owner_person_id=$3 and goal.org_unit_id=$2
     ),group_events as (
       select event.id,event.order_id,orders.qingflow_order_no,orders.customer_name,
              event.event_type,event.delta_amount,event.resulting_current_revenue,event.resulting_counted_amount,
              event.accounting_month,event.occurred_on,event.order_sequence,event.reason,
              event.department_name,event.group_name,event.salesperson_person_id,event.salesperson_name,
              sum(event.delta_amount) over(partition by event.salesperson_person_id)::numeric(14,2)::text as member_actual_amount,
              sum(event.delta_amount) over(partition by event.order_id)::numeric(14,2)::text as order_actual_amount
       from performance_events event
       join performance_orders orders on orders.id=event.order_id
       where event.accounting_month=$1::date and event.group_unit_id=$2
     )
     select (select name from selected_group) as group_name,
            (select goal_id from active_goal) as goal_id,
            (select target_amount::text from active_goal) as target_amount,
            coalesce(sum(event.delta_amount),0)::numeric(14,2)::text as actual_amount,
            case when (select target_amount from active_goal)>0
                 then ((select target_amount from active_goal)-coalesce(sum(event.delta_amount),0))::numeric(14,2)::text
                 else null end as gap_amount,
            case when (select target_amount from active_goal)>0
                 then round(coalesce(sum(event.delta_amount),0)*100/(select target_amount from active_goal),2)::text
                 else null end as achievement_rate,
            count(event.id)::text as event_count,
            count(distinct event.salesperson_person_id)::text as member_count,
            coalesce(jsonb_agg(jsonb_build_object(
              'id',event.id::text,
              'orderId',event.order_id::text,
              'orderNo',event.qingflow_order_no,
              'customerName',event.customer_name,
              'eventType',event.event_type,
              'deltaAmount',event.delta_amount::numeric(14,2)::text,
              'accountingMonth',to_char(event.accounting_month,'YYYY-MM'),
              'occurredOn',event.occurred_on::text,
              'sequence',event.order_sequence,
              'reason',event.reason,
              'resultingCountedAmount',event.resulting_counted_amount::numeric(14,2)::text,
              'resultingLifecycleState',case when event.event_type='legacy_adjustment' then null
                when event.event_type='pause' then 'paused'
                when event.event_type in ('restart','first_include') then 'active'
                when event.resulting_current_revenue>0 then 'active' else 'zero' end,
              'departmentName',event.department_name,
              'groupName',event.group_name,
              'salespersonPersonId',event.salesperson_person_id::text,
              'salespersonName',event.salesperson_name,
              'memberActualAmount',event.member_actual_amount,
              'orderActualAmount',event.order_actual_amount
            ) order by event.salesperson_name,event.salesperson_person_id,event.qingflow_order_no,event.order_id,event.occurred_on,event.order_sequence,event.id)
              filter(where event.id is not null),'[]'::jsonb) as events
     from group_events event`,
    [`${periodMonth}-01`, groupId, personId],
  );
  const row = result.rows[0]!;
  const members = new Map<string, {
    personId: string;
    name: string;
    actualAmount: string;
    eventCount: number;
    orders: Map<string, { orderId: string; orderNo: string; customerName: string; actualAmount: string; eventCount: number; events: PersonalAchievementEvent[] }>;
  }>();
  for (const event of row.events) {
    const member = members.get(event.salespersonPersonId) ?? {
      personId: event.salespersonPersonId,
      name: event.salespersonName,
      actualAmount: event.memberActualAmount,
      eventCount: 0,
      orders: new Map(),
    };
    const order = member.orders.get(event.orderId) ?? {
      orderId: event.orderId,
      orderNo: event.orderNo,
      customerName: event.customerName,
      actualAmount: event.orderActualAmount,
      eventCount: 0,
      events: [],
    };
    const { salespersonPersonId: _personId, salespersonName: _personName, memberActualAmount: _memberAmount, orderActualAmount: _orderAmount, ...detail } = event;
    order.events.push(detail);
    order.eventCount += 1;
    member.orders.set(order.orderId, order);
    member.eventCount += 1;
    members.set(member.personId, member);
  }
  return {
    groupId,
    groupName: row.group_name,
    memberCount: Number(row.member_count),
    ...formatAchievement(row, periodMonth, today),
    members: [...members.values()].map((member) => ({ ...member, orders: [...member.orders.values()] })),
  };
}

function eventFingerprint(body:z.infer<typeof eventSchema>):string {
  return createHash("sha256").update(JSON.stringify({
    command: commandFromBody(body),
    reason: body.reason,
    correctionRequestId: body.correctionRequestId ?? null,
  })).digest("hex");
}

function commandFromBody(body: z.infer<typeof eventSchema>): PerformanceCommand {
  if (body.type === "revenue_change") return { type: body.type, newAmount: body.newAmount };
  if (body.type === "first_include") return { type: body.type, amount: body.amount };
  return { type: body.type };
}

function allowedActions(lifecycle: OrderRow["lifecycle_state"]): string[] {
  if (lifecycle === "active") return ["revenue_change", "pause"];
  if (lifecycle === "paused") return ["restart"];
  if (lifecycle === "zero") return ["first_include"];
  return [];
}

function requireEditor(request: { currentUser: import("./auth.js").CurrentUser | null }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
  if (!hasAnyRole(request.currentUser, PERFORMANCE_EDITOR_ROLES)) return reply.code(403).send({ message: "仅销售助理及销售助理组长可编辑业绩" });
  return null;
}

export async function registerPerformance(app: FastifyInstance, db: Database, clock:()=>Date=()=>new Date()) {
  app.get("/api/performance/people", async (request, reply) => {
    const denied = requireEditor(request, reply);
    if (denied) return denied;
    const result = await db.query(
      `select distinct p.id::text as id,p.display_name as "displayName"
       from people p join org_memberships m on m.person_id=p.id
       order by "displayName",id`,
    );
    return { people: result.rows };
  });

  app.get("/api/performance/formal-reports/:goalId", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = z.object({ goalId: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "目标标识无效" });
    const result = await loadFormalReport(db, request.currentUser, params.data.goalId);
    if (!result.ok) return reply.code(result.statusCode).send(result.body);
    return result.report;
  });

  app.get("/api/performance/dashboard", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const access = await resolvePerformanceAccess(db, request.currentUser);
    if (!canReadPerformance(access)) return reply.code(403).send({ message: "当前角色没有业务查看权限" });
    const parsed = dashboardQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "MONTH_INVALID", message: "月份格式无效" });
    const today = businessDate(clock());
    const month = parsed.data.month ?? today.slice(0, 7);
    const scopeValues = performanceScopeValues(access);
    const ledGroupIds = request.currentUser.roles.includes("sales_leader")
      ? await loadLedGroupIds(db, request.currentUser.personId, today)
      : [];
    const [metrics, monthly, groups, recent, pending, personalAchievement, groupAchievements] = await Promise.all([
      db.query<{ total: string; event_count: string; negative_total: string }>(
        `select coalesce(sum(delta_amount),0)::text as total, count(*)::text as event_count,
                coalesce(sum(delta_amount) filter (where delta_amount < 0),0)::text as negative_total
         from performance_events e where accounting_month = $1 and ${performanceScopeSql("e", 2)}`, [`${month}-01`, ...scopeValues]),
      db.query<{ month: string; total: string }>(
        `select to_char(accounting_month, 'YYYY-MM') as month, sum(delta_amount)::text as total
         from performance_events e where extract(year from accounting_month) = extract(year from $1::date)
           and ${performanceScopeSql("e", 2)}
         group by accounting_month order by accounting_month`, [`${month}-01`, ...scopeValues]),
      db.query<{ name: string; total: string }>(
        `select group_name as name, sum(delta_amount)::text as total
         from performance_events e where accounting_month = $1 and ${performanceScopeSql("e", 2)} group by group_name
         order by sum(delta_amount) desc limit 5`, [`${month}-01`, ...scopeValues]),
      db.query(
        `select o.qingflow_order_no as "orderNo", e.salesperson_name as "salespersonName",
                e.event_type as "eventType", to_char(e.accounting_month, 'YYYY-MM') as month,
                e.delta_amount::text as amount, e.group_name as "groupName"
         from performance_events e join performance_orders o on o.id = e.order_id
         where e.accounting_month=$1 and ${performanceScopeSql("e", 2)}
         order by e.created_at desc, e.id desc limit 8`, [`${month}-01`, ...scopeValues]),
      db.query<{ count: string }>(
        `select count(*)::text as count from goal_versions v join goals g on g.id=v.goal_id
         where ${pendingGoalSql("g", "v", 1)}`,
        pendingGoalValues(request.currentUser),
      ),
      request.currentUser.roles.some((role) => role === "salesperson" || role === "sales_leader")
        ? loadPersonalAchievement(db, request.currentUser.personId, month, today)
        : Promise.resolve(null),
      loadGroupAchievements(db, request.currentUser.personId, ledGroupIds, month, today),
    ]);
    return {
      month,
      metrics: { total: metrics.rows[0]!.total, eventCount: Number(metrics.rows[0]!.event_count), negativeTotal: metrics.rows[0]!.negative_total, pendingApprovals: Number(pending.rows[0]!.count) },
      monthly: monthly.rows,
      groups: groups.rows,
      recent: recent.rows,
      personalAchievement,
      groupAchievements,
    };
  });

  app.get("/api/performance/personal-achievement/events", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!request.currentUser.roles.some((role) => role === "salesperson" || role === "sales_leader")) {
      return reply.code(403).send({ message: "当前角色没有个人目标达成查看权限" });
    }
    const parsed = dashboardQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "MONTH_INVALID", message: "月份格式无效" });
    const today = businessDate(clock());
    const periodMonth = parsed.data.month ?? today.slice(0, 7);
    return loadPersonalAchievementEvents(db, request.currentUser.personId, periodMonth, today);
  });

  app.get("/api/performance/group-achievement/events", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!request.currentUser.roles.includes("sales_leader")) {
      return reply.code(403).send({ code: "GROUP_SCOPE_FORBIDDEN", message: "当前角色没有小组目标达成查看权限" });
    }
    const parsed = groupAchievementQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "GROUP_QUERY_INVALID", message: "小组或月份格式无效" });
    const today = businessDate(clock());
    const groupId = String(parsed.data.groupId);
    const ledGroupIds = await loadLedGroupIds(db, request.currentUser.personId, today);
    if (!ledGroupIds.includes(groupId)) {
      return reply.code(403).send({ code: "GROUP_SCOPE_FORBIDDEN", message: "只能查看当前明确负责的小组" });
    }
    const periodMonth = parsed.data.month ?? today.slice(0, 7);
    return loadGroupAchievementDetails(db, request.currentUser.personId, groupId, periodMonth, today);
  });

  app.get("/api/performance/orders", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const access = await resolvePerformanceAccess(db, request.currentUser);
    if (!canReadPerformance(access)) return reply.code(403).send({ message: "当前角色没有业务查看权限" });
    const query = z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ message: "查询条件无效" });
    const term = query.data.search ? `%${query.data.search}%` : null;
    const result = await db.query(
      `select id::text, qingflow_order_no as "orderNo", customer_name as "customerName",
              customer_unit as "customerUnit", performance_orders.salesperson_name as "salespersonName", service_type as "serviceType",
              source_received_on as "sourceReceivedOn", original_amount::text as "originalAmount",
              current_revenue::text as "currentRevenue", counted_amount::text as "countedAmount",
              lifecycle_state as "lifecycleState", posted_at as "postedAt",
              latest.department_name as "departmentName", latest.group_name as "groupName",
              latest.leader_name as "leaderName", latest.supervisor_name as "supervisorName"
       from performance_orders
       left join lateral (select salesperson_person_id,department_unit_id,group_unit_id,salesperson_name,department_name,group_name,leader_name,supervisor_name from performance_events where order_id=performance_orders.id order by occurred_on desc,id desc limit 1) latest on true
       where ($1::text is null or performance_orders.qingflow_order_no ilike $1 or performance_orders.salesperson_name ilike $1 or performance_orders.customer_name ilike $1)
         and ${performanceScopeSql("latest", 3)}
       order by posted_at desc nulls last, id desc limit $2`,
      [term, query.data.limit, ...performanceScopeValues(access)],
    );
    return { orders: result.rows };
  });

  app.get("/api/performance/orders/:id/events", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const access = await resolvePerformanceAccess(db, request.currentUser);
    if (!canReadPerformance(access)) return reply.code(403).send({ message: "当前角色没有业务查看权限" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "订单标识无效" });
    const result = await db.query(
      `select e.id::text, e.event_type as "eventType", e.delta_amount::text as "deltaAmount",
              e.resulting_current_revenue::text as "resultingCurrentRevenue",
              e.resulting_counted_amount::text as "resultingCountedAmount", e.accounting_month::text as "accountingMonth",
              e.occurred_on::text as "occurredOn", e.reason, e.salesperson_name as "salespersonName",
              e.department_name as "departmentName", e.group_name as "groupName", e.leader_name as "leaderName",
              e.supervisor_name as "supervisorName", e.occurred_at as "occurredAt", e.order_sequence as sequence,
              actor.display_name as "actorName", e.created_at as "createdAt",
              o.lifecycle_state as "lifecycleState",
              case when e.event_type='legacy_adjustment' then null
                   when e.event_type='pause' then 'paused'
                   when e.event_type in ('restart','first_include') then 'active'
                   when e.resulting_current_revenue>0 then 'active' else 'zero' end as "resultingLifecycleState"
       from performance_events e join performance_orders o on o.id=e.order_id
       left join users actor on actor.id=e.created_by
       where e.order_id = $1 and ${performanceScopeSql("e", 2)} order by e.order_sequence`,
      [params.data.id, ...performanceScopeValues(access)],
    );
    if (!result.rowCount) return reply.code(404).send({ message: "订单不存在" });
    const lifecycleState = (result.rows[0] as { lifecycleState: OrderRow["lifecycle_state"] }).lifecycleState;
    return {
      events: result.rows.map(({ lifecycleState: _lifecycleState, ...event }: Record<string, unknown>) => event),
      lifecycleState,
      allowedActions: hasAnyRole(request.currentUser, PERFORMANCE_EDITOR_ROLES) ? allowedActions(lifecycleState) : [],
    };
  });

  app.post("/api/performance/orders", async (request, reply) => {
    const denied = requireEditor(request, reply);
    if (denied) return denied;
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "订单信息不完整或格式无效", issues: parsed.error.issues });
    const input = parsed.data;
    const decision = decidePerformanceEvent({ currentRevenue: 0, countedAmount: 0, lifecycle: "draft" }, { type: "initial", amount: input.amount });
    const client = await db.connect();
    try {
      await client.query("begin");
      await assertAccountingPeriodOpen(client, accountingMonth(input.sourceReceivedOn));
      const organization = await resolveOrganization(client, String(input.salespersonPersonId), input.sourceReceivedOn);
      const order = await client.query<{ id: string }>(
        `insert into performance_orders
          (qingflow_order_no, customer_name, customer_unit, business_region_source_text, business_region_code,
           salesperson_person_id, salesperson_name, service_type, source_received_on,
            original_amount, current_revenue, counted_amount, lifecycle_state, created_by, posted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()) returning id::text`,
        [input.orderNo, input.customerName, input.customerUnit, standardBusinessRegionName(input.businessRegionCode), input.businessRegionCode,
         organization.personId, organization.salespersonName, input.serviceType || null, input.sourceReceivedOn,
         input.amount, decision.next.currentRevenue, decision.next.countedAmount, decision.next.lifecycle, request.currentUser!.id],
      );
      const orderId = order.rows[0]!.id;
      await client.query(
        `insert into performance_events
          (order_id, event_type, delta_amount, resulting_current_revenue, resulting_counted_amount,
           accounting_month, occurred_on, reason, salesperson_name, department_name, group_name,
           leader_name, supervisor_name, created_by, salesperson_person_id, department_unit_id,
           group_unit_id, leader_person_id, supervisor_person_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [orderId, decision.eventType, decision.deltaAmount, decision.next.currentRevenue,
         decision.next.countedAmount, accountingMonth(input.sourceReceivedOn), input.sourceReceivedOn, input.reason,
         organization.salespersonName, organization.departmentName, organization.groupName, organization.leaderName,
         organization.supervisorName, request.currentUser!.id, organization.personId, organization.departmentId,
         organization.groupId, organization.leaderPersonId, organization.supervisorPersonId],
      );
      await client.query(
        `insert into audit_logs (actor_user_id, action, entity_type, entity_id, after_data, ip_address)
         values ($1, 'performance.order_posted', 'performance_order', $2, $3, $4)`,
        [request.currentUser!.id, orderId, JSON.stringify(input), request.ip],
      );
      await client.query("commit");
      return reply.code(201).send({ id: orderId });
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ message: "订单编号已存在" });
      if (error instanceof AccountingPeriodError) return reply.code(409).send({ message: error.message });
      if (error instanceof OrganizationResolutionError) return reply.code(409).send({ message: error.message });
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/performance/orders/:id/events", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const parsed = eventSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "调整信息不完整或格式无效" });
    if (parsed.data.correctionRequestId) {
      if (!hasAnyRole(request.currentUser, ["sales_assistant_leader"])) {
        return reply.code(403).send({ message: "仅销售助理组长可执行已批准的历史更正" });
      }
    } else {
      const denied = requireEditor(request, reply);
      if (denied) return denied;
    }
    const client = await db.connect();
    try {
      await client.query("begin");
      const found = await client.query<OrderRow>(
        `select id::text, qingflow_order_no, customer_name, customer_unit, salesperson_person_id::text, salesperson_name, service_type,
                source_received_on::text, original_amount::text, current_revenue::text,
                counted_amount::text, lifecycle_state
         from performance_orders where id = $1 for update`,
        [params.data.id],
      );
      const order = found.rows[0];
      if (!order) {
        await client.query("rollback");
        return reply.code(404).send({ message: "订单不存在" });
      }
      if(order.lifecycle_state==="historical_review_required"){
        await client.query("rollback");
        return reply.code(409).send({message:"历史订单尚未完成核对审批，不能执行调整"});
      }
      const state: PerformanceState = {
        currentRevenue: Number(order.current_revenue),
        countedAmount: Number(order.counted_amount),
        lifecycle: order.lifecycle_state,
      };
      const fingerprint=eventFingerprint(parsed.data);
      const existing=await client.query<{event_type:string;delta_amount:string;resulting_current_revenue:string;resulting_counted_amount:string;request_fingerprint:string|null}>(
        "select event_type,delta_amount::text,resulting_current_revenue::text,resulting_counted_amount::text,request_fingerprint from performance_events where order_id=$1 and idempotency_key=$2",
        [params.data.id,parsed.data.idempotencyKey],
      );
      if(existing.rows[0]){
        await client.query("rollback");
        if(existing.rows[0].request_fingerprint!==fingerprint)return reply.code(409).send({message:"幂等键已用于不同调整"});
        return reply.code(200).send({eventType:existing.rows[0].event_type,deltaAmount:Number(existing.rows[0].delta_amount),state:{currentRevenue:Number(existing.rows[0].resulting_current_revenue),countedAmount:Number(existing.rows[0].resulting_counted_amount)},replayed:true});
      }
      const decision = decidePerformanceEvent(state, commandFromBody(parsed.data));
      const operationTime=clock();
      let correction: ApprovedCorrection | null = null;
      if (parsed.data.correctionRequestId) {
        correction = await lockApprovedCorrection(
          client,
          parsed.data.correctionRequestId,
          params.data.id,
          parsed.data.type,
          request.currentUser.personId,
          operationTime,
        );
      }
      const occurredOn=correction?.occurredOn ?? businessDate(operationTime);
      const eventAccountingMonth=correction?.periodMonth ?? accountingMonth(occurredOn);
      if (!correction) await assertAccountingPeriodOpen(client, eventAccountingMonth);
      const organization = await resolveOrganization(client, order.salesperson_person_id, occurredOn);
      const inserted = await client.query<{ id: string }>(
        `insert into performance_events
          (order_id, event_type, delta_amount, resulting_current_revenue, resulting_counted_amount,
           accounting_month, occurred_on, reason, salesperson_name, department_name, group_name,
           leader_name, supervisor_name, created_by, salesperson_person_id, department_unit_id,
           group_unit_id, leader_person_id, supervisor_person_id,occurred_at,idempotency_key,request_fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         returning id::text`,
        [params.data.id, decision.eventType, decision.deltaAmount, decision.next.currentRevenue,
         decision.next.countedAmount, eventAccountingMonth, occurredOn,
         parsed.data.reason, organization.salespersonName, organization.departmentName, organization.groupName,
         organization.leaderName, organization.supervisorName, request.currentUser!.id, organization.personId,
         organization.departmentId, organization.groupId, organization.leaderPersonId, organization.supervisorPersonId,
         operationTime.toISOString(),parsed.data.idempotencyKey,fingerprint],
      );
      await client.query(
        `update performance_orders set current_revenue = $2, counted_amount = $3, lifecycle_state = $4 where id = $1`,
        [params.data.id, decision.next.currentRevenue, decision.next.countedAmount, decision.next.lifecycle],
      );
      await client.query(
        `insert into audit_logs (actor_user_id, action, entity_type, entity_id, before_data, after_data, ip_address)
         values ($1, 'performance.event_posted', 'performance_order', $2, $3, $4, $5)`,
        [request.currentUser!.id, String(params.data.id), JSON.stringify(state), JSON.stringify(decision), request.ip],
      );
      if (correction) {
        await consumeApprovedCorrection(
          client,
          correction,
          request.currentUser.id,
          request.currentUser.personId,
          inserted.rows[0]!.id,
          operationTime,
          request.ip,
        );
      }
      await client.query("commit");
      return reply.code(201).send({ eventType: decision.eventType, deltaAmount: decision.deltaAmount, state: decision.next,replayed:false });
    } catch (error) {
      await client.query("rollback");
      if (error instanceof PerformanceRuleError) return reply.code(409).send({ message: error.message });
      if (error instanceof AccountingPeriodError) return reply.code(409).send({ message: error.message });
      if (error instanceof OrganizationResolutionError) return reply.code(409).send({ message: error.message });
      throw error;
    } finally {
      client.release();
    }
  });
}
