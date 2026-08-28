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
    const scopeValues = performanceScopeValues(access);
    const latest = await db.query<{ month: string | null }>(
      `select max(accounting_month)::text as month from performance_events e where ${performanceScopeSql("e", 1)}`,
      scopeValues,
    );
    const month = latest.rows[0]?.month ?? new Date().toISOString().slice(0, 7) + "-01";
    const [metrics, monthly, groups, recent, pending] = await Promise.all([
      db.query<{ total: string; event_count: string; negative_total: string }>(
        `select coalesce(sum(delta_amount),0)::text as total, count(*)::text as event_count,
                coalesce(sum(delta_amount) filter (where delta_amount < 0),0)::text as negative_total
         from performance_events e where accounting_month = $1 and ${performanceScopeSql("e", 2)}`, [month, ...scopeValues]),
      db.query<{ month: string; total: string }>(
        `select to_char(accounting_month, 'YYYY-MM') as month, sum(delta_amount)::text as total
         from performance_events e where extract(year from accounting_month) = extract(year from $1::date)
           and ${performanceScopeSql("e", 2)}
         group by accounting_month order by accounting_month`, [month, ...scopeValues]),
      db.query<{ name: string; total: string }>(
        `select group_name as name, sum(delta_amount)::text as total
         from performance_events e where accounting_month = $1 and ${performanceScopeSql("e", 2)} group by group_name
         order by sum(delta_amount) desc limit 5`, [month, ...scopeValues]),
      db.query(
        `select o.qingflow_order_no as "orderNo", e.salesperson_name as "salespersonName",
                e.event_type as "eventType", to_char(e.accounting_month, 'YYYY-MM') as month,
                e.delta_amount::text as amount, e.group_name as "groupName"
         from performance_events e join performance_orders o on o.id = e.order_id
         where ${performanceScopeSql("e", 1)}
         order by e.created_at desc, e.id desc limit 8`, scopeValues),
      db.query<{ count: string }>(
        `select count(*)::text as count from goal_versions v join goals g on g.id=v.goal_id
         where ${pendingGoalSql("g", "v", 1)}`,
        pendingGoalValues(request.currentUser),
      ),
    ]);
    return {
      month: month.slice(0, 7),
      metrics: { total: metrics.rows[0]!.total, eventCount: Number(metrics.rows[0]!.event_count), negativeTotal: metrics.rows[0]!.negative_total, pendingApprovals: Number(pending.rows[0]!.count) },
      monthly: monthly.rows,
      groups: groups.rows,
      recent: recent.rows,
    };
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
