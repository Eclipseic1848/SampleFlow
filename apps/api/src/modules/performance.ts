import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import {
  decidePerformanceEvent,
  PerformanceRuleError,
  type PerformanceCommand,
  type PerformanceState,
} from "../domain/performance.js";
import { hasAnyRole, PERFORMANCE_EDITOR_ROLES } from "./auth.js";

const moneySchema = z.number().finite().min(0).max(99_999_999_999.99);
const dateSchema = z.iso.date();

const createOrderSchema = z.object({
  orderNo: z.string().trim().min(1).max(100),
  customerName: z.string().trim().min(1).max(200),
  customerUnit: z.string().trim().min(1).max(300),
  salespersonName: z.string().trim().min(1).max(100),
  serviceType: z.string().trim().max(200).optional().default(""),
  sourceReceivedOn: dateSchema,
  amount: moneySchema,
  departmentName: z.string().trim().min(1).max(100),
  groupName: z.string().trim().min(1).max(100),
  leaderName: z.string().trim().max(100).optional().default(""),
  supervisorName: z.string().trim().max(100).optional().default(""),
  reason: z.string().trim().max(500).optional().default("首次录入"),
});

const eventBase = { occurredOn: dateSchema, reason: z.string().trim().min(1).max(500), departmentName:z.string().trim().min(1).max(100), groupName:z.string().trim().min(1).max(100), leaderName:z.string().trim().max(100).optional().default(""), supervisorName:z.string().trim().max(100).optional().default("") };
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("revenue_change"), newAmount: moneySchema, ...eventBase }),
  z.object({ type: z.literal("pause"), ...eventBase }),
  z.object({ type: z.literal("restart"), ...eventBase }),
  z.object({ type: z.literal("first_include"), amount: moneySchema.positive(), ...eventBase }),
]);

type OrderRow = {
  id: string;
  qingflow_order_no: string;
  customer_name: string;
  customer_unit: string;
  salesperson_name: string;
  service_type: string | null;
  source_received_on: string;
  original_amount: string;
  current_revenue: string;
  counted_amount: string;
  lifecycle_state: PerformanceState["lifecycle"];
};

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function commandFromBody(body: z.infer<typeof eventSchema>): PerformanceCommand {
  if (body.type === "revenue_change") return { type: body.type, newAmount: body.newAmount };
  if (body.type === "first_include") return { type: body.type, amount: body.amount };
  return { type: body.type };
}

function requireEditor(request: { currentUser: import("./auth.js").CurrentUser | null }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
  if (!hasAnyRole(request.currentUser, PERFORMANCE_EDITOR_ROLES)) return reply.code(403).send({ message: "仅销售助理及销售助理组长可编辑业绩" });
  return null;
}

