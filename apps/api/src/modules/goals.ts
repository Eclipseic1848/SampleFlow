import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "../db.js";
import { recordOperation } from "../observability.js";
import { postgresBigintIdSchema } from "../validation.js";
import { hasAnyRole, type CurrentUser } from "./auth.js";
import { canReadGoals, pendingGoalSql, pendingGoalValues, resolveGoalAccess } from "./authorization.js";

const levelSchema = z.enum(["sales_manager", "department", "group", "personal"]);
type GoalLevel = z.infer<typeof levelSchema>;

const createSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  level: levelSchema,
  ownerPersonId: postgresBigintIdSchema,
  orgUnitId: postgresBigintIdSchema.nullable().optional(),
  parentGoalId: postgresBigintIdSchema.nullable().optional(),
  amount: z.number().finite().min(0).max(99_999_999_999.99),
  changeReason: z.string().trim().min(1).max(500).optional().default("目标下达"),
});
const confirmationSchema = z.strictObject({});
const GOAL_CONFIRMATION_STATEMENT = "本人已核对并确认承担本目标版本。";
const decisionSchema = z.object({
  expectedVersionId: postgresBigintIdSchema,
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().min(1).max(500),
});
const requestSchema = z.object({
  requestedAmount: z.number().finite().min(0).max(99_999_999_999.99).optional(),
  reason: z.string().trim().min(1).max(500),
});
const acceptSchema = z.object({
  newAmount: z.number().finite().min(0).max(99_999_999_999.99),
  comment: z.string().trim().min(1).max(500),
});
const rejectSchema = z.object({ comment: z.string().trim().min(1).max(500) });
const linkageSchema = z.object({
  decision: z.enum(["keep_parent", "adjust_parent"]),
  reason: z.string().trim().min(1).max(500),
  newAmount: z.number().finite().min(0).max(99_999_999_999.99).optional(),
});
const idSchema = z.object({ id: postgresBigintIdSchema });
const versionIdSchema = z.strictObject({ id: postgresBigintIdSchema });
const listSchema = z.object({ pendingOnly: z.stringbool().optional().default(false) });
const optionsSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  level: levelSchema,
  parentGoalId: postgresBigintIdSchema.optional(),
});

const editorRoles: Record<GoalLevel, readonly string[]> = {
  sales_manager: ["sales_manager"],
  department: ["sales_manager"],
  group: ["sales_supervisor"],
  personal: ["sales_leader"],
};
const ownerRoles: Record<GoalLevel, string> = {
  sales_manager: "sales_manager",
  department: "sales_supervisor",
  group: "sales_leader",
  personal: "salesperson",
};
const parentLevels: Partial<Record<GoalLevel, GoalLevel>> = {
  department: "sales_manager",
  group: "department",
  personal: "group",
};

type GoalContext = {
  id: string;
  period_month: string;
  level: GoalLevel;
  owner_person_id: string;
  owner_user_id: string;
  org_unit_id: string | null;
  parent_goal_id: string | null;
};

type PendingVersion = {
  id: string;
  goal_id: string;
  version_no: string;
  status: string;
  level: GoalLevel;
  owner_person_id: string;
  parent_goal_id: string | null;
  created_by_person_id: string;
  signed_by_person_id: string | null;
};

class GoalError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function businessDate(periodMonth: string): string {
  return `${periodMonth}-01`;
}

function goalError(reply: FastifyReply, error: unknown) {
  if (error instanceof GoalError) {
    return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  }
  const databaseCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (["23503", "23505", "23P01", "40001", "40P01"].includes(databaseCode)) {
    return reply.code(409).send({ code: "GOAL_STATE_CONFLICT", message: "目标状态已变化，请刷新后重试" });
  }
  return null;
}

function unexpectedGoalError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const handled = goalError(reply, error);
  if (handled) return handled;
  return reply.code(500).send({ code: "GOAL_INTERNAL_ERROR", message: "目标工作流暂时无法处理，请稍后重试" });
}

function goalReasonCode(error: unknown): string {
  if (error instanceof GoalError) return error.code;
  const databaseCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return ["23503", "23505", "23P01", "40001", "40P01"].includes(databaseCode)
    ? "GOAL_STATE_CONFLICT"
    : "GOAL_INTERNAL_ERROR";
}

