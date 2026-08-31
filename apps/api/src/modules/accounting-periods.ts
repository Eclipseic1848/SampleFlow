import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "../db.js";
import { standardBusinessRegionName } from "../domain/business-regions.js";
import { businessDate } from "../domain/business-time.js";
import { hasAnyRole, type CurrentUser } from "./auth.js";
import { recordEventAnalysisDimensions } from "./event-analysis-dimensions.js";
import { OrganizationResolutionError, resolveOrganization } from "./organization.js";

const monthParamSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });
const noteSchema = z.strictObject({ note: z.string().trim().min(1).max(500) });
const correctionSchema = z.strictObject({
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
  orderId: z.coerce.number().int().positive(),
  eventType: z.enum(["revenue_change", "pause", "restart", "first_include"]),
  occurredOn: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
  businessRegionCode: z.string().refine((value) => standardBusinessRegionName(value) !== undefined, "必须选择标准业务区域"),
  businessRegionSourceText: z.string().trim().min(1).max(100),
  customerUnit: z.string().trim().min(1).max(300),
  analysisDimensionEvidence: z.string().trim().min(1).max(1000),
});
const idSchema = z.object({ id: z.coerce.number().int().positive() });
const correctionListSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "consumed", "revoked"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const reviewSchema = z.strictObject({
  orderId: z.coerce.number().int().positive(),
  lifecycleState: z.enum(["active", "paused", "zero"]),
  currentRevenue: z.number().finite().min(0).max(99_999_999_999.99),
  conclusion: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(1000),
  reason: z.string().trim().min(1).max(500),
}).superRefine((value, context) => {
  if (value.lifecycleState === "zero" && value.currentRevenue !== 0) {
    context.addIssue({ code: "custom", message: "零金额状态的当前营业额必须为零", path: ["currentRevenue"] });
  }
  if (value.lifecycleState !== "zero" && value.currentRevenue <= 0) {
    context.addIssue({ code: "custom", message: "活动或暂停状态的当前营业额必须大于零", path: ["currentRevenue"] });
  }
});
const reviewListSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export class AccountingPeriodError extends Error {}

export type ApprovedCorrection = Readonly<{
  id: string;
  periodMonth: string;
  occurredOn: string;
  businessRegionCode: string;
  businessRegionSourceText: string;
  customerUnit: string;
}>;

type PeriodRow = {
  status: "open" | "closed";
  verification_confirmed_by_user_id: string | null;
  verification_confirmed_by_person_id: string | null;
  version: number;
  needs_reclose: boolean;
};
type QueryClient = Pick<PoolClient, "query">;

export function accountingMonth(date: string): string { return `${date.slice(0, 7)}-01`; }
function normalizeMonth(month: string): string { return `${month}-01`; }

function requireRole(user: CurrentUser | null, roles: readonly string[], message: string): { statusCode: 401 | 403; message: string } | null {
  if (!user) return { statusCode: 401, message: "尚未登录" };
  if (!hasAnyRole(user, roles)) return { statusCode: 403, message };
  return null;
}

async function writeAudit(client: PoolClient, actorUserId: string, action: string, entityType: string, entityId: string, afterData: unknown, ipAddress: string) {
  await client.query(
    `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address)
     values($1,$2,$3,$4,$5,$6)`,
    [actorUserId, action, entityType, entityId, JSON.stringify(afterData), ipAddress],
  );
}

async function lockAccountingPeriod(client: QueryClient, month: string): Promise<PeriodRow> {
  await client.query("insert into accounting_periods(period_month) values($1) on conflict do nothing", [month]);
  const result = await client.query<PeriodRow>(
    `select status,verification_confirmed_by_user_id::text,verification_confirmed_by_person_id::text,version,needs_reclose
     from accounting_periods where period_month=$1 for update`,
    [month],
  );
  return result.rows[0]!;
}

export async function assertAccountingPeriodOpen(client: QueryClient, month: string): Promise<void> {
  const period = await lockAccountingPeriod(client, month);
  if (period.status === "closed") throw new AccountingPeriodError(`记账期间已关闭：${month.slice(0, 7)}`);
}

