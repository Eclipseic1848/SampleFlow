import type { Database } from "../db.js";
import type { CurrentUser } from "./auth.js";

type QueryDatabase = Pick<Database, "query">;

export type BusinessScope = "none" | "self" | "group" | "department" | "all";

type RolePolicy = Readonly<{
  name: string;
  performanceScope: BusinessScope;
  goalScope: BusinessScope;
  businessOperations: readonly string[];
  targetResponsibilities: string;
  exportPermission: string;
  forbidden: readonly string[];
  performanceEdit: boolean;
  accountAdmin: boolean;
  organizationAdmin: boolean;
}>;

export const ROLE_POLICIES = {
  system_admin: { name: "系统管理员", performanceScope: "none", goalScope: "none", businessOperations: ["账号与角色维护", "组织与任职维护"], targetResponsibilities: "无", exportPermission: "无", forbidden: ["业务查看与导出", "业绩与目标操作"], performanceEdit: false, accountAdmin: true, organizationAdmin: true },
  sales_assistant: { name: "销售助理", performanceScope: "all", goalScope: "none", businessOperations: ["全公司业绩录入与调整", "业绩账本查看"], targetResponsibilities: "无", exportPermission: "全公司业绩", forbidden: ["目标编辑与审批", "账号与组织维护"], performanceEdit: true, accountAdmin: false, organizationAdmin: false },
  sales_assistant_leader: { name: "销售助理组长", performanceScope: "all", goalScope: "none", businessOperations: ["全公司业绩录入与调整", "月度核对与关闭月更正", "历史订单核对"], targetResponsibilities: "无", exportPermission: "全公司业绩", forbidden: ["目标编辑与审批", "账号与组织维护"], performanceEdit: true, accountAdmin: false, organizationAdmin: false },
  sales_manager: { name: "销售经理", performanceScope: "all", goalScope: "all", businessOperations: ["销售组织业务查看"], targetResponsibilities: "录入销售经理总目标；下达主管目标", exportPermission: "销售组织业务", forbidden: ["业绩录入与调整", "账号与组织维护"], performanceEdit: false, accountAdmin: false, organizationAdmin: false },
  sales_supervisor: { name: "业务主管", performanceScope: "department", goalScope: "department", businessOperations: ["本人及所负责部门业务查看"], targetResponsibilities: "确认部门目标；下达组长目标", exportPermission: "本人及所负责部门", forbidden: ["业绩录入与调整", "账号与组织维护"], performanceEdit: false, accountAdmin: false, organizationAdmin: false },
  sales_leader: { name: "业务员组长", performanceScope: "group", goalScope: "group", businessOperations: ["本人及所负责小组业务查看"], targetResponsibilities: "确认小组目标；下达业务员目标", exportPermission: "本人及所负责小组", forbidden: ["业绩录入与调整", "账号与组织维护"], performanceEdit: false, accountAdmin: false, organizationAdmin: false },
  salesperson: { name: "业务员", performanceScope: "self", goalScope: "self", businessOperations: ["本人业务查看"], targetResponsibilities: "确认个人目标；申请修改本人目标", exportPermission: "本人业务", forbidden: ["业绩录入与调整", "编辑本人目标", "账号与组织维护"], performanceEdit: false, accountAdmin: false, organizationAdmin: false },
  hr: { name: "人事部", performanceScope: "all", goalScope: "all", businessOperations: ["全公司业务只读", "目标最终审批", "记账期间关闭与更正审批", "历史订单核对审批"], targetResponsibilities: "审批目标确认与修改申请", exportPermission: "全公司业务", forbidden: ["业绩录入与调整", "目标金额编辑", "账号与组织维护"], performanceEdit: false, accountAdmin: false, organizationAdmin: false },
  general_manager: { name: "总经理", performanceScope: "all", goalScope: "all", businessOperations: ["全公司业务只读"], targetResponsibilities: "批准或拒绝销售经理总目标", exportPermission: "全公司业务", forbidden: ["业绩录入与调整", "目标金额编辑", "账号与组织维护"], performanceEdit: false, accountAdmin: false, organizationAdmin: false },
} as const satisfies Record<string, RolePolicy>;

export const ROLE_PERMISSION_MATRIX = Object.entries(ROLE_POLICIES).map(([code, policy]) => ({
  code,
  name: policy.name,
  businessScope: policy.performanceScope,
  businessOperations: policy.businessOperations,
  targetResponsibilities: policy.targetResponsibilities,
  exportPermission: policy.exportPermission,
  forbidden: policy.forbidden,
}));

function policiesFor(roles: readonly string[]): RolePolicy[] {
  return roles.flatMap((role) => {
    const policy = ROLE_POLICIES[role as keyof typeof ROLE_POLICIES];
    return policy ? [policy] : [];
  });
}

export function capabilitiesForRoles(roles: readonly string[]) {
  const policies = policiesFor(roles);
  const viewPerformance = policies.some((policy) => policy.performanceScope !== "none");
  const viewGoals = policies.some((policy) => policy.goalScope !== "none");
  return {
    viewPerformance,
    viewGoals,
    viewOrganization: viewPerformance || viewGoals || policies.some((policy) => policy.organizationAdmin),
    viewApprovals: viewGoals,
    editPerformance: policies.some((policy) => policy.performanceEdit),
    exportPerformance: viewPerformance,
    exportGoals: viewGoals,
    manageAccounts: policies.some((policy) => policy.accountAdmin),
    manageOrganization: policies.some((policy) => policy.organizationAdmin),
  };
}