export async function registerPerformance(app: FastifyInstance) {
  app.get("/api/performance/dashboard", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const latest = await db.query<{ month: string | null }>("select max(accounting_month)::text as month from performance_events");
    const month = latest.rows[0]?.month ?? new Date().toISOString().slice(0, 7) + "-01";
    const [metrics, monthly, groups, recent, pending] = await Promise.all([
      db.query<{ total: string; event_count: string; negative_total: string }>(
        `select coalesce(sum(delta_amount),0)::text as total, count(*)::text as event_count,
                coalesce(sum(delta_amount) filter (where delta_amount < 0),0)::text as negative_total
         from performance_events where accounting_month = $1`, [month]),
      db.query<{ month: string; total: string }>(
        `select to_char(accounting_month, 'YYYY-MM') as month, sum(delta_amount)::text as total
         from performance_events where extract(year from accounting_month) = extract(year from $1::date)
         group by accounting_month order by accounting_month`, [month]),
      db.query<{ name: string; total: string }>(
        `select group_name as name, sum(delta_amount)::text as total
         from performance_events where accounting_month = $1 group by group_name
         order by sum(delta_amount) desc limit 5`, [month]),
      db.query(
        `select o.qingflow_order_no as "orderNo", e.salesperson_name as "salespersonName",
                e.event_type as "eventType", to_char(e.accounting_month, 'YYYY-MM') as month,
                e.delta_amount::text as amount, e.group_name as "groupName"
         from performance_events e join performance_orders o on o.id = e.order_id
         order by e.created_at desc, e.id desc limit 8`),
      db.query<{ count: string }>("select count(*)::text as count from goal_versions where status in ('pending_signature','pending_gm','pending_hr')"),
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
    const query = z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ message: "查询条件无效" });
    const term = query.data.search ? `%${query.data.search}%` : null;
    const result = await db.query(
      `select id::text, qingflow_order_no as "orderNo", customer_name as "customerName",
              customer_unit as "customerUnit", salesperson_name as "salespersonName", service_type as "serviceType",
              source_received_on as "sourceReceivedOn", original_amount::text as "originalAmount",
              current_revenue::text as "currentRevenue", counted_amount::text as "countedAmount",
              lifecycle_state as "lifecycleState", posted_at as "postedAt",
              latest.department_name as "departmentName", latest.group_name as "groupName",
              latest.leader_name as "leaderName", latest.supervisor_name as "supervisorName"
       from performance_orders
       left join lateral (select department_name,group_name,leader_name,supervisor_name from performance_events where order_id=performance_orders.id order by occurred_on desc,id desc limit 1) latest on true
       where ($1::text is null or qingflow_order_no ilike $1 or salesperson_name ilike $1 or customer_name ilike $1)
       order by posted_at desc nulls last, id desc limit $2`,
      [term, query.data.limit],
    );
    return { orders: result.rows };
  });

  app.get("/api/performance/orders/:id/events", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "订单标识无效" });
    const result = await db.query(
      `select id::text, event_type as "eventType", delta_amount::text as "deltaAmount",
              resulting_current_revenue::text as "resultingCurrentRevenue",
              resulting_counted_amount::text as "resultingCountedAmount", accounting_month as "accountingMonth",
              occurred_on as "occurredOn", reason, salesperson_name as "salespersonName",
              department_name as "departmentName", group_name as "groupName", created_at as "createdAt"
       from performance_events where order_id = $1 order by occurred_on, id`,
      [params.data.id],
    );
    return { events: result.rows };
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
      const order = await client.query<{ id: string }>(
        `insert into performance_orders
          (qingflow_order_no, customer_name, customer_unit, salesperson_name, service_type, source_received_on,
           original_amount, current_revenue, counted_amount, lifecycle_state, created_by, posted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) returning id::text`,
        [input.orderNo, input.customerName, input.customerUnit, input.salespersonName, input.serviceType || null,
         input.sourceReceivedOn, input.amount, decision.next.currentRevenue, decision.next.countedAmount,
         decision.next.lifecycle, request.currentUser!.id],
      );
      const orderId = order.rows[0]!.id;
      await client.query(
        `insert into performance_events
          (order_id, event_type, delta_amount, resulting_current_revenue, resulting_counted_amount,
           accounting_month, occurred_on, reason, salesperson_name, department_name, group_name,
           leader_name, supervisor_name, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [orderId, decision.eventType, decision.deltaAmount, decision.next.currentRevenue,
         decision.next.countedAmount, monthStart(input.sourceReceivedOn), input.sourceReceivedOn, input.reason,
         input.salespersonName, input.departmentName, input.groupName, input.leaderName || null,
         input.supervisorName || null, request.currentUser!.id],
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
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/performance/orders/:id/events", async (request, reply) => {
    const denied = requireEditor(request, reply);
    if (denied) return denied;
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const parsed = eventSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "调整信息不完整或格式无效" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const found = await client.query<OrderRow>(
        `select id::text, qingflow_order_no, customer_name, customer_unit, salesperson_name, service_type,
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
      const state: PerformanceState = {
        currentRevenue: Number(order.current_revenue),
        countedAmount: Number(order.counted_amount),
        lifecycle: order.lifecycle_state,
      };
      const decision = decidePerformanceEvent(state, commandFromBody(parsed.data));
      await client.query(
        `insert into performance_events
          (order_id, event_type, delta_amount, resulting_current_revenue, resulting_counted_amount,
           accounting_month, occurred_on, reason, salesperson_name, department_name, group_name,
           leader_name, supervisor_name, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [params.data.id, decision.eventType, decision.deltaAmount, decision.next.currentRevenue,
         decision.next.countedAmount, monthStart(parsed.data.occurredOn), parsed.data.occurredOn,
         parsed.data.reason, order.salesperson_name, parsed.data.departmentName, parsed.data.groupName,
         parsed.data.leaderName || null, parsed.data.supervisorName || null, request.currentUser!.id],
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
      await client.query("commit");
      return reply.code(201).send({ eventType: decision.eventType, deltaAmount: decision.deltaAmount, state: decision.next });
    } catch (error) {
      await client.query("rollback");
      if (error instanceof PerformanceRuleError) return reply.code(409).send({ message: error.message });
      throw error;
    } finally {
      client.release();
    }
  });
}