export async function lockApprovedCorrection(client: PoolClient, correctionRequestId: number, orderId: number, eventType: string, actorPersonId: string, now: Date): Promise<ApprovedCorrection> {
  const result = await client.query<{
    id: string; period_month: string; occurred_on: string; status: string; expires_at: Date | null;
    reviewed_by_person_id: string | null; business_region_code: string | null;
    business_region_source_text: string | null; customer_unit: string | null;
  }>(
    `select request_row.id::text,request_row.period_month::text,request_row.occurred_on::text,
            request_row.status,request_row.expires_at,request_row.reviewed_by_person_id::text,
            request_row.business_region_code,request_row.business_region_source_text,request_row.customer_unit
     from accounting_correction_requests request_row
     join accounting_periods period on period.period_month=request_row.period_month
     where request_row.id=$1 and request_row.order_id=$2 and request_row.event_type=$3
     for update of request_row,period`,
    [correctionRequestId, orderId, eventType],
  );
  const correction = result.rows[0];
  if (!correction) throw new AccountingPeriodError("更正申请不存在或范围不匹配");
  if (correction.status !== "approved") throw new AccountingPeriodError("更正申请不是可执行状态");
  if (correction.reviewed_by_person_id === actorPersonId) throw new AccountingPeriodError("审批人与执行人必须是不同人员");
  if (!correction.expires_at || correction.expires_at.getTime() <= now.getTime()) throw new AccountingPeriodError("更正批准已过期");
  if (!correction.business_region_code || !correction.business_region_source_text || !correction.customer_unit) {
    throw new AccountingPeriodError("更正申请缺少事件发生时分析维度证据");
  }
  return {
    id: correction.id,
    periodMonth: correction.period_month,
    occurredOn: correction.occurred_on,
    businessRegionCode: correction.business_region_code,
    businessRegionSourceText: correction.business_region_source_text,
    customerUnit: correction.customer_unit,
  };
}

export async function consumeApprovedCorrection(client: PoolClient, correction: ApprovedCorrection, actorUserId: string, actorPersonId: string, eventId: string, now: Date, ipAddress: string): Promise<void> {
  const consumed = await client.query(
    `update accounting_correction_requests
     set status='consumed',consumed_by_user_id=$2,consumed_by_person_id=$3,consumed_at=$4,consumed_event_id=$5
     where id=$1 and status='approved'`,
    [correction.id, actorUserId, actorPersonId, now, eventId],
  );
  if (consumed.rowCount !== 1) throw new AccountingPeriodError("更正申请已被消费");
  await client.query(
    `update accounting_periods
     set needs_reclose=true,verification_confirmed_by_user_id=null,verification_confirmed_by_person_id=null,
         verification_confirmed_at=null,verification_note=null,updated_at=$2 where period_month=$1`,
    [correction.periodMonth, now],
  );
  await writeAudit(client, actorUserId, "accounting.correction_consumed", "accounting_correction", correction.id, { eventId }, ipAddress);
}