export const BUSINESS_DATE_SQL = "(now() at time zone 'Asia/Shanghai')::date";

export type PerformanceAccess = Readonly<{
  all: boolean;
  departmentIds: string[];
  groupIds: string[];
  personIds: string[];
}>;

export async function resolvePerformanceAccess(database: QueryDatabase, user: CurrentUser): Promise<PerformanceAccess> {
  const scopes = new Set(policiesFor(user.roles).map((policy) => policy.performanceScope));
  const personIds = [...scopes].some((scope) => ["self", "group", "department"].includes(scope)) ? [user.personId] : [];
  const responsibility = scopes.has("group") || scopes.has("department")
    ? await database.query<{ org_unit_id: string; responsibility_type: "leader" | "supervisor" }>(
      `select distinct org_unit_id::text,responsibility_type
       from org_responsibilities
       where person_id=$1 and effective_from<=${BUSINESS_DATE_SQL}
         and (effective_to is null or effective_to>=${BUSINESS_DATE_SQL})`,
      [user.personId],
    )
    : { rows: [] };
  return {
    all: scopes.has("all"),
    departmentIds: scopes.has("department")
      ? responsibility.rows.filter((row) => row.responsibility_type === "supervisor").map((row) => row.org_unit_id)
      : [],
    groupIds: scopes.has("group")
      ? responsibility.rows.filter((row) => row.responsibility_type === "leader").map((row) => row.org_unit_id)
      : [],
    personIds,
  };
}

export function canReadPerformance(access: PerformanceAccess): boolean {
  return access.all || access.personIds.length > 0 || access.groupIds.length > 0 || access.departmentIds.length > 0;
}

export function performanceScopeSql(alias: string, firstParameter: number): string {
  return `($${firstParameter}::boolean
    or ${alias}.salesperson_person_id=any($${firstParameter + 1}::bigint[])
    or ${alias}.group_unit_id=any($${firstParameter + 2}::bigint[])
    or ${alias}.department_unit_id=any($${firstParameter + 3}::bigint[]))`;
}

export function performanceScopeValues(access: PerformanceAccess): unknown[] {
  return [access.all, access.personIds, access.groupIds, access.departmentIds];
}

export type GoalAccess = Readonly<{ all: boolean; ownerPersonIds: string[] }>;

export async function resolveGoalAccess(database: QueryDatabase, user: CurrentUser): Promise<GoalAccess> {
  const scopes = new Set(policiesFor(user.roles).map((policy) => policy.goalScope));
  if (scopes.has("all")) return { all: true, ownerPersonIds: [] };
  const ownerPersonIds = new Set<string>();
  if ([...scopes].some((scope) => ["self", "group", "department"].includes(scope))) ownerPersonIds.add(user.personId);
  if (scopes.has("group") || scopes.has("department")) {
    const performanceAccess = await resolvePerformanceAccess(database, user);
    const result = await database.query<{ person_id: string }>(
      `select distinct m.person_id::text
       from org_memberships m
       where m.effective_from<=${BUSINESS_DATE_SQL} and (m.effective_to is null or m.effective_to>=${BUSINESS_DATE_SQL})
         and (m.group_id=any($1::bigint[]) or m.department_id=any($2::bigint[]))`,
      [
        scopes.has("group") ? performanceAccess.groupIds : [],
        scopes.has("department") ? performanceAccess.departmentIds : [],
      ],
    );
    for (const row of result.rows) ownerPersonIds.add(row.person_id);
  }
  return { all: false, ownerPersonIds: [...ownerPersonIds] };
}

export function canReadGoals(access: GoalAccess): boolean {
  return access.all || access.ownerPersonIds.length > 0;
}

export function pendingGoalSql(goalAlias: string, versionAlias: string, firstParameter: number): string {
  return `((${versionAlias}.status='pending_signature' and ${goalAlias}.owner_person_id=$${firstParameter}
      and (${goalAlias}.goal_level='sales_manager' or ${versionAlias}.created_by_person_id<>$${firstParameter}))
    or ($${firstParameter + 1}::boolean and ${versionAlias}.status='pending_gm' and ${goalAlias}.goal_level='sales_manager'
      and ${versionAlias}.created_by_person_id<>$${firstParameter}
      and ${versionAlias}.signed_by_person_id is distinct from $${firstParameter})
    or ($${firstParameter + 2}::boolean and ${versionAlias}.status='pending_hr'
      and ${versionAlias}.created_by_person_id<>$${firstParameter}
      and ${versionAlias}.signed_by_person_id is distinct from $${firstParameter}
      and not exists (
        select 1 from goal_approvals pending_approval
        where pending_approval.goal_version_id=${versionAlias}.id
          and pending_approval.approval_stage='general_manager'
          and pending_approval.decision='approved'
          and pending_approval.decided_by_person_id=$${firstParameter}
      )))`;
}

export function pendingGoalValues(user: CurrentUser): unknown[] {
  return [user.personId, user.roles.includes("general_manager"), user.roles.includes("hr")];
}
