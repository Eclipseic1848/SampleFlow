import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { hasAnyRole } from "./auth.js";

const levelSchema = z.enum(["sales_manager", "department", "group", "personal"]);
const createSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
  level: levelSchema,
  ownerUsername: z.string().trim().min(1).max(100),
  parentGoalId: z.coerce.number().int().positive().nullable().optional(),
  amount: z.number().finite().min(0).max(99_999_999_999.99),
  changeReason: z.string().trim().max(500).optional().default("目标下达"),
});
const signatureSchema = z.object({ signatureText: z.string().trim().min(1).max(100) });
const decisionSchema = z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().trim().max(500).optional().default("") });
const requestSchema = z.object({ requestedAmount: z.number().finite().min(0).max(99_999_999_999.99).optional(), reason: z.string().trim().min(1).max(500) });

const editorRoles: Record<z.infer<typeof levelSchema>, readonly string[]> = {
  sales_manager: ["sales_manager"],
  department: ["sales_manager"],
  group: ["sales_supervisor"],
  personal: ["sales_leader", "sales_supervisor"],
};

export async function registerGoals(app: FastifyInstance, db: Database) {
  app.get("/api/goals", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const result = await db.query(
      `select g.id::text, to_char(g.period_month, 'YYYY-MM') as "periodMonth", g.goal_level as level,
              u.username as "ownerUsername", u.display_name as "ownerName", g.parent_goal_id::text as "parentGoalId",
              v.id::text as "versionId", v.version_no::text as "versionNo", v.amount::text, v.status,
              v.signature_text as "signatureText", v.signed_at as "signedAt", v.change_reason as "changeReason",
              coalesce((select sum(cv.amount) from goals cg
                        join lateral (select amount from goal_versions where goal_id=cg.id and status <> 'superseded' order by version_no desc limit 1) cv on true
                        where cg.parent_goal_id=g.id),0)::text as "allocatedAmount"
       from goals g join users u on u.id=g.owner_user_id
       join lateral (select * from goal_versions where goal_id=g.id and status <> 'superseded' order by version_no desc limit 1) v on true
       order by g.period_month desc,
                case g.goal_level when 'sales_manager' then 1 when 'department' then 2 when 'group' then 3 else 4 end,
                u.display_name`,
    );
    return { goals: result.rows };
  });

  app.post("/api/goals", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "目标信息不完整或格式无效" });
    if (!hasAnyRole(request.currentUser, editorRoles[parsed.data.level])) return reply.code(403).send({ message: "当前角色无权下达该层级目标" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const owner = await client.query<{ id: string }>("select id::text from users where lower(username)=lower($1) and is_active", [parsed.data.ownerUsername]);
      if (!owner.rows[0]) { await client.query("rollback"); return reply.code(404).send({ message: "目标责任人账号不存在" }); }
      if (parsed.data.level === "sales_manager" && owner.rows[0].id !== request.currentUser.id) { await client.query("rollback"); return reply.code(403).send({ message: "销售经理只能录入并签收自己的总目标" }); }
      const month = `${parsed.data.periodMonth}-01`;
      const goal = await client.query<{ id: string }>(
        `insert into goals (period_month, goal_level, owner_user_id, parent_goal_id)
         values ($1,$2,$3,$4) on conflict (period_month, goal_level, owner_user_id)
         do update set parent_goal_id=excluded.parent_goal_id returning id::text`,
        [month, parsed.data.level, owner.rows[0].id, parsed.data.parentGoalId ?? null],
      );
      const pending = await client.query("select 1 from goal_versions where goal_id=$1 and status in ('pending_signature','pending_gm','pending_hr')", [goal.rows[0]!.id]);
      if (pending.rowCount) { await client.query("rollback"); return reply.code(409).send({ message: "该目标已有待确认或待审批版本" }); }
      const version = await client.query<{ id: string }>(
        `insert into goal_versions (goal_id, version_no, amount, status, created_by, change_reason)
         select $1, coalesce(max(version_no),0)+1, $2, 'pending_signature', $3, $4
         from goal_versions where goal_id=$1 returning id::text`,
        [goal.rows[0]!.id, parsed.data.amount, request.currentUser.id, parsed.data.changeReason],
      );
      await client.query(`insert into audit_logs (actor_user_id,action,entity_type,entity_id,after_data,ip_address) values ($1,'goal.version_created','goal_version',$2,$3,$4)`, [request.currentUser.id, version.rows[0]!.id, JSON.stringify(parsed.data), request.ip]);
      await client.query("commit");
      return reply.code(201).send({ id: goal.rows[0]!.id, versionId: version.rows[0]!.id });
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/goals/:id/sign", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const parsed = signatureSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "签名信息无效" });
    const result = await db.query(
      `update goal_versions v set signed_by=$2, signed_at=now(), signature_text=$3,
              status=case when g.goal_level='sales_manager' then 'pending_gm' else 'pending_hr' end
       from goals g where v.goal_id=g.id and g.id=$1 and g.owner_user_id=$2 and v.status='pending_signature'
       returning v.id::text`, [params.data.id, request.currentUser.id, parsed.data.signatureText]);
    if (!result.rows[0]) return reply.code(409).send({ message: "仅目标责任人可对待签名版本确认" });
    return { ok: true };
  });

  app.post("/api/goals/:id/decision", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const parsed = decisionSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "审批信息无效" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const current = await client.query<{ version_id: string; status: string; level: string }>(
        `select v.id::text as version_id, v.status, g.goal_level as level from goals g
         join goal_versions v on v.goal_id=g.id where g.id=$1 and v.status in ('pending_gm','pending_hr') for update`, [params.data.id]);
      const row = current.rows[0];
      if (!row) { await client.query("rollback"); return reply.code(409).send({ message: "目标当前不在待审批状态" }); }
      const isGm = row.status === "pending_gm" && row.level === "sales_manager" && hasAnyRole(request.currentUser, ["general_manager"]);
      const isHr = row.status === "pending_hr" && hasAnyRole(request.currentUser, ["hr"]);
      if (!isGm && !isHr) { await client.query("rollback"); return reply.code(403).send({ message: "当前角色无权处理此审批节点" }); }
      const stage = isGm ? "general_manager" : "hr";
      await client.query(`insert into goal_approvals (goal_version_id,approval_stage,decision,decided_by,comment) values ($1,$2,$3,$4,$5)`, [row.version_id, stage, parsed.data.decision, request.currentUser.id, parsed.data.comment || null]);
      if (parsed.data.decision === "rejected") {
        await client.query("update goal_versions set status='rejected' where id=$1", [row.version_id]);
      } else if (isGm) {
        await client.query("update goal_versions set status='pending_hr' where id=$1", [row.version_id]);
      } else {
        await client.query("update goal_versions set status='superseded' where goal_id=$1 and status='active'", [params.data.id]);
        await client.query("update goal_versions set status='active' where id=$1", [row.version_id]);
      }
      await client.query("commit");
      return { ok: true };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/goals/:id/change-requests", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const parsed = requestSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "修改申请信息无效" });
    const owns = await db.query("select 1 from goals where id=$1 and owner_user_id=$2", [params.data.id, request.currentUser.id]);
    if (!owns.rowCount) return reply.code(403).send({ message: "仅目标责任人可提出修改申请" });
    await db.query(`insert into goal_change_requests (goal_id,requested_by,requested_amount,reason,status) values ($1,$2,$3,$4,'pending')`, [params.data.id, request.currentUser.id, parsed.data.requestedAmount ?? null, parsed.data.reason]);
    return reply.code(201).send({ ok: true });
  });
}
