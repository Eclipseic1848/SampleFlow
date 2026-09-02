import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { pageNumberSchema, pageSizeSchema, postgresBigintIdSchema } from "../validation.js";
import { canReadGoals, canReadPerformance, performanceScopeSql, performanceScopeValues, resolveGoalAccess, resolvePerformanceAccess } from "./authorization.js";

const auditFiltersSchema = z.strictObject({
  person: z.string().trim().max(100).optional().default(""),
  action: z.string().trim().max(100).optional().default(""),
  entityType: z.string().trim().max(100).optional().default(""),
  entityId: z.string().trim().max(100).optional().default(""),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
const querySchema = auditFiltersSchema.extend({ cursor: z.string().max(2048).optional(), snapshot:z.string().max(2048).optional(), page:pageNumberSchema.optional(), pageSize:pageSizeSchema.optional() });
const auditCursorSchema = z.strictObject({
  version: z.literal(1),
  userId: postgresBigintIdSchema,
  filters: auditFiltersSchema,
  id: postgresBigintIdSchema,
  cutoffId: postgresBigintIdSchema,
});
const auditSnapshotSchema = z.strictObject({
  version:z.literal(1),
  userId:postgresBigintIdSchema,
  filters:auditFiltersSchema,
  cutoffId:z.union([z.literal("0"),postgresBigintIdSchema]),
});
const PAGE_SIZE = 50;
const SENSITIVE_FIELD = /password|token|secret|credential|authorization|cookie|session/i;

function encodeAuditCursor(value: z.infer<typeof auditCursorSchema>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeAuditCursor(value: string): z.infer<typeof auditCursorSchema> | null {
  try {
    const parsed = auditCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeAuditSnapshot(value:z.infer<typeof auditSnapshotSchema>):string {
  return Buffer.from(JSON.stringify(value),"utf8").toString("base64url");
}

function decodeAuditSnapshot(value:string):z.infer<typeof auditSnapshotSchema>|null {
  try {
    const parsed=auditSnapshotSchema.safeParse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));
    return parsed.success?parsed.data:null;
  } catch {
    return null;
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) => SENSITIVE_FIELD.test(key) ? [] : [[key, redact(nested)]]));
}

export async function registerAudits(app: FastifyInstance, db: Database) {
  app.get("/api/audits", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success || (parsed.data.from && parsed.data.to && Date.parse(parsed.data.from) > Date.parse(parsed.data.to))) {
      return reply.code(400).send({ message: "审计查询条件无效" });
    }

    const { cursor: encodedCursor, snapshot:encodedSnapshot, page:requestedPage, pageSize:requestedPageSize, ...filters } = parsed.data;
    const numbered=requestedPage!==undefined||requestedPageSize!==undefined;
    if((numbered&&encodedCursor)||(!numbered&&encodedSnapshot))return reply.code(400).send({message:"页码快照只能与页码一起使用，且不能与游标混用"});
    const page=requestedPage??1;const pageSize=requestedPageSize??20;
    const cursor = encodedCursor ? decodeAuditCursor(encodedCursor) : null;
    if (encodedCursor && (!cursor || cursor.userId !== request.currentUser.id || JSON.stringify(cursor.filters) !== JSON.stringify(filters))) {
      return reply.code(400).send({ message: "审计分页游标无效或已不适用于当前查询" });
    }
    const snapshot=encodedSnapshot?decodeAuditSnapshot(encodedSnapshot):null;
    if(encodedSnapshot&&(!snapshot||snapshot.userId!==request.currentUser.id||JSON.stringify(snapshot.filters)!==JSON.stringify(filters))){
      return reply.code(400).send({message:"审计页码快照无效或已不适用于当前查询"});
    }

    const systemAdmin = request.currentUser.roles.includes("system_admin");
    const performanceAccess = await resolvePerformanceAccess(db, request.currentUser);
    const goalAccess = await resolveGoalAccess(db, request.currentUser);
    const performanceReader = canReadPerformance(performanceAccess);
    if (!systemAdmin && !performanceReader && !canReadGoals(goalAccess)) {
      return reply.code(403).send({ message: "当前角色没有审计查询权限" });
    }
    const safeEntityId = "case when audit.entity_id ~ '^[1-9][0-9]{0,18}$' and (length(audit.entity_id)<19 or audit.entity_id<='9223372036854775807') then audit.entity_id::bigint end";
    const client = await db.connect();
    try {
      await client.query("begin");
      const result = await client.query<{audits:Array<{
      action: string;
      actorDisplayName: string | null;
      actorPersonId: string | null;
      actorUsername: string | null;
      afterData: unknown;
      beforeData: unknown;
      createdAt: string;
      entityId: string | null;
      entityType: string;
      id: string;
      }>;cutoffId:string;totalCount:string}>(
      `with cutoff as (select coalesce($20::bigint,max(id),0) as id from audit_logs), filtered as materialized (
       select audit.id as "__id",audit.id::text,
               actor_person.id::text as "actorPersonId",actor_user.username as "actorUsername",actor_user.display_name as "actorDisplayName",
               audit.action,audit.entity_type as "entityType",audit.entity_id as "entityId",
               audit.before_data as "beforeData",audit.after_data as "afterData",audit.created_at as "createdAt"
       from audit_logs audit
       cross join cutoff
       left join users actor_user on actor_user.id=audit.actor_user_id
       left join people actor_person on actor_person.user_id=actor_user.id
       where (
         ($1::boolean and (audit.action like 'auth.%' or audit.action like 'organization.%'))
         or ((audit.action like 'goal.%' or audit.action like 'performance.%' or audit.action like 'accounting.%' or audit.action like 'import.%') and (
           exists(
             select 1 from goals scoped_goal
             left join goals parent_goal on parent_goal.id=scoped_goal.parent_goal_id
             left join goals grandparent_goal on grandparent_goal.id=parent_goal.parent_goal_id
             where ($2::boolean
               or scoped_goal.owner_person_id=any($3::bigint[])
               or scoped_goal.org_unit_id=any($4::bigint[]) or parent_goal.org_unit_id=any($4::bigint[]) or grandparent_goal.org_unit_id=any($4::bigint[])
               or scoped_goal.org_unit_id=any($5::bigint[]) or parent_goal.org_unit_id=any($5::bigint[]) or grandparent_goal.org_unit_id=any($5::bigint[])
             ) and (
               (audit.entity_type='goal' and scoped_goal.id=${safeEntityId})
               or (audit.entity_type='goal_version' and exists(select 1 from goal_versions version_row where version_row.id=${safeEntityId} and version_row.goal_id=scoped_goal.id))
               or (audit.entity_type='goal_change_request' and exists(select 1 from goal_change_requests request_row where request_row.id=${safeEntityId} and request_row.goal_id=scoped_goal.id))
               or (audit.entity_type='goal_linkage_decision' and exists(
                 select 1 from goal_linkage_decisions linkage_row
                 left join goal_versions child_version on child_version.id=linkage_row.triggering_child_version_id
                 where linkage_row.id=${safeEntityId} and (linkage_row.parent_goal_id=scoped_goal.id or child_version.goal_id=scoped_goal.id)
               ))
             )
           )
           or exists(
             select 1 from performance_events scoped_event
             where ${performanceScopeSql("scoped_event", 6)} and (
               (audit.entity_type='performance_event' and scoped_event.id=${safeEntityId})
               or scoped_event.id=(
                 select latest_event.id from performance_events latest_event
                 where latest_event.order_id=case audit.entity_type
                   when 'performance_order' then ${safeEntityId}
                   when 'accounting_correction' then (select correction.order_id from accounting_correction_requests correction where correction.id=${safeEntityId})
                   when 'historical_order_review' then (select review.order_id from historical_order_reviews review where review.id=${safeEntityId})
                 end
                   and latest_event.created_at<=audit.created_at
                 order by latest_event.order_sequence desc,latest_event.id desc limit 1
               )
             )
           )
           or ($6::boolean and audit.entity_type in ('accounting_period','import_config','import_batch'))
           or ($18::boolean and audit.entity_type='order_export' and ($6::boolean or audit.actor_user_id=$17::bigint))
         ))
       )
         and ($10='' or position(lower($10) in lower(coalesce(actor_user.username,'')||' '||coalesce(actor_user.display_name,'')||' '||coalesce(actor_person.id::text,'')))>0)
         and ($11='' or position(lower($11) in lower(audit.action))>0)
         and ($12='' or audit.entity_type=$12)
         and ($13='' or coalesce(audit.entity_id,'')=$13)
          and ($14::timestamptz is null or audit.created_at>=$14::timestamptz)
          and ($15::timestamptz is null or audit.created_at<=$15::timestamptz)
          and ($16::bigint is null or audit.id<$16::bigint)
          and audit.id<=cutoff.id
       ), page_rows as (
         select * from filtered order by "__id" desc limit $19 offset $21
       )
       select cutoff.id::text as "cutoffId",(select count(*)::text from filtered) as "totalCount",
              coalesce(jsonb_agg(to_jsonb(page_rows)-'__id' order by page_rows."__id" desc)
                filter(where page_rows."__id" is not null),'[]'::jsonb) as audits
       from cutoff left join page_rows on true group by cutoff.id`,
      [
        systemAdmin,
        goalAccess.all,
        goalAccess.selfPersonIds,
        goalAccess.groupIds,
        goalAccess.departmentIds,
        ...performanceScopeValues(performanceAccess),
        filters.person,
        filters.action,
        filters.entityType,
        filters.entityId,
        filters.from ?? null,
        filters.to ?? null,
        cursor?.id ?? null,
        request.currentUser.id,
        performanceReader,
        numbered?pageSize:PAGE_SIZE + 1,
        cursor?.cutoffId ?? snapshot?.cutoffId ?? null,
        numbered?(page-1)*pageSize:0,
      ],
    );
      await client.query("commit");
      const row=result.rows[0]!;
      const totalCount=Number(row.totalCount);
      const hasNext = numbered?page*pageSize<totalCount:row.audits.length > PAGE_SIZE;
      const rows=numbered?row.audits:row.audits.slice(0,PAGE_SIZE);
      const audits = rows.map((audit) => ({
        ...audit,
        beforeData: redact(audit.beforeData),
        afterData: redact(audit.afterData),
      }));
      if(numbered)return{audits,page,pageSize,totalCount,snapshot:encodeAuditSnapshot({version:1,userId:request.currentUser.id,filters,cutoffId:row.cutoffId})};
      const last = audits.at(-1);
      return {
        audits,
        pageSize: PAGE_SIZE,
        nextCursor: hasNext && last && row.cutoffId!=="0"
          ? encodeAuditCursor({ version: 1, userId: request.currentUser.id, filters, id: last.id, cutoffId:row.cutoffId })
          : null,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
}