async function audit(
  client: PoolClient,
  user: CurrentUser,
  ipAddress: string,
  action: string,
  entityType: string,
  entityId: string,
  beforeData?: unknown,
  afterData?: unknown,
) {
  await client.query(
    `insert into audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,ip_address)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [user.id, action, entityType, entityId, beforeData ? JSON.stringify(beforeData) : null, afterData ? JSON.stringify(afterData) : null, ipAddress],
  );
}

async function loadGoal(client: PoolClient, goalId: string, lock = false): Promise<GoalContext | undefined> {
  const result = await client.query<GoalContext>(
    `select id::text,to_char(period_month,'YYYY-MM-DD') as period_month,goal_level as level,
            owner_person_id::text,owner_user_id::text,org_unit_id::text,parent_goal_id::text
     from goals where id=$1${lock ? " for update" : ""}`,
    [goalId],
  );
  return result.rows[0];
}

async function assertOwnerIsEligible(
  client: PoolClient,
  level: GoalLevel,
  ownerPersonId: string,
  orgUnitId: string | null,
  parent: GoalContext | undefined,
  effectiveDate: string,
) {
  const owner = await client.query<{ user_id: string; display_name: string }>(
    `select p.user_id::text,p.display_name
     from people p join users u on u.id=p.user_id and u.is_active
     join user_roles ur on ur.user_id=u.id and ur.role_code=$2
     where p.id=$1 and p.is_active`,
    [ownerPersonId, ownerRoles[level]],
  );
  if (!owner.rows[0]) throw new GoalError(409, "GOAL_OWNER_INELIGIBLE", "所选人员不是该层级的有效目标责任人");

  if (level === "sales_manager") return owner.rows[0];
  if ((level === "department" || level === "group") && !orgUnitId) {
    throw new GoalError(400, "GOAL_ORG_REQUIRED", "该层级目标必须选择组织范围");
  }

  if (level === "department") {
    const valid = await client.query(
      `select 1 from org_units unit
       join org_responsibilities responsibility on responsibility.org_unit_id=unit.id
       where unit.id=$1 and unit.unit_type='department' and unit.is_active
         and responsibility.person_id=$2 and responsibility.responsibility_type='supervisor'
         and responsibility.effective_from<=$3::date
         and (responsibility.effective_to is null or responsibility.effective_to>=$3::date)`,
      [orgUnitId, ownerPersonId, effectiveDate],
    );
    if (!valid.rowCount) throw new GoalError(409, "GOAL_OWNER_ORG_MISMATCH", "目标责任人不是所选部门在该月的有效主管");
  } else if (level === "group") {
    const valid = await client.query(
      `select 1 from org_units unit
       join org_responsibilities responsibility on responsibility.org_unit_id=unit.id
       where unit.id=$1 and unit.unit_type='group' and unit.is_active and unit.parent_id=$4
         and responsibility.person_id=$2 and responsibility.responsibility_type='leader'
         and responsibility.effective_from<=$3::date
         and (responsibility.effective_to is null or responsibility.effective_to>=$3::date)`,
      [orgUnitId, ownerPersonId, effectiveDate, parent?.org_unit_id],
    );
    if (!valid.rowCount) throw new GoalError(409, "GOAL_OWNER_ORG_MISMATCH", "目标责任人不是直属小组在该月的有效组长");
  } else {
    if (orgUnitId !== null) throw new GoalError(400, "GOAL_PERSONAL_ORG_INVALID", "个人目标不能单独指定组织范围");
    const valid = await client.query(
      `select 1 from org_memberships membership
       where membership.person_id=$1 and membership.group_id=$2
         and membership.effective_from<=$3::date
         and (membership.effective_to is null or membership.effective_to>=$3::date)`,
      [ownerPersonId, parent?.org_unit_id, effectiveDate],
    );
    if (!valid.rowCount) throw new GoalError(409, "GOAL_OWNER_ORG_MISMATCH", "目标责任人不是直属小组在该月的有效成员");
  }
  return owner.rows[0];
}

async function assertCreationHierarchy(
  client: PoolClient,
  user: CurrentUser,
  input: z.infer<typeof createSchema>,
): Promise<{ parent: GoalContext | undefined; ownerUserId: string }> {
  if (!hasAnyRole(user, editorRoles[input.level])) {
    throw new GoalError(403, "GOAL_CREATE_FORBIDDEN", "当前角色无权下达该层级目标");
  }
  const parentId = input.parentGoalId ?? null;
  const orgUnitId = input.orgUnitId ?? null;
  if (input.level === "sales_manager") {
    if (parentId !== null || orgUnitId !== null) throw new GoalError(400, "GOAL_ROOT_SCOPE_INVALID", "销售经理总目标不能设置上级目标或组织范围");
    if (String(input.ownerPersonId) !== user.personId) throw new GoalError(403, "GOAL_ROOT_OWNER_INVALID", "销售经理只能录入并签收自己的总目标");
  } else if (parentId === null) {
    throw new GoalError(400, "GOAL_PARENT_REQUIRED", "该层级目标必须选择同月直属上级目标");
  }

  let parent: GoalContext | undefined;
  if (parentId !== null) {
    parent = await loadGoal(client, parentId);
    if (!parent) throw new GoalError(404, "GOAL_PARENT_NOT_FOUND", "上级目标不存在");
    if (parent.level !== parentLevels[input.level]) throw new GoalError(409, "GOAL_PARENT_LEVEL_INVALID", "上级目标层级不匹配");
    if (parent.period_month !== businessDate(input.periodMonth)) throw new GoalError(409, "GOAL_PARENT_MONTH_INVALID", "上级目标必须与当前目标属于同一月份");
    if (parent.owner_person_id !== user.personId) throw new GoalError(403, "GOAL_PARENT_OWNER_REQUIRED", "仅直属上级目标责任人可下达该目标");
    const active = await client.query("select 1 from goal_versions where goal_id=$1 and status='active'", [parent.id]);
    if (!active.rowCount) throw new GoalError(409, "GOAL_PARENT_NOT_ACTIVE", "直属上级目标生效后才能下达子目标");
    if (String(input.ownerPersonId) === user.personId) throw new GoalError(409, "GOAL_DUTY_SEPARATION", "目标下达人和责任人必须是不同人员");
  }

  const owner = await assertOwnerIsEligible(client, input.level, input.ownerPersonId, orgUnitId, parent, businessDate(input.periodMonth));
  return { parent, ownerUserId: owner.user_id };
}

async function decisionVersion(client: PoolClient, goalId: string, versionId: string): Promise<PendingVersion | undefined> {
  const result = await client.query<PendingVersion>(
    `select v.id::text,v.goal_id::text,v.version_no::text,v.status,g.goal_level as level,
            g.owner_person_id::text,g.parent_goal_id::text,v.created_by_person_id::text,v.signed_by_person_id::text
     from goal_versions v join goals g on g.id=v.goal_id
     where g.id=$1 and v.id=$2
     for update of v`,
    [goalId, versionId],
  );
  return result.rows[0];
}

async function createPendingGoalVersion(
  client: PoolClient,
  input: { goalId: string; amount: number; user: CurrentUser; ipAddress: string; reason: string; sourceChangeRequestId?: string },
) {
  const result = await client.query<{ id: string; version_no: string }>(
    `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
     select $1,coalesce(max(version_no),0)+1,$2,'pending_signature',$3,$4,$5
     from goal_versions where goal_id=$1 returning id::text,version_no::text`,
    [input.goalId, input.amount, input.user.id, input.user.personId, input.reason],
  );
  await invalidatePendingChangeRequests(client,input.goalId,input.user,input.ipAddress,input.sourceChangeRequestId,"目标已产生其他候选版本");
  return result.rows[0]!;
}

async function invalidatePendingChangeRequests(
  client:PoolClient,
  goalId:string,
  user:CurrentUser,
  ipAddress:string,
  excludedId:string|undefined,
  reason:string,
){
  const invalidated=await client.query<{id:string}>(
    `update goal_change_requests set status='invalidated',invalidated_at=now()
     where goal_id=$1 and status='pending' and ($2::bigint is null or id<>$2::bigint)
     returning id::text`,
    [goalId,excludedId??null],
  );
  for(const item of invalidated.rows){
    await audit(client,user,ipAddress,"goal.change_invalidated","goal_change_request",item.id,{status:"pending"},{status:"invalidated",reason});
  }
}

async function assertGoalReadable(database: Database, user: CurrentUser, goalId: string) {
  const access = await resolveGoalAccess(database, user);
  const result = await database.query(
    "select 1 from goals where id=$1 and ($2::boolean or owner_person_id=any($3::bigint[]))",
    [goalId, access.all, access.ownerPersonIds],
  );
  if (!result.rowCount) throw new GoalError(403, "GOAL_READ_FORBIDDEN", "当前角色无权查看该目标");
}

export async function registerGoals(app: FastifyInstance, db: Database) {
  app.get("/api/goals", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const query = listSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ message: "目标查询条件无效" });
    try {
      const access = await resolveGoalAccess(db, request.currentUser);
      if (!canReadGoals(access)) return reply.code(403).send({ message: "当前角色没有目标查看权限" });
      const result = await db.query(
        `select g.id::text,to_char(g.period_month,'YYYY-MM') as "periodMonth",g.goal_level as level,
                p.display_name as "ownerName",u.username as "ownerUsername",g.owner_person_id::text as "ownerPersonId",
                g.org_unit_id::text as "orgUnitId",unit.name as "orgUnitName",g.parent_goal_id::text as "parentGoalId",
                v.id::text as "versionId",v.version_no::text as "versionNo",v.amount::text,v.status,
                active.amount::text as "effectiveAmount",
                v.signature_text as "signatureText",v.signed_at as "signedAt",v.change_reason as "changeReason",
                allocation.amount::text as "allocatedAmount",
                (coalesce(active.amount,v.amount)-allocation.amount)::text as "allocationDifference",
                case when coalesce(active.amount,v.amount)-allocation.amount>0 then 'unallocated'
                     when coalesce(active.amount,v.amount)-allocation.amount<0 then 'overallocated' else 'balanced' end as "allocationType",
                case when coalesce(active.amount,v.amount)=0 then null
                     else round(abs(coalesce(active.amount,v.amount)-allocation.amount)/coalesce(active.amount,v.amount)*100,2)::text end as "allocationRatio"
         from goals g join people p on p.id=g.owner_person_id left join users u on u.id=p.user_id
         left join org_units unit on unit.id=g.org_unit_id
         join lateral (
           select * from goal_versions where goal_id=g.id and status<>'superseded'
           order by version_no desc limit 1
         ) v on true
         left join lateral (
           select amount from goal_versions where goal_id=g.id and status='active'
         ) active on true
         join lateral (
           select coalesce(sum(child_version.amount),0) as amount
           from goals child
           join goal_versions child_version on child_version.goal_id=child.id and child_version.status='active'
           where child.parent_goal_id=g.id
         ) allocation on true
         where ($1::boolean or g.owner_person_id=any($2::bigint[]))
           and (not $3::boolean or ${pendingGoalSql("g", "v", 4)})
         order by g.period_month desc,
                  case g.goal_level when 'sales_manager' then 1 when 'department' then 2 when 'group' then 3 else 4 end,
                  p.display_name`,
        [access.all, access.ownerPersonIds, query.data.pendingOnly, ...pendingGoalValues(request.currentUser)],
      );
      return { goals: result.rows };
    } catch (error) {
      return unexpectedGoalError(request, reply, error);
    }
  });

  app.get("/api/goals/options", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const parsed = optionsSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "目标选择条件无效" });
    try {
      if (!hasAnyRole(request.currentUser, editorRoles[parsed.data.level])) {
        return reply.code(403).send({ message: "当前角色无权下达该层级目标" });
      }
      const expectedParent = parentLevels[parsed.data.level];
      const parentGoals = expectedParent ? await db.query(
        `select g.id::text,p.display_name as "ownerName",g.org_unit_id::text as "orgUnitId",unit.name as "orgUnitName",
                version.amount::text
         from goals g join people p on p.id=g.owner_person_id left join org_units unit on unit.id=g.org_unit_id
         join goal_versions version on version.goal_id=g.id and version.status='active'
         where g.period_month=$1::date and g.goal_level=$2 and g.owner_person_id=$3
         order by p.display_name,g.id`,
        [businessDate(parsed.data.periodMonth), expectedParent, request.currentUser.personId],
      ) : { rows: [] };

      let owners: unknown[] = [];
      if (parsed.data.level === "sales_manager") {
        const result = await db.query(
          `select p.id::text as "personId",p.display_name as name,null::text as "orgUnitId",null::text as "orgUnitName"
           from people p join users u on u.id=p.user_id and u.is_active
           where p.id=$1`,
          [request.currentUser.personId],
        );
        owners = result.rows;
      } else if (parsed.data.parentGoalId) {
        const parent = await db.query<GoalContext>(
          `select g.id::text,to_char(g.period_month,'YYYY-MM-DD') as period_month,g.goal_level as level,
                  g.owner_person_id::text,g.owner_user_id::text,g.org_unit_id::text,g.parent_goal_id::text
           from goals g join goal_versions version on version.goal_id=g.id and version.status='active'
           where g.id=$1 and g.period_month=$2::date and g.goal_level=$3 and g.owner_person_id=$4`,
          [parsed.data.parentGoalId, businessDate(parsed.data.periodMonth), expectedParent, request.currentUser.personId],
        );
        if (!parent.rows[0]) throw new GoalError(404, "GOAL_PARENT_NOT_FOUND", "未找到可下达的直属上级目标");
        if (parsed.data.level === "department") {
          const result = await db.query(
            `select p.id::text as "personId",p.display_name as name,unit.id::text as "orgUnitId",unit.name as "orgUnitName"
             from org_units unit join org_responsibilities responsibility on responsibility.org_unit_id=unit.id
             join people p on p.id=responsibility.person_id and p.is_active join users u on u.id=p.user_id and u.is_active
             join user_roles role on role.user_id=u.id and role.role_code='sales_supervisor'
             where unit.unit_type='department' and unit.is_active
               and responsibility.responsibility_type='supervisor' and responsibility.effective_from<=$1::date
               and (responsibility.effective_to is null or responsibility.effective_to>=$1::date)
             order by unit.name,p.display_name`,
            [businessDate(parsed.data.periodMonth)],
          ); owners = result.rows;
        } else if (parsed.data.level === "group") {
          const result = await db.query(
            `select p.id::text as "personId",p.display_name as name,unit.id::text as "orgUnitId",unit.name as "orgUnitName"
             from org_units unit join org_responsibilities responsibility on responsibility.org_unit_id=unit.id
             join people p on p.id=responsibility.person_id and p.is_active join users u on u.id=p.user_id and u.is_active
             join user_roles role on role.user_id=u.id and role.role_code='sales_leader'
             where unit.unit_type='group' and unit.is_active and unit.parent_id=$2
               and responsibility.responsibility_type='leader' and responsibility.effective_from<=$1::date
               and (responsibility.effective_to is null or responsibility.effective_to>=$1::date)
             order by unit.name,p.display_name`,
            [businessDate(parsed.data.periodMonth), parent.rows[0].org_unit_id],
          ); owners = result.rows;
        } else {
          const result = await db.query(
            `select p.id::text as "personId",p.display_name as name,null::text as "orgUnitId",null::text as "orgUnitName"
             from org_memberships membership join people p on p.id=membership.person_id and p.is_active
             join users u on u.id=p.user_id and u.is_active
             join user_roles role on role.user_id=u.id and role.role_code='salesperson'
             where membership.group_id=$2 and membership.effective_from<=$1::date
               and (membership.effective_to is null or membership.effective_to>=$1::date)
             order by p.display_name`,
            [businessDate(parsed.data.periodMonth), parent.rows[0].org_unit_id],
          ); owners = result.rows;
        }
      }
      return { parentGoals: parentGoals.rows, owners };
    } catch (error) {
      return unexpectedGoalError(request, reply, error);
    }
  });

  app.post("/api/goals", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "GOAL_INPUT_INVALID", message: "目标信息不完整或格式无效" });
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`goal:${parsed.data.periodMonth}:${parsed.data.level}:${parsed.data.ownerPersonId}:${parsed.data.orgUnitId ?? 0}`]);
      const hierarchy = await assertCreationHierarchy(client, request.currentUser, parsed.data);
      const month = businessDate(parsed.data.periodMonth);
      const orgUnitId = parsed.data.orgUnitId ?? null;
      let goal = await client.query<{ id: string }>(
        `select id::text from goals where period_month=$1 and goal_level=$2 and owner_person_id=$3
           and coalesce(org_unit_id,0)=coalesce($4::bigint,0) for update`,
        [month, parsed.data.level, parsed.data.ownerPersonId, orgUnitId],
      );
      if (!goal.rows[0]) {
        goal = await client.query<{ id: string }>(
          `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id)
           values($1,$2,$3,$4,$5,$6) returning id::text`,
          [month, parsed.data.level, hierarchy.ownerUserId, parsed.data.ownerPersonId, parsed.data.parentGoalId ?? null, orgUnitId],
        );
      } else {
        const shape = await loadGoal(client, goal.rows[0].id);
        if (shape?.parent_goal_id !== String(parsed.data.parentGoalId ?? "") && !(shape?.parent_goal_id === null && parsed.data.parentGoalId == null)) {
          throw new GoalError(409, "GOAL_SCOPE_CONFLICT", "既有目标的直属关系与本次下达不一致");
        }
      }
      const goalId = goal.rows[0]!.id;
      const unresolved = await client.query("select 1 from goal_versions where goal_id=$1 and status in ('pending_signature','pending_gm','pending_hr','active')", [goalId]);
      if (unresolved.rowCount) throw new GoalError(409, "GOAL_VERSION_EXISTS", "该目标已有待处理或已生效版本，修改请走目标变更申请");
      const version = await createPendingGoalVersion(client, { goalId, amount: parsed.data.amount, user: request.currentUser, ipAddress:request.ip, reason: parsed.data.changeReason });
      await audit(client, request.currentUser, request.ip, "goal.version_created", "goal_version", version.id, undefined, {
        goalId, versionNo: version.version_no, ...parsed.data,
      });
      await client.query("commit");
      return reply.code(201).send({ id: goalId, versionId: version.id });
    } catch (error) {
      await client.query("rollback");
      return unexpectedGoalError(request, reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/api/goal-versions/:id/confirm", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = versionIdSchema.safeParse(request.params);
    const parsed = confirmationSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "目标确认信息无效" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const result = await client.query<PendingVersion & { signed_by: string | null; signed_at: string | null; signature_text: string | null; amount: string }>(
        `select v.id::text,v.goal_id::text,v.version_no::text,v.status,v.amount::text,
                v.signed_by::text,v.signed_by_person_id::text,v.signed_at::text,v.signature_text,
                g.goal_level as level,g.owner_person_id::text,g.parent_goal_id::text,v.created_by_person_id::text
         from goal_versions v join goals g on g.id=v.goal_id where v.id=$1 for update of v`,
        [params.data.id],
      );
      const version = result.rows[0];
      if (!version) throw new GoalError(404, "GOAL_VERSION_NOT_FOUND", "目标版本不存在");
      if (version.owner_person_id !== request.currentUser.personId) throw new GoalError(403, "GOAL_CONFIRM_FORBIDDEN", "仅目标责任人可确认该版本");
      if (version.level !== "sales_manager" && version.created_by_person_id === request.currentUser.personId) {
        throw new GoalError(409, "GOAL_DUTY_SEPARATION", "目标下达人和责任人确认者必须是不同人员");
      }
      if (version.signed_by_person_id !== null || version.signed_by !== null || version.signed_at !== null) {
        if (version.signed_by_person_id !== request.currentUser.personId || version.signed_by !== request.currentUser.id) {
          throw new GoalError(409, "GOAL_ALREADY_CONFIRMED", "该目标版本已由其他账号确认");
        }
        await client.query("commit");
        return reply.send({ ok: true, changed: false, versionId: version.id, confirmedAt: version.signed_at });
      }
      if (version.status !== "pending_signature") throw new GoalError(409, "GOAL_NOT_PENDING_CONFIRMATION", "目标版本当前不待责任人确认");
      const nextStatus = version.level === "sales_manager" ? "pending_gm" : "pending_hr";
      const confirmed = await client.query<{ signed_at: string }>(
        `update goal_versions set signed_by=$2,signed_by_person_id=$3,signed_at=now(),signature_text=$4,status=$5
         where id=$1 returning signed_at::text`,
        [version.id, request.currentUser.id, request.currentUser.personId, GOAL_CONFIRMATION_STATEMENT, nextStatus],
      );
      const confirmedAt = confirmed.rows[0]!.signed_at;
      await audit(client, request.currentUser, request.ip, "goal.version_confirmed", "goal_version", version.id, { status: version.status }, {
        status: nextStatus,
        goalId: version.goal_id,
        versionId: version.id,
        amount: version.amount,
        accountId: request.currentUser.id,
        personId: request.currentUser.personId,
        statement: GOAL_CONFIRMATION_STATEMENT,
        confirmedAt,
        result: "confirmed",
      });
      await client.query("commit");
      return { ok: true, changed: true, versionId: version.id, confirmedAt };
    } catch (error) {
      await client.query("rollback");
      return unexpectedGoalError(request, reply, error);
    } finally { client.release(); }
  });

  app.post("/api/goals/:id/decision", async (request, reply) => {
    if (!request.currentUser) {
      recordOperation(request, "approval", "failure", "AUTH_REQUIRED");
      return reply.code(401).send({ message: "尚未登录" });
    }
    const params = idSchema.safeParse(request.params);
    const parsed = decisionSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      recordOperation(request, "approval", "failure", "APPROVAL_INPUT_INVALID");
      return reply.code(400).send({ message: "审批信息无效；批准或拒绝时必须填写意见" });
    }
    const client = await db.connect();
    try {
      await client.query("begin");
      const version = await decisionVersion(client, params.data.id, parsed.data.expectedVersionId);
      if (!version || !["pending_gm", "pending_hr"].includes(version.status)) throw new GoalError(409, "GOAL_VERSION_CHANGED", "目标版本已变化，请重新核对后处理");
      const isGm = version.status === "pending_gm" && version.level === "sales_manager" && hasAnyRole(request.currentUser, ["general_manager"]);
      const isHr = version.status === "pending_hr" && hasAnyRole(request.currentUser, ["hr"]);
      if (!isGm && !isHr) throw new GoalError(403, "GOAL_APPROVAL_FORBIDDEN", "当前角色无权处理此审批节点");
      if ([version.created_by_person_id, version.signed_by_person_id].includes(request.currentUser.personId)) {
        throw new GoalError(409, "GOAL_DUTY_SEPARATION", "目标录入人或确认者不能审批同一版本");
      }
      if (isHr && version.level === "sales_manager") {
        const gm = await client.query<{ decided_by_person_id: string }>(
          "select decided_by_person_id::text from goal_approvals where goal_version_id=$1 and approval_stage='general_manager' and decision='approved'",
          [version.id],
        );
        if (!gm.rows[0]) throw new GoalError(409, "GOAL_GM_APPROVAL_REQUIRED", "销售经理总目标必须先经总经理批准");
        if (gm.rows[0].decided_by_person_id === request.currentUser.personId) throw new GoalError(409, "GOAL_DUTY_SEPARATION", "总经理审批人与人事终审人必须是不同人员");
      }
      const stage = isGm ? "general_manager" : "hr";
      await client.query(
        `insert into goal_approvals(goal_version_id,approval_stage,decision,decided_by,decided_by_person_id,comment)
         values($1,$2,$3,$4,$5,$6)`,
        [version.id, stage, parsed.data.decision, request.currentUser.id, request.currentUser.personId, parsed.data.comment || null],
      );
      await audit(client, request.currentUser, request.ip, parsed.data.decision === "approved" ? "goal.approved" : "goal.rejected", "goal_version", version.id, { status: version.status }, { stage, decision: parsed.data.decision, comment: parsed.data.comment });
      if (parsed.data.decision === "rejected") {
        await client.query("update goal_versions set status='rejected' where id=$1", [version.id]);
        const rejectedChanges = await client.query<{ id: string }>(
          `update goal_change_requests set status='rejected',outcome_comment=$2
           where created_version_id=$1 and status='accepted' returning id::text`,
          [version.id, parsed.data.comment],
        );
        for (const change of rejectedChanges.rows) {
          await audit(client, request.currentUser, request.ip, "goal.change_rejected", "goal_change_request", change.id, { status: "accepted" }, { status: "rejected", stage, comment: parsed.data.comment });
        }
      } else if (isGm) {
        await client.query("update goal_versions set status='pending_hr' where id=$1", [version.id]);
      } else {
        const superseded = await client.query<{ id: string }>("update goal_versions set status='superseded' where goal_id=$1 and status='active' returning id::text", [version.goal_id]);
        for (const previous of superseded.rows) {
          await audit(client, request.currentUser, request.ip, "goal.version_superseded", "goal_version", previous.id, { status: "active" }, { status: "superseded", replacementVersionId: version.id });
        }
        await client.query("update goal_versions set status='active' where id=$1", [version.id]);
        await invalidatePendingChangeRequests(client,version.goal_id,request.currentUser,request.ip,undefined,"目标生效版本已变化");
        const completed = await client.query<{ id: string }>(
          `update goal_change_requests set status='completed',handled_at=coalesce(handled_at,now())
           where created_version_id=$1 and status='accepted' returning id::text`,
          [version.id],
        );
        for (const change of completed.rows) {
          await audit(client, request.currentUser, request.ip, "goal.change_completed", "goal_change_request", change.id, { status: "accepted" }, { status: "completed", activeVersionId: version.id });
          if (version.parent_goal_id) {
            const linkage = await client.query<{ id: string }>(
              `insert into goal_linkage_decisions(parent_goal_id,triggering_child_version_id,decision,decided_by,decided_at,status)
               values($1,$2,null,null,null,'pending') on conflict(parent_goal_id,triggering_child_version_id)
               do update set status=goal_linkage_decisions.status returning id::text`,
              [version.parent_goal_id, version.id],
            );
            await audit(client, request.currentUser, request.ip, "goal.linkage_requested", "goal_linkage_decision", linkage.rows[0]!.id, undefined, { parentGoalId: version.parent_goal_id, childVersionId: version.id });
          }
        }
      }
      await client.query("commit");
      recordOperation(request, "approval", "success", "APPROVAL_RECORDED");
      return { ok: true };
    } catch (error) {
      await client.query("rollback");
      recordOperation(request, "approval", "failure", goalReasonCode(error));
      return unexpectedGoalError(request, reply, error);
    } finally { client.release(); }
  });

  app.post("/api/goals/:id/change-requests", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = idSchema.safeParse(request.params);
    const parsed = requestSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "修改申请信息无效" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const goal = await loadGoal(client, params.data.id, true);
      if (!goal) throw new GoalError(404, "GOAL_NOT_FOUND", "目标不存在");
      if (goal.level === "sales_manager") throw new GoalError(409, "GOAL_ROOT_CHANGE_UNSUPPORTED", "销售经理总目标不使用下级变更申请流程");
      if (goal.owner_person_id !== request.currentUser.personId) throw new GoalError(403, "GOAL_CHANGE_FORBIDDEN", "仅目标责任人可提出修改申请");
      const existing = await client.query<{ id: string }>(
        "select id::text from goal_change_requests where goal_id=$1 and status in ('pending','accepted') order by created_at desc limit 1",
        [goal.id],
      );
      if (existing.rows[0]) {
        await client.query("commit");
        return reply.code(200).send({ id: existing.rows[0].id });
      }
      const active = await client.query<{ id: string }>("select id::text from goal_versions where goal_id=$1 and status='active'", [goal.id]);
      if (!active.rows[0]) throw new GoalError(409, "GOAL_ACTIVE_REQUIRED", "仅生效目标可以申请修改");
      const created = await client.query<{ id: string }>(
        `insert into goal_change_requests(goal_id,requested_by,requested_by_person_id,requested_against_version_id,requested_amount,reason,status)
         values($1,$2,$3,$4,$5,$6,'pending') returning id::text`,
        [goal.id, request.currentUser.id, request.currentUser.personId, active.rows[0].id, parsed.data.requestedAmount ?? null, parsed.data.reason],
      );
      await audit(client, request.currentUser, request.ip, "goal.change_requested", "goal_change_request", created.rows[0]!.id, undefined, { goalId: goal.id, requestedAgainstVersionId: active.rows[0].id, ...parsed.data });
      await client.query("commit");
      return reply.code(201).send({ id: created.rows[0]!.id });
    } catch (error) {
      await client.query("rollback");
      return unexpectedGoalError(request, reply, error);
    } finally { client.release(); }
  });

  async function handleChangeRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: "accept" | "reject" | "withdraw",
  ) {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = idSchema.safeParse(request.params);
    const accepted = operation === "accept" ? acceptSchema.safeParse(request.body) : null;
    const rejected = operation === "reject" ? rejectSchema.safeParse(request.body) : null;
    if (!params.success || (accepted && !accepted.success) || (rejected && !rejected.success)) {
      return reply.code(400).send({ message: operation === "accept" ? "接受申请时必须填写新金额和意见" : "拒绝申请时必须填写意见" });
    }
    const client = await db.connect();
    try {
      await client.query("begin");
      const result = await client.query<{
        id: string; goal_id: string; status: string; requested_by_person_id: string;
        requested_against_version_id: string; parent_owner_person_id: string | null;
      }>(
        `select request_row.id::text,request_row.goal_id::text,request_row.status,
                request_row.requested_by_person_id::text,request_row.requested_against_version_id::text,
                parent.owner_person_id::text as parent_owner_person_id
         from goal_change_requests request_row join goals goal on goal.id=request_row.goal_id
         left join goals parent on parent.id=goal.parent_goal_id
         where request_row.id=$1 for update of request_row`,
        [params.data.id],
      );
      const row = result.rows[0];
      if (!row) throw new GoalError(404, "GOAL_CHANGE_NOT_FOUND", "目标修改申请不存在");
      if (row.status !== "pending") throw new GoalError(409, "GOAL_CHANGE_STATE_CONFLICT", "目标修改申请已被处理");
      const active = await client.query<{ id: string }>("select id::text from goal_versions where goal_id=$1 and status='active' for update", [row.goal_id]);
      if (active.rows[0]?.id !== row.requested_against_version_id) {
        await client.query("update goal_change_requests set status='invalidated',invalidated_at=now() where id=$1", [row.id]);
        await audit(client, request.currentUser, request.ip, "goal.change_invalidated", "goal_change_request", row.id, { status: "pending" }, { status: "invalidated", reason: "目标生效版本已变化" });
        await client.query("commit");
        return reply.code(409).send({ code: "GOAL_CHANGE_STALE", message: "目标生效版本已变化，申请已失效" });
      }

      if (operation === "withdraw") {
        if (row.requested_by_person_id !== request.currentUser.personId) throw new GoalError(403, "GOAL_CHANGE_WITHDRAW_FORBIDDEN", "仅申请人可撤回待处理申请");
        await client.query("update goal_change_requests set status='withdrawn',withdrawn_at=now() where id=$1", [row.id]);
        await audit(client, request.currentUser, request.ip, "goal.change_withdrawn", "goal_change_request", row.id, { status: "pending" }, { status: "withdrawn" });
      } else {
        if (row.parent_owner_person_id !== request.currentUser.personId) throw new GoalError(403, "GOAL_CHANGE_HANDLE_FORBIDDEN", "仅直属目标下达人可处理该申请");
        if (operation === "reject") {
          const body = rejected!.data;
          await client.query(
            `update goal_change_requests set status='rejected',handled_by=$2,handled_by_person_id=$3,handled_at=now(),outcome_comment=$4 where id=$1`,
            [row.id, request.currentUser.id, request.currentUser.personId, body.comment],
          );
          await audit(client, request.currentUser, request.ip, "goal.change_rejected", "goal_change_request", row.id, { status: "pending" }, { status: "rejected", comment: body.comment });
        } else {
          const body = accepted!.data;
          const version = await createPendingGoalVersion(client, { goalId: row.goal_id, amount: body.newAmount, user: request.currentUser, ipAddress:request.ip, reason: body.comment, sourceChangeRequestId:row.id });
          await client.query(
            `update goal_change_requests set status='accepted',handled_by=$2,handled_by_person_id=$3,handled_at=now(),outcome_comment=$4,created_version_id=$5 where id=$1`,
            [row.id, request.currentUser.id, request.currentUser.personId, body.comment, version.id],
          );
          await audit(client, request.currentUser, request.ip, "goal.change_accepted", "goal_change_request", row.id, { status: "pending" }, { status: "accepted", newAmount: body.newAmount, createdVersionId: version.id, comment: body.comment });
          await audit(client, request.currentUser, request.ip, "goal.version_created", "goal_version", version.id, undefined, { goalId: row.goal_id, versionNo: version.version_no, amount: body.newAmount, changeRequestId: row.id });
        }
      }
      await client.query("commit");
      return { ok: true };
    } catch (error) {
      await client.query("rollback");
      return unexpectedGoalError(request, reply, error);
    } finally { client.release(); }
  }

  app.post("/api/goal-change-requests/:id/accept", async (request, reply) => handleChangeRequest(request, reply, "accept"));
  app.post("/api/goal-change-requests/:id/reject", async (request, reply) => handleChangeRequest(request, reply, "reject"));
  app.post("/api/goal-change-requests/:id/withdraw", async (request, reply) => handleChangeRequest(request, reply, "withdraw"));

  app.get("/api/goal-workflows", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    try {
      const changeRequests = await db.query(
       `select request_row.id::text,request_row.goal_id::text as "goalId",goal.goal_level as level,
                owner.display_name as "ownerName",request_row.requested_amount::text as "requestedAmount",
                request_row.reason,request_row.status,request_row.outcome_comment as "outcomeComment",
                request_row.created_version_id::text as "createdVersionId",request_row.created_at as "createdAt",
                base_version.amount::text as "currentAmount",created_version.amount::text as "newAmount",
                case when created_version.id is null then null
                     else (created_version.amount-base_version.amount)::text end as "amountDifference",
                requester.display_name as "requestedByName",handler.display_name as "handledByName",
                (parent.owner_person_id=$1) as "canHandle",
                (request_row.requested_by_person_id=$1) as "canWithdraw"
         from goal_change_requests request_row join goals goal on goal.id=request_row.goal_id
         join people owner on owner.id=goal.owner_person_id join people requester on requester.id=request_row.requested_by_person_id
         left join people handler on handler.id=request_row.handled_by_person_id left join goals parent on parent.id=goal.parent_goal_id
         left join goal_versions base_version on base_version.id=request_row.requested_against_version_id
         left join goal_versions created_version on created_version.id=request_row.created_version_id
         where request_row.status='pending'
           and (request_row.requested_by_person_id=$1 or parent.owner_person_id=$1)
         order by request_row.created_at desc,request_row.id desc`,
        [request.currentUser.personId],
      );
      const linkageDecisions = await db.query(
        `select linkage.id::text,linkage.parent_goal_id::text as "parentGoalId",
                linkage.triggering_child_version_id::text as "triggeringChildVersionId",linkage.decision,
                linkage.status,linkage.reason,linkage.generated_change_request_id::text as "generatedChangeRequestId",
                child_goal.id::text as "childGoalId",child_owner.display_name as "childOwnerName",
                child_version.amount::text as "childAmount",linkage.decided_at as "decidedAt",
                parent.goal_level as "parentLevel",parent_version.amount::text as "parentAmount",
                true as "canDecide"
         from goal_linkage_decisions linkage join goal_versions child_version on child_version.id=linkage.triggering_child_version_id
         join goals child_goal on child_goal.id=child_version.goal_id join people child_owner on child_owner.id=child_goal.owner_person_id
         join goals parent on parent.id=linkage.parent_goal_id
         join goal_versions parent_version on parent_version.goal_id=parent.id and parent_version.status='active'
         where linkage.status='pending' and parent.owner_person_id=$1
         order by linkage.id desc`,
        [request.currentUser.personId],
      );
      return { changeRequests: changeRequests.rows, linkageDecisions: linkageDecisions.rows };
    } catch (error) { return unexpectedGoalError(request, reply, error); }
  });

  app.post("/api/goal-linkage-decisions/:id/decide", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = idSchema.safeParse(request.params);
    const parsed = linkageSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "目标联动选择无效" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const result = await client.query<{
        id: string; status: string; parent_goal_id: string; parent_owner_person_id: string;
        parent_owner_user_id: string; parent_level: GoalLevel; active_version_id: string;
      }>(
        `select linkage.id::text,linkage.status,linkage.parent_goal_id::text,
                parent.owner_person_id::text as parent_owner_person_id,parent.owner_user_id::text as parent_owner_user_id,
                parent.goal_level as parent_level,active.id::text as active_version_id
         from goal_linkage_decisions linkage join goals parent on parent.id=linkage.parent_goal_id
         join goal_versions active on active.goal_id=parent.id and active.status='active'
         where linkage.id=$1 for update of linkage`,
        [params.data.id],
      );
      const row = result.rows[0];
      if (!row) throw new GoalError(404, "GOAL_LINKAGE_NOT_FOUND", "目标联动待办不存在");
      if (row.status !== "pending") throw new GoalError(409, "GOAL_LINKAGE_STATE_CONFLICT", "目标联动待办已处理");
      if (row.parent_owner_person_id !== request.currentUser.personId) throw new GoalError(403, "GOAL_LINKAGE_FORBIDDEN", "仅本级目标责任人可作出联动选择");
      let generatedId: string | null = null;
      let createdVersionId: string | null = null;
      if (parsed.data.decision === "adjust_parent") {
        if (row.parent_level === "sales_manager") {
          if (parsed.data.newAmount === undefined) {
            throw new GoalError(400, "GOAL_ROOT_LINKAGE_AMOUNT_REQUIRED", "调整销售经理总目标必须明确填写新金额，系统不会自动联动");
          }
          const pending = await client.query("select 1 from goal_versions where goal_id=$1 and status in ('pending_signature','pending_gm','pending_hr')", [row.parent_goal_id]);
          if (pending.rowCount) throw new GoalError(409, "GOAL_VERSION_EXISTS", "销售经理总目标已有待处理版本");
          const version = await createPendingGoalVersion(client, { goalId: row.parent_goal_id, amount: parsed.data.newAmount, user: request.currentUser, ipAddress:request.ip, reason: parsed.data.reason });
          createdVersionId = version.id;
          await audit(client, request.currentUser, request.ip, "goal.version_created", "goal_version", createdVersionId, undefined, {
            goalId: row.parent_goal_id,
            versionNo: version.version_no,
            amount: parsed.data.newAmount,
            source: "linkage",
          });
        } else {
          const existing = await client.query<{ id: string }>(
            "select id::text from goal_change_requests where goal_id=$1 and status in ('pending','accepted') order by created_at desc limit 1",
            [row.parent_goal_id],
          );
          if (existing.rows[0]) {
            generatedId = existing.rows[0].id;
          } else {
            const created = await client.query<{ id: string }>(
              `insert into goal_change_requests(goal_id,requested_by,requested_by_person_id,requested_against_version_id,reason,status)
               values($1,$2,$3,$4,$5,'pending') returning id::text`,
              [row.parent_goal_id, row.parent_owner_user_id, row.parent_owner_person_id, row.active_version_id, parsed.data.reason],
            );
            generatedId = created.rows[0]!.id;
            await audit(client, request.currentUser, request.ip, "goal.change_requested", "goal_change_request", generatedId, undefined, { goalId: row.parent_goal_id, requestedAgainstVersionId: row.active_version_id, source: "linkage", reason: parsed.data.reason });
          }
        }
      }
      await client.query(
        `update goal_linkage_decisions set decision=$2,status='completed',decided_by=$3,decided_by_person_id=$4,
                decided_at=now(),reason=$5,generated_change_request_id=$6 where id=$1`,
        [row.id, parsed.data.decision, request.currentUser.id, request.currentUser.personId, parsed.data.reason, generatedId],
      );
      await audit(client, request.currentUser, request.ip, "goal.linkage_decided", "goal_linkage_decision", row.id, { status: "pending" }, { status: "completed", decision: parsed.data.decision, reason: parsed.data.reason, generatedChangeRequestId: generatedId, createdVersionId });
      await client.query("commit");
      return { ok: true, generatedChangeRequestId: generatedId, createdVersionId };
    } catch (error) {
      await client.query("rollback");
      return unexpectedGoalError(request, reply, error);
    } finally { client.release(); }
  });

  app.get("/api/goals/:id/history", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "目标标识无效" });
    try {
      await assertGoalReadable(db, request.currentUser, params.data.id);
      const versions = await db.query(
        `select version.id::text,version.version_no::text as "versionNo",version.amount::text,version.status,
                version."previousAmount",case when version."previousAmount" is null then null
                     else (version.amount-version."previousAmount")::text end as "amountDifference",
                creator.display_name as "createdByName",signer.display_name as "signedByName",
                version.signature_text as "signatureText",version.signed_at as "signedAt",
                version.change_reason as "changeReason",version.created_at as "createdAt"
         from (
           select source.*,lag(source.amount) over(order by source.version_no) as "previousAmount"
           from goal_versions source where source.goal_id=$1
         ) version join people creator on creator.id=version.created_by_person_id
         left join people signer on signer.id=version.signed_by_person_id
         order by version.version_no desc`,
        [params.data.id],
      );
      const approvals = await db.query(
        `select approval.id::text,approval.goal_version_id::text as "goalVersionId",approval.approval_stage as stage,
                approval.decision,person.display_name as "decidedByName",approval.comment,approval.decided_at as "decidedAt"
         from goal_approvals approval join people person on person.id=approval.decided_by_person_id
         join goal_versions version on version.id=approval.goal_version_id
         where version.goal_id=$1 order by approval.decided_at desc`,
        [params.data.id],
      );
      const changes = await db.query(
        `select request_row.id::text,request_row.requested_amount::text as "requestedAmount",request_row.reason,
                request_row.status,request_row.outcome_comment as "outcomeComment",request_row.created_at as "createdAt",
                requester.display_name as "requestedByName",handler.display_name as "handledByName"
         from goal_change_requests request_row join people requester on requester.id=request_row.requested_by_person_id
         left join people handler on handler.id=request_row.handled_by_person_id
         where request_row.goal_id=$1 order by request_row.created_at desc`,
        [params.data.id],
      );
      const auditRows = await db.query(
        `select log.id::text,log.action,log.entity_type as "entityType",log.entity_id as "entityId",
                actor.display_name as "actorName",log.before_data as "beforeData",log.after_data as "afterData",log.created_at as "createdAt"
         from audit_logs log left join users actor_user on actor_user.id=log.actor_user_id left join people actor on actor.user_id=actor_user.id
         where (log.entity_type='goal' and log.entity_id=$1::text)
            or (log.entity_type='goal_version' and log.entity_id in (select id::text from goal_versions where goal_id=$1::bigint))
            or (log.entity_type='goal_change_request' and log.entity_id in (select id::text from goal_change_requests where goal_id=$1::bigint))
            or (log.entity_type='goal_linkage_decision' and log.entity_id in (
                 select linkage.id::text from goal_linkage_decisions linkage
                 join goal_versions child_version on child_version.id=linkage.triggering_child_version_id
                 where linkage.parent_goal_id=$1::bigint or child_version.goal_id=$1::bigint))
         order by log.created_at desc,log.id desc`,
        [params.data.id],
      );
      return { versions: versions.rows, approvals: approvals.rows, changeRequests: changes.rows, audit: auditRows.rows };
    } catch (error) { return unexpectedGoalError(request, reply, error); }
  });
}
