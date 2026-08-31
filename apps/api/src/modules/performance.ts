import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { businessDate } from "../domain/business-time.js";
import {
  decidePerformanceEvent,
  PerformanceRuleError,
  type PerformanceCommand,
  type PerformanceState,
} from "../domain/performance.js";
import { standardBusinessRegionName } from "../domain/business-regions.js";
import { hasAnyRole, PERFORMANCE_EDITOR_ROLES } from "./auth.js";
import { canReadPerformance, pendingGoalSql, pendingGoalValues, performanceScopeSql, performanceScopeValues, resolvePerformanceAccess } from "./authorization.js";
import { recordEventAnalysisDimensions } from "./event-analysis-dimensions.js";
import { achievementCalculationReason, loadFormalReport } from "./formal-reports.js";
import { latestOrderEventJoinSql, normalizeOrderFilters, orderFilterQuerySchema, orderFilterSql, orderFilterValues, type OrderFilters } from "./order-query.js";
import { OrganizationResolutionError, resolveOrganization } from "./organization.js";
import {
  accountingMonth,
  AccountingPeriodError,
  assertAccountingPeriodOpen,
  consumeApprovedCorrection,
  lockApprovedCorrection,
  type ApprovedCorrection,
} from "./accounting-periods.js";

type QueryDatabase = Pick<Database, "query">;

const moneySchema = z.number().finite().min(0).max(99_999_999_999.99);
const dateSchema = z.iso.date();
const dashboardQuerySchema = z.object({
  month: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/).optional(),
});
const groupAchievementQuerySchema = dashboardQuerySchema.extend({
  groupId: z.coerce.number().int().positive(),
});
const departmentAchievementQuerySchema = dashboardQuerySchema.extend({
  departmentId: z.coerce.number().int().positive(),
});
const ORDER_PAGE_SIZE = 50;
const postgresBigintIdSchema = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
);
const orderListQuerySchema = orderFilterQuerySchema.extend({
  cursor: z.string().min(1).max(2048).optional(),
});
const orderCursorSchema = z.strictObject({
  version: z.literal(2),
  direction: z.enum(["next", "previous"]),
  anchorCreatedAt: z.iso.datetime(),
  anchorId: postgresBigintIdSchema,
  cutoffCreatedAt: z.iso.datetime(),
  cutoffId: postgresBigintIdSchema,
  filterDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  userId: postgresBigintIdSchema,
});
type OrderCursor = z.infer<typeof orderCursorSchema>;

function orderFilterDigest(filters: OrderFilters): string {
  return createHash("sha256").update(JSON.stringify(filters), "utf8").digest("base64url");
}