export async function registerAccountingPeriods(app: FastifyInstance, db: Database, clock: () => Date = () => new Date()) {
  app.get("/api/accounting-periods", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["sales_assistant_leader", "hr"], "仅销售助理组长或人事可查看记账期间");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(36).default(18) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "查询条件无效" });
    const result = await db.query(
      `select period.period_month::text as "periodMonth",period.status,period.version,
              period.needs_reclose as "needsReclose",period.verification_confirmed_at as "verifiedAt",
              verifier.display_name as "verifiedBy",period.closed_at as "closedAt",closer.display_name as "closedBy"
       from accounting_periods period
       left join people verifier on verifier.id=period.verification_confirmed_by_person_id
       left join people closer on closer.id=period.closed_by_person_id
       order by period.period_month desc limit $1`,
      [parsed.data.limit],
    );
    return { periods: result.rows };
  });

  app.get("/api/accounting-corrections", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["sales_assistant_leader", "hr"], "仅销售助理组长或人事可查看更正申请");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const parsed = correctionListSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "查询条件无效" });
    const result = await db.query(
      `select request_row.id::text,request_row.period_month::text as "periodMonth",request_row.order_id::text as "orderId",
              orders.qingflow_order_no as "orderNo",request_row.event_type as "eventType",
              request_row.occurred_on::text as "occurredOn",request_row.reason,request_row.status,
              request_row.business_region_code as "businessRegionCode",
              request_row.business_region_source_text as "businessRegionSourceText",
              request_row.customer_unit as "customerUnit",
              request_row.analysis_dimension_evidence as "analysisDimensionEvidence",
              request_row.requested_at as "requestedAt",requester.display_name as "requestedBy",
              reviewer.display_name as "reviewedBy",request_row.review_note as "reviewNote",request_row.expires_at as "expiresAt"
       from accounting_correction_requests request_row
       join performance_orders orders on orders.id=request_row.order_id
       join people requester on requester.id=request_row.requested_by_person_id
       left join people reviewer on reviewer.id=request_row.reviewed_by_person_id
       where ($1::text is null or request_row.status=$1)
       order by request_row.requested_at desc limit $2`,
      [parsed.data.status ?? null, parsed.data.limit],
    );
    return { corrections: result.rows };
  });

  app.post("/api/accounting-periods/:month/confirm-close", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["sales_assistant_leader"], "仅销售助理组长可确认月度核对");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const params = monthParamSchema.safeParse(request.params);
    const body = noteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "记账月份或核对说明无效" });
    const now = clock();
    const periodMonth = normalizeMonth(params.data.month);
    if (periodMonth >= accountingMonth(businessDate(now))) return reply.code(409).send({ message: "只能核对已结束的记账月份" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const period = await lockAccountingPeriod(client, periodMonth);
      if (period.status === "closed" && !period.needs_reclose) {
        await client.query("rollback");
        return reply.code(409).send({ message: "记账期间已经关闭" });
      }
      await client.query(
        `update accounting_periods set verification_confirmed_by_user_id=$2,verification_confirmed_by_person_id=$3,
          verification_confirmed_at=$4,verification_note=$5,updated_at=$4 where period_month=$1`,
        [periodMonth, request.currentUser!.id, request.currentUser!.personId, now, body.data.note],
      );
      await writeAudit(client, request.currentUser!.id, "accounting.period_verified", "accounting_period", periodMonth, body.data, request.ip);
      await client.query("commit");
      return { periodMonth, status: period.status, verified: true };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/accounting-periods/:month/close", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["hr"], "仅人事可关闭记账期间");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const params = monthParamSchema.safeParse(request.params);
    const body = noteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "记账月份或关闭说明无效" });
    const now = clock();
    const periodMonth = normalizeMonth(params.data.month);
    if (periodMonth >= accountingMonth(businessDate(now))) return reply.code(409).send({ message: "只能关闭已结束的记账月份" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const period = await lockAccountingPeriod(client, periodMonth);
      if (!period.verification_confirmed_by_person_id || !period.verification_confirmed_by_user_id) {
        await client.query("rollback");
        return reply.code(409).send({ message: "关闭前必须由销售助理组长确认核对" });
      }
      if (period.verification_confirmed_by_person_id === request.currentUser!.personId) {
        await client.query("rollback");
        return reply.code(409).send({ message: "核对人与关闭人必须是不同人员" });
      }
      if (period.status === "closed" && !period.needs_reclose) {
        await client.query("rollback");
        return reply.code(409).send({ message: "记账期间已经关闭" });
      }
      const totals = await client.query<{ event_count: string; total_amount: string }>(
        "select count(*)::text as event_count,coalesce(sum(delta_amount),0)::text as total_amount from performance_events where accounting_month=$1",
        [periodMonth],
      );
      const version = period.version + 1;
      await client.query(
        `insert into accounting_period_closures
          (period_month,version,event_count,total_amount,confirmed_by_user_id,confirmed_by_person_id,
           closed_by_user_id,closed_by_person_id,closed_at,note)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [periodMonth, version, totals.rows[0]!.event_count, totals.rows[0]!.total_amount,
         period.verification_confirmed_by_user_id, period.verification_confirmed_by_person_id,
         request.currentUser!.id, request.currentUser!.personId, now, body.data.note],
      );
      await client.query(
        `update accounting_periods set status='closed',closed_by_user_id=$2,closed_by_person_id=$3,
          closed_at=$4,close_note=$5,version=$6,needs_reclose=false,updated_at=$4 where period_month=$1`,
        [periodMonth, request.currentUser!.id, request.currentUser!.personId, now, body.data.note, version],
      );
      await writeAudit(client, request.currentUser!.id, "accounting.period_closed", "accounting_period", periodMonth, { version, ...totals.rows[0] }, request.ip);
      await client.query("commit");
      return { periodMonth, status: "closed", version };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/accounting-corrections", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["sales_assistant_leader"], "仅销售助理组长可申请历史更正");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const parsed = correctionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "更正申请信息无效" });
    const input = parsed.data;
    const periodMonth = normalizeMonth(input.periodMonth);
    if (accountingMonth(input.occurredOn) !== periodMonth) return reply.code(400).send({ message: "更正业务日期必须属于申请月份" });
    const now = clock();
    const client = await db.connect();
    try {
      await client.query("begin");
      const period = await lockAccountingPeriod(client, periodMonth);
      if (period.status !== "closed") {
        await client.query("rollback");
        return reply.code(409).send({ message: "仅已关闭期间需要受控更正申请" });
      }
      const order = await client.query("select 1 from performance_orders where id=$1", [input.orderId]);
      if (!order.rowCount) { await client.query("rollback"); return reply.code(404).send({ message: "订单不存在" }); }
      const created = await client.query<{ id: string }>(
        `insert into accounting_correction_requests
          (period_month,order_id,event_type,occurred_on,reason,business_region_code,
           business_region_source_text,customer_unit,analysis_dimension_evidence,
           requested_by_user_id,requested_by_person_id,requested_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id::text`,
        [periodMonth, input.orderId, input.eventType, input.occurredOn, input.reason,
         input.businessRegionCode, input.businessRegionSourceText, input.customerUnit,
         input.analysisDimensionEvidence, request.currentUser!.id, request.currentUser!.personId, now],
      );
      const id = created.rows[0]!.id;
      await writeAudit(client, request.currentUser!.id, "accounting.correction_requested", "accounting_correction", id, input, request.ip);
      await client.query("commit");
      return reply.code(201).send({ id, status: "pending" });
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ message: "该订单在本期间已有待处理更正申请" });
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/accounting-corrections/:id/approve", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["hr"], "仅人事可审批历史更正");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const params = idSchema.safeParse(request.params);
    const body = noteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "审批信息无效" });
    const now = clock();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const client = await db.connect();
    try {
      await client.query("begin");
      const pending = await client.query<{ requested_by_person_id: string; status: string; analysis_dimensions_required: boolean; business_region_code: string | null }>(
        `select requested_by_person_id::text,status,analysis_dimensions_required,business_region_code
         from accounting_correction_requests where id=$1 for update`, [params.data.id],
      );
      const row = pending.rows[0];
      if (!row) { await client.query("rollback"); return reply.code(404).send({ message: "更正申请不存在" }); }
      if (row.status !== "pending") { await client.query("rollback"); return reply.code(409).send({ message: "更正申请已处理" }); }
      if (!row.analysis_dimensions_required || !row.business_region_code) {
        await client.query("rollback");
        return reply.code(409).send({ message: "旧更正申请缺少事件发生时分析维度证据，请重新提交" });
      }
      if (row.requested_by_person_id === request.currentUser!.personId) {
        await client.query("rollback");
        return reply.code(409).send({ message: "申请人与审批人必须是不同人员" });
      }
      await client.query(
        `update accounting_correction_requests set status='approved',reviewed_by_user_id=$2,
         reviewed_by_person_id=$3,reviewed_at=$4,review_note=$5,expires_at=$6 where id=$1`,
        [params.data.id, request.currentUser!.id, request.currentUser!.personId, now, body.data.note, expiresAt],
      );
      await writeAudit(client, request.currentUser!.id, "accounting.correction_approved", "accounting_correction", String(params.data.id), { expiresAt, note: body.data.note }, request.ip);
      await client.query("commit");
      return { id: String(params.data.id), status: "approved", expiresAt };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/accounting-corrections/:id/reject", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["hr"], "仅人事可审批历史更正");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const params = idSchema.safeParse(request.params);
    const body = noteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "驳回信息无效" });
    const now = clock();
    const client = await db.connect();
    try {
      await client.query("begin");
      const rejected = await client.query(
        `update accounting_correction_requests set status='rejected',reviewed_by_user_id=$2,
         reviewed_by_person_id=$3,reviewed_at=$4,review_note=$5
         where id=$1 and status='pending' and requested_by_person_id<>$3`,
        [params.data.id, request.currentUser!.id, request.currentUser!.personId, now, body.data.note],
      );
      if (!rejected.rowCount) { await client.query("rollback"); return reply.code(409).send({ message: "更正申请不存在、已处理或不满足职责分离" }); }
      await writeAudit(client, request.currentUser!.id, "accounting.correction_rejected", "accounting_correction", String(params.data.id), body.data, request.ip);
      await client.query("commit");
      return { id: String(params.data.id), status: "rejected" };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/accounting-corrections/:id/revoke", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["hr"], "仅人事可撤销历史更正授权");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const params = idSchema.safeParse(request.params);
    const body = noteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "撤销信息无效" });
    const now = clock();
    const client = await db.connect();
    try {
      await client.query("begin");
      const revoked = await client.query(
        `update accounting_correction_requests set status='revoked',reviewed_by_user_id=$2,
         reviewed_by_person_id=$3,reviewed_at=$4,review_note=$5,expires_at=$4 where id=$1 and status='approved'`,
        [params.data.id, request.currentUser!.id, request.currentUser!.personId, now, body.data.note],
      );
      if (!revoked.rowCount) { await client.query("rollback"); return reply.code(409).send({ message: "更正授权不存在或已失效" }); }
      await writeAudit(client, request.currentUser!.id, "accounting.correction_revoked", "accounting_correction", String(params.data.id), body.data, request.ip);
      await client.query("commit");
      return { id: String(params.data.id), status: "revoked" };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });

  app.get("/api/historical-order-reviews", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["sales_assistant_leader", "hr"], "仅销售助理组长或人事可查看历史核对");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const parsed = reviewListSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "查询条件无效" });
    const result = await db.query(
      `select review.id::text,review.order_id::text as "orderId",orders.qingflow_order_no as "orderNo",
              review.proposed_lifecycle_state as "lifecycleState",review.proposed_current_revenue::text as "currentRevenue",
              review.conclusion,review.evidence,review.reason,review.status,review.requested_at as "requestedAt",
              requester.display_name as "requestedBy",reviewer.display_name as "reviewedBy",review.review_note as "reviewNote"
       from historical_order_reviews review
       join performance_orders orders on orders.id=review.order_id
       join people requester on requester.id=review.requested_by_person_id
       left join people reviewer on reviewer.id=review.reviewed_by_person_id
       where ($1::text is null or review.status=$1)
       order by review.requested_at desc limit $2`,
      [parsed.data.status ?? null, parsed.data.limit],
    );
    return { reviews: result.rows };
  });

  app.post("/api/historical-order-reviews", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["sales_assistant_leader"], "仅销售助理组长可提交历史核对");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const parsed = reviewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "历史核对信息无效", issues: parsed.error.issues });
    const now = clock();
    const client = await db.connect();
    try {
      await client.query("begin");
      const order = await client.query<{ lifecycle_state: string }>("select lifecycle_state from performance_orders where id=$1 for update", [parsed.data.orderId]);
      if (!order.rows[0]) { await client.query("rollback"); return reply.code(404).send({ message: "订单不存在" }); }
      if (order.rows[0].lifecycle_state !== "historical_review_required") {
        await client.query("rollback");
        return reply.code(409).send({ message: "该订单不处于历史待核状态" });
      }
      const created = await client.query<{ id: string }>(
        `insert into historical_order_reviews
          (order_id,proposed_lifecycle_state,proposed_current_revenue,conclusion,evidence,reason,
           requested_by_user_id,requested_by_person_id,requested_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id::text`,
        [parsed.data.orderId, parsed.data.lifecycleState, parsed.data.currentRevenue, parsed.data.conclusion,
         parsed.data.evidence, parsed.data.reason, request.currentUser!.id, request.currentUser!.personId, now],
      );
      const id = created.rows[0]!.id;
      await writeAudit(client, request.currentUser!.id, "performance.historical_review_requested", "historical_order_review", id, parsed.data, request.ip);
      await client.query("commit");
      return reply.code(201).send({ id, status: "pending" });
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ message: "该订单已有待审批的历史核对" });
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/historical-order-reviews/:id/approve", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["hr"], "仅人事可审批历史核对");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const params = idSchema.safeParse(request.params);
    const body = noteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "审批信息无效" });
    const now = clock();
    const occurredOn = businessDate(now);
    const client = await db.connect();
    try {
      await client.query("begin");
      const review = await client.query<{
        id: string; order_id: string; proposed_lifecycle_state: "active" | "paused" | "zero";
        proposed_current_revenue: string; reason: string; requested_by_user_id: string;
        requested_by_person_id: string; status: string;
      }>(
        `select id::text,order_id::text,proposed_lifecycle_state,proposed_current_revenue::text,
                reason,requested_by_user_id::text,requested_by_person_id::text,status
         from historical_order_reviews where id=$1 for update`, [params.data.id],
      );
      const row = review.rows[0];
      if (!row) { await client.query("rollback"); return reply.code(404).send({ message: "历史核对不存在" }); }
      if (row.status !== "pending") { await client.query("rollback"); return reply.code(409).send({ message: "历史核对已处理" }); }
      if (row.requested_by_person_id === request.currentUser!.personId) {
        await client.query("rollback");
        return reply.code(409).send({ message: "核对人与审批人必须是不同人员" });
      }
      const order = await client.query<{ salesperson_person_id: string; counted_amount: string; lifecycle_state: string; customer_unit:string; business_region_source_text:string|null; business_region_code:string|null }>(
        `select salesperson_person_id::text,counted_amount::text,lifecycle_state,customer_unit,
                business_region_source_text,business_region_code
         from performance_orders where id=$1 for update`, [row.order_id],
      );
      if (order.rows[0]?.lifecycle_state !== "historical_review_required") {
        await client.query("rollback");
        return reply.code(409).send({ message: "订单已不处于历史待核状态" });
      }
      if(!order.rows[0]!.business_region_code||!order.rows[0]!.business_region_source_text){
        await client.query("rollback");
        return reply.code(409).send({message:"订单分析维度尚未取得可信来源，不能批准历史核对"});
      }
      await assertAccountingPeriodOpen(client, accountingMonth(occurredOn));
      const organization = await resolveOrganization(client, order.rows[0]!.salesperson_person_id, occurredOn);
      const currentRevenue = Number(row.proposed_current_revenue);
      const countedAmount = row.proposed_lifecycle_state === "active" ? currentRevenue : 0;
      const deltaAmount = countedAmount - Number(order.rows[0]!.counted_amount);
      const inserted = await client.query<{ id: string }>(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,
           leader_name,supervisor_name,created_by,salesperson_person_id,department_unit_id,
           group_unit_id,leader_person_id,supervisor_person_id,occurred_at)
         values($1,'historical_review_resolution',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         returning id::text`,
        [row.order_id, deltaAmount, currentRevenue, countedAmount, accountingMonth(occurredOn), occurredOn,
         `历史核对结论：${row.reason}`.slice(0, 500), organization.salespersonName, organization.departmentName,
         organization.groupName, organization.leaderName, organization.supervisorName, row.requested_by_user_id,
         organization.personId, organization.departmentId, organization.groupId, organization.leaderPersonId,
         organization.supervisorPersonId, now],
      );
      await recordEventAnalysisDimensions(client,inserted.rows[0]!.id,{
        businessRegionCode:order.rows[0]!.business_region_code,
        businessRegionSourceText:order.rows[0]!.business_region_source_text,
        customerUnit:order.rows[0]!.customer_unit,
      });
      await client.query("update performance_orders set lifecycle_state=$2,current_revenue=$3,counted_amount=$4 where id=$1", [row.order_id, row.proposed_lifecycle_state, currentRevenue, countedAmount]);
      await client.query(
        `update historical_order_reviews set status='approved',reviewed_by_user_id=$2,
         reviewed_by_person_id=$3,reviewed_at=$4,review_note=$5,resolution_event_id=$6 where id=$1`,
        [row.id, request.currentUser!.id, request.currentUser!.personId, now, body.data.note, inserted.rows[0]!.id],
      );
      await writeAudit(client, request.currentUser!.id, "performance.historical_review_approved", "historical_order_review", row.id, { eventId: inserted.rows[0]!.id, note: body.data.note }, request.ip);
      await client.query("commit");
      return { id: row.id, status: "approved", lifecycleState: row.proposed_lifecycle_state };
    } catch (error) {
      await client.query("rollback");
      if (error instanceof AccountingPeriodError || error instanceof OrganizationResolutionError) return reply.code(409).send({ message: error.message });
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/historical-order-reviews/:id/reject", async (request, reply) => {
    const denied = requireRole(request.currentUser, ["hr"], "仅人事可审批历史核对");
    if (denied) return reply.code(denied.statusCode).send({ message: denied.message });
    const params = idSchema.safeParse(request.params);
    const body = noteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "驳回信息无效" });
    const now = clock();
    const client = await db.connect();
    try {
      await client.query("begin");
      const rejected = await client.query(
        `update historical_order_reviews set status='rejected',reviewed_by_user_id=$2,
         reviewed_by_person_id=$3,reviewed_at=$4,review_note=$5
         where id=$1 and status='pending' and requested_by_person_id<>$3`,
        [params.data.id, request.currentUser!.id, request.currentUser!.personId, now, body.data.note],
      );
      if (!rejected.rowCount) { await client.query("rollback"); return reply.code(409).send({ message: "历史核对不存在、已处理或不满足职责分离" }); }
      await writeAudit(client, request.currentUser!.id, "performance.historical_review_rejected", "historical_order_review", String(params.data.id), body.data, request.ip);
      await client.query("commit");
      return { id: String(params.data.id), status: "rejected" };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });
}