function encodeOrderCursor(cursor: OrderCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeOrderCursor(value: string): OrderCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = orderCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const DEPARTMENT_ACHIEVEMENT_ROLES = ["sales_supervisor", "sales_manager", "hr", "general_manager"] as const;
const SALES_ACHIEVEMENT_ROLES = ["sales_manager", "hr", "general_manager"] as const;

const createOrderSchema = z.strictObject({
  orderNo: z.string().min(1).max(100).refine(
    (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
    "订单编号必须是无首尾空格和控制字符的精确文本",
  ),
  customerName: z.string().trim().min(1).max(200),
  customerUnit: z.string().trim().min(1).max(300),
  businessRegionSourceText: z.string().trim().min(1).max(100),
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
  business_region_source_text: string | null;
  business_region_code: string | null;
  salesperson_person_id: string;
  salesperson_name: string;
  service_type: string | null;
  source_received_on: string;
  original_amount: string;
  current_revenue: string;
  counted_amount: string;
  lifecycle_state: PerformanceState["lifecycle"]|"historical_review_required";
};

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
  target_ambiguous?: boolean;
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

async function loadPersonalAchievement(database: QueryDatabase, personId: string, periodMonth: string, today: string) {
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
  const calculationReason = achievementCalculationReason(periodMonth, today, row.target_amount, row.target_ambiguous);
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

async function loadPersonalAchievementEvents(database: QueryDatabase, personId: string, periodMonth: string, today: string) {
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
  salespersonPersonId: string | null;
  salespersonName: string;
  personKey: string;
  memberActualAmount: string;
  orderActualAmount: string;
}>;

type DepartmentAchievementRow = AchievementRow & Readonly<{
  department_key: string;
  department_id: string | null;
  department_name: string;
  group_count: string;
}>;

type DepartmentGroupAchievementRow = AchievementRow & Readonly<{
  department_key: string;
  department_id: string | null;
  department_name: string;
  group_key: string;
  group_id: string | null;
  group_name: string;
  member_count: string;
}>;

type OrganizationAchievementEventRow = GroupAchievementEventRow & Readonly<{
  departmentKey: string;
  departmentUnitId: string | null;
  groupKey: string;
  groupUnitId: string | null;
}>;

async function loadLedGroupIds(database: QueryDatabase, personId: string, today: string): Promise<string[]> {
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

async function loadGroupAchievements(database: QueryDatabase, groupIds: string[], periodMonth: string, today: string) {
  if (groupIds.length === 0) return [];
  const result = await database.query<AchievementRow & {
    group_id: string;
    group_name: string;
    member_count: string;
  }>(
    `with event_group_names as (
       select distinct on (event.group_unit_id) event.group_unit_id,event.group_name
       from performance_events event
       where event.accounting_month=$1::date and event.group_unit_id=any($2::bigint[])
       order by event.group_unit_id,event.occurred_on desc,event.order_sequence desc,event.id desc
     ),selected_groups as (
       select unit.id,coalesce(snapshot.group_name,unit.name) as name
       from org_units unit
       left join event_group_names snapshot on snapshot.group_unit_id=unit.id
       where unit.id=any($2::bigint[]) and unit.unit_type='group'
     ),active_goals as (
       select distinct on (goal.org_unit_id) goal.id::text as goal_id,goal.org_unit_id,version.amount::numeric(14,2) as target_amount
       from goals goal
       join goal_versions version on version.goal_id=goal.id and version.status='active'
       where goal.period_month=$1::date and goal.goal_level='group'
         and goal.org_unit_id=any($2::bigint[])
       order by goal.org_unit_id,version.created_at desc,version.id desc
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
             count(distinct coalesce('id:'||event.salesperson_person_id::text,'legacy:'||event.salesperson_name))::text as member_count
     from selected_groups selected
     left join active_goals goal on goal.org_unit_id=selected.id
     left join performance_events event on event.group_unit_id=selected.id and event.accounting_month=$1::date
     group by selected.id,selected.name,goal.goal_id,goal.target_amount
     order by selected.name,selected.id`,
    [`${periodMonth}-01`, groupIds],
  );
  return result.rows.map((row) => ({
    groupId: row.group_id,
    groupName: row.group_name,
    memberCount: Number(row.member_count),
    ...formatAchievement(row, periodMonth, today),
  }));
}

async function loadGroupAchievementDetails(database: QueryDatabase, groupId: string, periodMonth: string, today: string) {
  const result = await database.query<AchievementRow & {
    group_name: string;
    member_count: string;
    events: GroupAchievementEventRow[];
  }>(
    `with event_group_name as (
       select event.group_name
       from performance_events event
       where event.accounting_month=$1::date and event.group_unit_id=$2
       order by event.occurred_on desc,event.order_sequence desc,event.id desc
       limit 1
     ),selected_group as (
       select id,coalesce((select group_name from event_group_name),name) as name
       from org_units where id=$2 and unit_type='group'
     ),active_goal as (
       select goal.id::text as goal_id,version.amount::numeric(14,2) as target_amount
       from goals goal
       join goal_versions version on version.goal_id=goal.id and version.status='active'
       where goal.period_month=$1::date and goal.goal_level='group'
         and goal.org_unit_id=$2
       order by version.created_at desc,version.id desc
       limit 1
      ),group_events as (
        select event.id,event.order_id,orders.qingflow_order_no,orders.customer_name,
               event.event_type,event.delta_amount,event.resulting_current_revenue,event.resulting_counted_amount,
               event.accounting_month,event.occurred_on,event.order_sequence,event.reason,
               event.department_name,event.group_name,event.salesperson_person_id,event.salesperson_name,
               coalesce('id:'||event.salesperson_person_id::text,'legacy:'||event.salesperson_name) as person_key,
               sum(event.delta_amount) over(
                 partition by coalesce('id:'||event.salesperson_person_id::text,'legacy:'||event.salesperson_name)
               )::numeric(14,2)::text as member_actual_amount,
               sum(event.delta_amount) over(
                 partition by coalesce('id:'||event.salesperson_person_id::text,'legacy:'||event.salesperson_name),event.order_id
               )::numeric(14,2)::text as order_actual_amount
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
             count(distinct event.person_key)::text as member_count,
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
               'personKey',event.person_key,
               'memberActualAmount',event.member_actual_amount,
               'orderActualAmount',event.order_actual_amount
             ) order by event.person_key,event.qingflow_order_no,event.order_id,event.occurred_on,event.order_sequence,event.id)
              filter(where event.id is not null),'[]'::jsonb) as events
     from group_events event`,
    [`${periodMonth}-01`, groupId],
  );
  const row = result.rows[0]!;
  const members = new Map<string, {
    personId: string | null;
    personKey: string;
    name: string;
    actualAmount: string;
    eventCount: number;
    orders: Map<string, { orderId: string; orderNo: string; customerName: string; actualAmount: string; eventCount: number; events: PersonalAchievementEvent[] }>;
  }>();
  for (const event of row.events) {
    const member = members.get(event.personKey) ?? {
      personId: event.salespersonPersonId,
      personKey: event.personKey,
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
    const { salespersonPersonId: _personId, salespersonName: _personName, personKey: _personKey, memberActualAmount: _memberAmount, orderActualAmount: _orderAmount, ...detail } = event;
    order.events.push(detail);
    order.eventCount += 1;
    member.orders.set(order.orderId, order);
    member.eventCount += 1;
    members.set(member.personKey, member);
  }
  return {
    groupId,
    groupName: row.group_name,
    memberCount: Number(row.member_count),
    ...formatAchievement(row, periodMonth, today),
    members: [...members.values()].map((member) => ({ ...member, orders: [...member.orders.values()] })),
  };
}

type OrganizationHierarchyQueryRow = AchievementRow & Readonly<{
  departments: DepartmentAchievementRow[];
  groups: DepartmentGroupAchievementRow[];
  events: OrganizationAchievementEventRow[];
}>;

type HierarchyOrder = {
  orderId: string;
  orderNo: string;
  customerName: string;
  actualAmount: string;
  eventCount: number;
  events: PersonalAchievementEvent[];
};

type HierarchyMember = {
  personId: string | null;
  personKey: string;
  name: string;
  actualAmount: string;
  eventCount: number;
  orders: Map<string, HierarchyOrder>;
};

type HierarchyGroup = ReturnType<typeof formatAchievement> & {
  groupId: string | null;
  groupKey: string;
  groupName: string;
  memberCount: number;
  members: Map<string, HierarchyMember>;
};

type HierarchyDepartment = ReturnType<typeof formatAchievement> & {
  departmentId: string | null;
  departmentKey: string;
  departmentName: string;
  groupCount: number;
  groups: Map<string, HierarchyGroup>;
};

// ponytail: 当前 P1 数据量一次批量读取；事件量显著增长后再增加逐层分页。
async function loadOrganizationAchievementHierarchy(
  database: QueryDatabase,
  departmentIds: string[],
  includeAllDepartments: boolean,
  periodMonth: string,
  today: string,
) {
  const result = await database.query<OrganizationHierarchyQueryRow>(
    ORGANIZATION_ACHIEVEMENT_SQL,
    [`${periodMonth}-01`, departmentIds, includeAllDepartments],
  );
  const row = result.rows[0]!;
  const departments = new Map<string, HierarchyDepartment>();
  for (const department of row.departments) {
    departments.set(department.department_key, {
      departmentId: department.department_id,
      departmentKey: department.department_key,
      departmentName: department.department_name,
      groupCount: Number(department.group_count),
      ...formatAchievement(department, periodMonth, today),
      groups: new Map(),
    });
  }
  for (const group of row.groups) {
    const department = departments.get(group.department_key);
    if (!department) throw new Error("组织业绩部门层级缺失");
    department.groups.set(group.group_key, {
      groupId: group.group_id,
      groupKey: group.group_key,
      groupName: group.group_name,
      memberCount: Number(group.member_count),
      ...formatAchievement(group, periodMonth, today),
      members: new Map(),
    });
  }
  for (const event of row.events) {
    const department = departments.get(event.departmentKey);
    const group = department?.groups.get(event.groupKey);
    if (!department || !group) throw new Error("组织业绩事件层级缺失");
    const member = group.members.get(event.personKey) ?? {
      personId: event.salespersonPersonId,
      personKey: event.personKey,
      name: event.salespersonName,
      actualAmount: event.memberActualAmount,
      eventCount: 0,
      orders: new Map<string, HierarchyOrder>(),
    };
    const order = member.orders.get(event.orderId) ?? {
      orderId: event.orderId,
      orderNo: event.orderNo,
      customerName: event.customerName,
      actualAmount: event.orderActualAmount,
      eventCount: 0,
      events: [],
    };
    const {
      departmentKey: _departmentKey,
      departmentUnitId: _departmentUnitId,
      groupKey: _groupKey,
      groupUnitId: _groupUnitId,
      salespersonPersonId: _salespersonPersonId,
      salespersonName: _salespersonName,
      personKey: _personKey,
      memberActualAmount: _memberActualAmount,
      orderActualAmount: _orderActualAmount,
      ...detail
    } = event;
    order.events.push(detail);
    order.eventCount += 1;
    member.orders.set(order.orderId, order);
    member.eventCount += 1;
    group.members.set(member.personKey, member);
  }
  const departmentList = [...departments.values()].map((department) => ({
    ...department,
    groupCount: department.groups.size,
    groups: [...department.groups.values()].map((group) => ({
      ...group,
      memberCount: group.members.size,
      members: [...group.members.values()].map((member) => ({ ...member, orders: [...member.orders.values()] })),
    })),
  }));
  return {
    departments: departmentList,
    salesAchievement: includeAllDepartments ? {
      departmentCount: departmentList.length,
      ...formatAchievement(row, periodMonth, today),
    } : null,
  };
}

export const ORGANIZATION_ACHIEVEMENT_SQL =
    `with scope_events as (
       select event.*,orders.qingflow_order_no,orders.customer_name,
              coalesce('id:'||event.department_unit_id::text,'legacy:'||coalesce(event.department_name,'待补齐组织归属')) as department_key,
              coalesce('id:'||event.group_unit_id::text,'legacy:'||coalesce(event.group_name,'待补齐小组')) as group_key,
              coalesce('id:'||event.salesperson_person_id::text,'legacy:'||event.salesperson_name) as person_key
       from performance_events event
       join performance_orders orders on orders.id=event.order_id
       where event.accounting_month=$1::date
         and ($3::boolean or event.department_unit_id=any($2::bigint[]))
     ),active_department_goals as (
       select distinct on (goal.org_unit_id) goal.id::text as goal_id,goal.org_unit_id,
              version.amount::numeric(14,2) as target_amount
       from goals goal
       join goal_versions version on version.goal_id=goal.id and version.status='active'
       where goal.period_month=$1::date and goal.goal_level='department'
         and ($3::boolean or goal.org_unit_id=any($2::bigint[]))
       order by goal.org_unit_id,version.created_at desc,version.id desc
     ),active_sales_goals as (
       select goal.id::text as goal_id,version.amount::numeric(14,2) as target_amount
       from goals goal
       join goal_versions version on version.goal_id=goal.id and version.status='active'
       where $3::boolean and goal.period_month=$1::date and goal.goal_level='sales_manager'
     ),active_sales_goal as (
       select min(goal_id) as goal_id,min(target_amount) as target_amount
       from active_sales_goals
       having count(*)=1
     ),active_group_goals as (
       select distinct on (goal.org_unit_id,parent.org_unit_id)
              goal.id::text as goal_id,goal.org_unit_id,parent.org_unit_id as department_id,
              version.amount::numeric(14,2) as target_amount
       from goals goal
       join goals parent on parent.id=goal.parent_goal_id and parent.goal_level='department'
       join goal_versions version on version.goal_id=goal.id and version.status='active'
       where goal.period_month=$1::date and goal.goal_level='group'
         and ($3::boolean or parent.org_unit_id=any($2::bigint[]))
       order by goal.org_unit_id,parent.org_unit_id,version.created_at desc,version.id desc
     ),event_departments as (
       select distinct on (event.department_key)
              event.department_key,event.department_unit_id as id,
              case when event.department_unit_id is null
                   then coalesce(event.department_name,'未命名部门')||'（待补齐组织归属）'
                   else event.department_name end as name
       from scope_events event
       order by event.department_key,event.occurred_on desc,event.order_sequence desc,event.id desc
     ),department_candidates as (
       select event.department_key,event.id,event.name,1 as priority from event_departments event
       union all
       select 'id:'||goal.org_unit_id::text,goal.org_unit_id,unit.name,0
       from active_department_goals goal
       join org_units unit on unit.id=goal.org_unit_id
     ),selected_departments as (
       select distinct on (department_key) department_key,id,name
       from department_candidates
       order by department_key,priority desc
     ),event_groups as (
       select distinct on (event.department_key,event.group_key)
              event.department_key,event.department_unit_id as department_id,
              event.group_key,event.group_unit_id as id,
              case when event.group_unit_id is null
                   then coalesce(event.group_name,'未命名小组')||'（待补齐组织归属）'
                   else event.group_name end as name
       from scope_events event
       order by event.department_key,event.group_key,event.occurred_on desc,event.order_sequence desc,event.id desc
     ),group_candidates as (
       select event.department_key,event.department_id,event.group_key,event.id,event.name,1 as priority
       from event_groups event
       union all
       select 'id:'||goal.department_id::text,goal.department_id,
              'id:'||goal.org_unit_id::text,goal.org_unit_id,unit.name,0
       from active_group_goals goal
       join org_units unit on unit.id=goal.org_unit_id
     ),selected_groups as (
       select distinct on (department_key,group_key)
              department_key,department_id,group_key,id,name
       from group_candidates
       order by department_key,group_key,priority desc
     ),group_counts as (
       select department_key,count(*)::text as group_count
       from selected_groups
       group by department_key
     ),department_summaries as (
       select department.department_key,department.id::text as department_id,department.name as department_name,
              goal.goal_id,goal.target_amount::text,
              coalesce(sum(event.delta_amount),0)::numeric(14,2)::text as actual_amount,
              case when goal.target_amount>0
                   then (goal.target_amount-coalesce(sum(event.delta_amount),0))::numeric(14,2)::text
                   else null end as gap_amount,
              case when goal.target_amount>0
                   then round(coalesce(sum(event.delta_amount),0)*100/goal.target_amount,2)::text
                   else null end as achievement_rate,
              count(event.id)::text as event_count,
              coalesce(group_counts.group_count,'0') as group_count
       from selected_departments department
       left join active_department_goals goal on goal.org_unit_id=department.id
       left join group_counts on group_counts.department_key=department.department_key
       left join scope_events event on event.department_key=department.department_key
       group by department.department_key,department.id,department.name,goal.goal_id,goal.target_amount,group_counts.group_count
     ),group_summaries as (
       select selected.department_key,selected.department_id::text,department.name as department_name,
              selected.group_key,selected.id::text as group_id,selected.name as group_name,
              goal.goal_id,goal.target_amount::text,
              coalesce(sum(event.delta_amount),0)::numeric(14,2)::text as actual_amount,
              case when goal.target_amount>0
                   then (goal.target_amount-coalesce(sum(event.delta_amount),0))::numeric(14,2)::text
                   else null end as gap_amount,
              case when goal.target_amount>0
                   then round(coalesce(sum(event.delta_amount),0)*100/goal.target_amount,2)::text
                   else null end as achievement_rate,
              count(event.id)::text as event_count,
              count(distinct event.person_key)::text as member_count
       from selected_groups selected
       join selected_departments department on department.department_key=selected.department_key
       left join active_group_goals goal on goal.org_unit_id=selected.id
          and goal.department_id is not distinct from selected.department_id
       left join scope_events event on event.department_key=selected.department_key and event.group_key=selected.group_key
       group by selected.department_key,selected.department_id,department.name,
                selected.group_key,selected.id,selected.name,goal.goal_id,goal.target_amount
     ),event_rows as (
       select event.*,
              sum(event.delta_amount) over(
                partition by event.department_key,event.group_key,event.person_key
              )::numeric(14,2)::text as member_actual_amount,
              sum(event.delta_amount) over(
                partition by event.department_key,event.group_key,event.person_key,event.order_id
              )::numeric(14,2)::text as order_actual_amount
       from scope_events event
     )
     select (select goal_id from active_sales_goal) as goal_id,
             (select target_amount::text from active_sales_goal) as target_amount,
             ((select count(*) from active_sales_goals)>1) as target_ambiguous,
            coalesce((select sum(delta_amount) from scope_events),0)::numeric(14,2)::text as actual_amount,
            case when (select target_amount from active_sales_goal)>0
                 then ((select target_amount from active_sales_goal)-coalesce((select sum(delta_amount) from scope_events),0))::numeric(14,2)::text
                 else null end as gap_amount,
            case when (select target_amount from active_sales_goal)>0
                 then round(coalesce((select sum(delta_amount) from scope_events),0)*100/(select target_amount from active_sales_goal),2)::text
                 else null end as achievement_rate,
            (select count(*)::text from scope_events) as event_count,
            coalesce((select jsonb_agg(to_jsonb(summary) order by summary.department_name,summary.department_key)
                      from department_summaries summary),'[]'::jsonb) as departments,
            coalesce((select jsonb_agg(to_jsonb(summary) order by summary.department_name,summary.department_key,summary.group_name,summary.group_key)
                      from group_summaries summary),'[]'::jsonb) as groups,
            coalesce((select jsonb_agg(jsonb_build_object(
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
                'departmentKey',event.department_key,
                'departmentUnitId',event.department_unit_id::text,
                'groupKey',event.group_key,
                'groupUnitId',event.group_unit_id::text,
                'salespersonPersonId',event.salesperson_person_id::text,
                'salespersonName',event.salesperson_name,
                'personKey',event.person_key,
                'memberActualAmount',event.member_actual_amount,
                'orderActualAmount',event.order_actual_amount
              ) order by event.department_key,event.group_key,event.person_key,event.qingflow_order_no,event.order_id,
                         event.occurred_on,event.order_sequence,event.id)
              from event_rows event),'[]'::jsonb) as events`;

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
    const result = await loadFormalReport(db, request.currentUser, params.data.goalId, businessDate(clock()));
    if (!result.ok) return reply.code(result.statusCode).send(result.body);
    return result.report;
  });

  app.get("/api/performance/dashboard", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const parsed = dashboardQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "MONTH_INVALID", message: "月份格式无效" });
    const currentUser = request.currentUser;
    const today = businessDate(clock());
    const month = parsed.data.month ?? today.slice(0, 7);
    const client = await db.connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const access = await resolvePerformanceAccess(client, currentUser);
      if (!canReadPerformance(access)) {
        await client.query("rollback");
        return reply.code(403).send({ message: "当前角色没有业务查看权限" });
      }
      const scopeValues = performanceScopeValues(access);
      const ledGroupIds = currentUser.roles.includes("sales_leader")
        ? await loadLedGroupIds(client, currentUser.personId, today)
        : [];
      const canViewSalesAchievement = hasAnyRole(currentUser, SALES_ACHIEVEMENT_ROLES);
      const canViewDepartmentAchievement = hasAnyRole(currentUser, DEPARTMENT_ACHIEVEMENT_ROLES);
      const metrics = await client.query<{ total: string; event_count: string; negative_total: string }>(
        `select coalesce(sum(delta_amount),0)::text as total, count(*)::text as event_count,
                coalesce(sum(delta_amount) filter (where delta_amount < 0),0)::text as negative_total
         from performance_events e where accounting_month = $1 and ${performanceScopeSql("e", 2)}`, [`${month}-01`, ...scopeValues]);
      const monthly = await client.query<{ month: string; total: string }>(
        `select to_char(accounting_month, 'YYYY-MM') as month, sum(delta_amount)::text as total
         from performance_events e where extract(year from accounting_month) = extract(year from $1::date)
           and ${performanceScopeSql("e", 2)}
         group by accounting_month order by accounting_month`, [`${month}-01`, ...scopeValues]);
      const groups = await client.query<{ id: string; name: string; total: string }>(
        `select coalesce(e.group_unit_id::text,'legacy:'||e.group_name) as id,
                string_agg(distinct e.group_name,' / ' order by e.group_name) as name,
                sum(e.delta_amount)::text as total
         from performance_events e where e.accounting_month = $1 and ${performanceScopeSql("e", 2)}
         group by coalesce(e.group_unit_id::text,'legacy:'||e.group_name)
         order by sum(e.delta_amount) desc limit 5`, [`${month}-01`, ...scopeValues]);
      const recent = await client.query(
        `select o.qingflow_order_no as "orderNo", e.salesperson_name as "salespersonName",
                e.event_type as "eventType", to_char(e.accounting_month, 'YYYY-MM') as month,
                e.delta_amount::text as amount, e.group_name as "groupName"
         from performance_events e join performance_orders o on o.id = e.order_id
         where e.accounting_month=$1 and ${performanceScopeSql("e", 2)}
         order by e.created_at desc, e.id desc limit 8`, [`${month}-01`, ...scopeValues]);
      const pending = await client.query<{ count: string }>(
        `select count(*)::text as count from goal_versions v join goals g on g.id=v.goal_id
         where ${pendingGoalSql("g", "v", 1)}`,
        pendingGoalValues(currentUser),
      );
      const personalAchievement = currentUser.roles.some((role) => role === "salesperson" || role === "sales_leader" || role === "sales_supervisor")
        ? await loadPersonalAchievement(client, currentUser.personId, month, today)
        : null;
      const groupAchievements = await loadGroupAchievements(client, ledGroupIds, month, today);
      const organizationHierarchy = canViewDepartmentAchievement
        ? await loadOrganizationAchievementHierarchy(
          client,
          canViewSalesAchievement ? [] : access.departmentIds,
          canViewSalesAchievement,
          month,
          today,
        )
        : null;
      await client.query("commit");
      return {
        month,
        metrics: { total: metrics.rows[0]!.total, eventCount: Number(metrics.rows[0]!.event_count), negativeTotal: metrics.rows[0]!.negative_total, pendingApprovals: Number(pending.rows[0]!.count) },
        monthly: monthly.rows,
        groups: groups.rows,
        recent: recent.rows,
        personalAchievement,
        groupAchievements,
        departmentAchievements: organizationHierarchy?.departments.map(({ groups: _groups, ...department }) => department) ?? [],
        salesAchievement: organizationHierarchy?.salesAchievement ?? null,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/performance/personal-achievement/events", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!request.currentUser.roles.some((role) => role === "salesperson" || role === "sales_leader" || role === "sales_supervisor")) {
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
    return loadGroupAchievementDetails(db, groupId, periodMonth, today);
  });

  app.get("/api/performance/department-achievement/events", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!hasAnyRole(request.currentUser, DEPARTMENT_ACHIEVEMENT_ROLES)) {
      return reply.code(403).send({ code: "DEPARTMENT_SCOPE_FORBIDDEN", message: "当前角色没有部门目标达成查看权限" });
    }
    const parsed = departmentAchievementQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "DEPARTMENT_QUERY_INVALID", message: "部门或月份格式无效" });
    const today = businessDate(clock());
    const departmentId = String(parsed.data.departmentId);
    const canViewAll = hasAnyRole(request.currentUser, SALES_ACHIEVEMENT_ROLES);
    if (!canViewAll) {
      const access = await resolvePerformanceAccess(db, request.currentUser);
      if (!access.departmentIds.includes(departmentId)) {
        return reply.code(403).send({ code: "DEPARTMENT_SCOPE_FORBIDDEN", message: "只能查看当前明确负责的部门" });
      }
    }
    const periodMonth = parsed.data.month ?? today.slice(0, 7);
    const hierarchy = await loadOrganizationAchievementHierarchy(db, [departmentId], false, periodMonth, today);
    const department = hierarchy.departments.find((item) => item.departmentId === departmentId);
    if (!department) return reply.code(404).send({ code: "DEPARTMENT_NOT_FOUND", message: "部门不存在" });
    return department;
  });

  app.get("/api/performance/sales-achievement/events", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    if (!hasAnyRole(request.currentUser, SALES_ACHIEVEMENT_ROLES)) {
      return reply.code(403).send({ code: "SALES_SCOPE_FORBIDDEN", message: "当前角色没有销售组织目标达成查看权限" });
    }
    const parsed = dashboardQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "MONTH_INVALID", message: "月份格式无效" });
    const today = businessDate(clock());
    const periodMonth = parsed.data.month ?? today.slice(0, 7);
    const hierarchy = await loadOrganizationAchievementHierarchy(db, [], true, periodMonth, today);
    return { ...hierarchy.salesAchievement!, departments: hierarchy.departments };
  });

  app.get("/api/performance/orders", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const access = await resolvePerformanceAccess(db, request.currentUser);
    if (!canReadPerformance(access)) return reply.code(403).send({ message: "当前角色没有业务查看权限" });
    const query = orderListQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ message: "查询条件无效" });
    const filters = normalizeOrderFilters(query.data);
    const cursor = query.data.cursor ? decodeOrderCursor(query.data.cursor) : null;
    if (query.data.cursor && (!cursor || cursor.filterDigest !== orderFilterDigest(filters) || cursor.userId !== request.currentUser.id)) {
      return reply.code(400).send({ code: "ORDER_CURSOR_INVALID", message: "分页游标无效或已不适用于当前查询" });
    }
    const direction = cursor?.direction ?? "next";
    type OrderListRow = Record<string, unknown> & { id: string; __cursorCreatedAt: Date };
    const result = await db.query<OrderListRow>(
      `select id::text, created_at as "__cursorCreatedAt", qingflow_order_no as "orderNo", customer_name as "customerName",
              customer_unit as "customerUnit", performance_orders.salesperson_name as "salespersonName", service_type as "serviceType",
              source_received_on as "sourceReceivedOn", original_amount::text as "originalAmount",
              current_revenue::text as "currentRevenue", counted_amount::text as "countedAmount",
              lifecycle_state as "lifecycleState", posted_at as "postedAt",
              latest.department_name as "departmentName", latest.group_name as "groupName",
              latest.leader_name as "leaderName", latest.supervisor_name as "supervisorName"
       from performance_orders
       ${latestOrderEventJoinSql("performance_orders", "latest")}
       where ${performanceScopeSql("latest", 2)}
         and ${orderFilterSql("performance_orders", "latest", 6)}
         ${cursor ? `and (performance_orders.created_at,performance_orders.id)<=($14::timestamptz,$15::bigint)
         and (performance_orders.created_at,performance_orders.id)${direction === "next" ? "<" : ">"}($16::timestamptz,$17::bigint)` : ""}
       order by performance_orders.created_at ${direction === "previous" ? "asc" : "desc"},performance_orders.id ${direction === "previous" ? "asc" : "desc"}
       limit $1`,
      [
        ORDER_PAGE_SIZE + 1,
        ...performanceScopeValues(access),
        ...orderFilterValues(filters),
        ...(cursor ? [cursor.cutoffCreatedAt, cursor.cutoffId, cursor.anchorCreatedAt, cursor.anchorId] : []),
      ],
    );
    const hasExtra = result.rows.length > ORDER_PAGE_SIZE;
    const pageRows = result.rows.slice(0, ORDER_PAGE_SIZE);
    if (direction === "previous") pageRows.reverse();
    const cutoff = cursor ?? (pageRows[0] ? {
      cutoffCreatedAt: pageRows[0].__cursorCreatedAt.toISOString(),
      cutoffId: pageRows[0].id,
    } : null);
    const makeCursor = (cursorDirection: OrderCursor["direction"], anchor: OrderListRow): string => encodeOrderCursor({
      version: 2,
      direction: cursorDirection,
      anchorCreatedAt: anchor.__cursorCreatedAt.toISOString(),
      anchorId: anchor.id,
      cutoffCreatedAt: cutoff!.cutoffCreatedAt,
      cutoffId: cutoff!.cutoffId,
      filterDigest: orderFilterDigest(filters),
      userId: request.currentUser!.id,
    });
    const first = pageRows[0];
    const last = pageRows.at(-1);
    const previousCursor = first && cursor && (cursor.direction === "next" || hasExtra) ? makeCursor("previous", first) : null;
    const nextCursor = last && (cursor?.direction === "previous" || hasExtra) ? makeCursor("next", last) : null;
    return {
      orders: pageRows.map(({ __cursorCreatedAt: _createdAt, ...order }) => order),
      previousCursor,
      nextCursor,
      pageSize: ORDER_PAGE_SIZE,
    };
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
              dimensions.business_region_code as "businessRegionCode",
              dimensions.business_region_source_text as "businessRegionSourceText",
              dimensions.customer_unit as "customerUnit",
              actor.display_name as "actorName", e.created_at as "createdAt",
              o.lifecycle_state as "lifecycleState",
              case when e.event_type='legacy_adjustment' then null
                   when e.event_type='pause' then 'paused'
                   when e.event_type in ('restart','first_include') then 'active'
                   when e.resulting_current_revenue>0 then 'active' else 'zero' end as "resultingLifecycleState"
       from performance_events e join performance_orders o on o.id=e.order_id
       left join performance_event_analysis_dimensions dimensions on dimensions.event_id=e.id
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
        [input.orderNo, input.customerName, input.customerUnit, input.businessRegionSourceText, input.businessRegionCode,
         organization.personId, organization.salespersonName, input.serviceType || null, input.sourceReceivedOn,
         input.amount, decision.next.currentRevenue, decision.next.countedAmount, decision.next.lifecycle, request.currentUser!.id],
      );
      const orderId = order.rows[0]!.id;
      const event = await client.query<{id:string}>(
        `insert into performance_events
          (order_id, event_type, delta_amount, resulting_current_revenue, resulting_counted_amount,
           accounting_month, occurred_on, reason, salesperson_name, department_name, group_name,
           leader_name, supervisor_name, created_by, salesperson_person_id, department_unit_id,
           group_unit_id, leader_person_id, supervisor_person_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         returning id::text`,
        [orderId, decision.eventType, decision.deltaAmount, decision.next.currentRevenue,
         decision.next.countedAmount, accountingMonth(input.sourceReceivedOn), input.sourceReceivedOn, input.reason,
         organization.salespersonName, organization.departmentName, organization.groupName, organization.leaderName,
         organization.supervisorName, request.currentUser!.id, organization.personId, organization.departmentId,
         organization.groupId, organization.leaderPersonId, organization.supervisorPersonId],
      );
      await recordEventAnalysisDimensions(client,event.rows[0]!.id,{
        businessRegionCode:input.businessRegionCode,
        businessRegionSourceText:input.businessRegionSourceText,
        customerUnit:input.customerUnit,
      });
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
        `select id::text, qingflow_order_no, customer_name, customer_unit, business_region_source_text, business_region_code,
                salesperson_person_id::text, salesperson_name, service_type,
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
      if(!correction&&(!order.business_region_code||!order.business_region_source_text)){
        await client.query("rollback");
        return reply.code(409).send({message:"订单分析维度尚未取得可信来源，不能执行调整"});
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
      await recordEventAnalysisDimensions(client,inserted.rows[0]!.id,{
        businessRegionCode:correction?.businessRegionCode??order.business_region_code!,
        businessRegionSourceText:correction?.businessRegionSourceText??order.business_region_source_text!,
        customerUnit:correction?.customerUnit??order.customer_unit,
      });
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
