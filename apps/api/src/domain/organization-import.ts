export type OrganizationSourceRow = Readonly<{
  personName: string;
  groupName: string;
  departmentName: string;
}>;

export type LeadershipMapping = Readonly<{
  source: string;
  confirmedBy: string;
  confirmedAt: string;
  groupLeaders: readonly Readonly<{ departmentName:string; groupName:string; personName:string; effectiveFrom:string }>[];
  departmentSupervisors: readonly Readonly<{ departmentName:string; personName:string; effectiveFrom:string }>[];
}>;

export type OrganizationImportBaseline = Readonly<{
  identities:number;
  historicalPeople:number;
  historicalGroups:number;
  departments:number;
}>;

export const HISTORICAL_ORGANIZATION_BASELINE:OrganizationImportBaseline = {
  identities:63,
  historicalPeople:59,
  historicalGroups:16,
  departments:5,
};

export type OrganizationPreflightReport = Readonly<{
  ready: boolean;
  counts: Readonly<{
    identities: number;
    historicalPeople: number;
    historicalGroups: number;
    departments: number;
    peopleWithoutHistoricalPerformance: number;
  }>;
  identityStatuses:readonly Readonly<{
    personName:string;
    hasHistoricalPerformance:boolean;
    departmentName:string|null;
    groupName:string|null;
    membershipStatus:"baseline_candidate"|"identity_only_pending_effective_date";
  }>[];
  peopleWithoutHistoricalPerformance: string[];
  blockers: string[];
}>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value:string):boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date=new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;
}

function unitKey(departmentName: string, groupName: string): string {
  return `${departmentName}\u0000${groupName}`;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

export function preflightOrganizationImport(
  organizationRows: readonly OrganizationSourceRow[],
  ledgerPeople: ReadonlySet<string>,
  ledgerUnits: ReadonlySet<string>,
  mapping?: LeadershipMapping,
  ledgerDates:readonly Readonly<{ personName:string;departmentName:string;groupName:string;occurredOn:string }>[] = [],
  expectedBaseline?:OrganizationImportBaseline,
): OrganizationPreflightReport {
  const blockers: string[] = [];
  const people = new Set(organizationRows.map((row) => row.personName));
  const departments = new Set(organizationRows.filter((row) => ledgerPeople.has(row.personName)).map((row) => row.departmentName));
  const duplicatePeople = duplicates(organizationRows.map((row) => row.personName));
  if (duplicatePeople.length) blockers.push(`人员姓名重复：${duplicatePeople.join("、")}`);

  const missingPeople = [...ledgerPeople].filter((name) => !people.has(name)).sort();
  if (missingPeople.length) blockers.push(`历史业绩人员缺少身份行：${missingPeople.join("、")}`);

  const rowsByPerson = new Map(organizationRows.map((row) => [row.personName, row]));
  const mismatchedUnits = [...ledgerUnits].filter((key) => {
    const [personName, departmentName, groupName] = key.split("\u0000");
    const row = rowsByPerson.get(personName!);
    return !row || row.departmentName !== departmentName || row.groupName !== groupName;
  });
  if (mismatchedUnits.length) blockers.push(`历史业绩与组织表归属不一致：${mismatchedUnits.length} 人次`);

  const historicalUnitKeys = new Set(
    organizationRows.filter((row) => ledgerPeople.has(row.personName)).map((row) => unitKey(row.departmentName, row.groupName)),
  );
  if(expectedBaseline){
    const actual:OrganizationImportBaseline={
      identities:people.size,
      historicalPeople:ledgerPeople.size,
      historicalGroups:historicalUnitKeys.size,
      departments:departments.size,
    };
    const labels:Readonly<Record<keyof OrganizationImportBaseline,string>>={identities:"人员身份",historicalPeople:"历史人员",historicalGroups:"历史小组",departments:"历史部门"};
    for(const key of Object.keys(expectedBaseline) as (keyof OrganizationImportBaseline)[]){
      if(actual[key]!==expectedBaseline[key])blockers.push(`迁移基线不一致：${labels[key]}应为 ${expectedBaseline[key]}，实际 ${actual[key]}`);
    }
  }
  if (!mapping) {
    blockers.push("缺少人事确认的负责人映射及确认元数据");
  } else {
    if (!mapping.source.trim() || !mapping.confirmedBy.trim() || !isIsoDate(mapping.confirmedAt)) {
      blockers.push("负责人映射缺少有效来源、确认人或确认日期");
    }
    const leaders = new Map<string,string>();
    for (const row of mapping.groupLeaders) {
      const key = unitKey(row.departmentName, row.groupName);
      if (leaders.has(key)) blockers.push(`小组负责人重复：${row.departmentName}/${row.groupName}`);
      leaders.set(key, row.personName);
      if (!historicalUnitKeys.has(key)) blockers.push(`负责人映射包含未知历史小组：${row.departmentName}/${row.groupName}`);
      if (!people.has(row.personName)) blockers.push(`小组负责人不存在人员身份：${row.personName}`);
      if (!isIsoDate(row.effectiveFrom)) blockers.push(`小组负责人日期无效：${row.departmentName}/${row.groupName}`);
    }
    for (const key of historicalUnitKeys) {
      if (!leaders.has(key)) blockers.push(`缺少小组负责人：${key.replace("\u0000", "/")}`);
    }
    const supervisors = new Map<string,string>();
    for (const row of mapping.departmentSupervisors) {
      if (supervisors.has(row.departmentName)) blockers.push(`部门主管重复：${row.departmentName}`);
      supervisors.set(row.departmentName, row.personName);
      if (!departments.has(row.departmentName)) blockers.push(`主管映射包含未知历史部门：${row.departmentName}`);
      if (!people.has(row.personName)) blockers.push(`部门主管不存在人员身份：${row.personName}`);
      if (!isIsoDate(row.effectiveFrom)) blockers.push(`部门主管日期无效：${row.departmentName}`);
    }
    for (const department of departments) {
      if (!supervisors.has(department)) blockers.push(`缺少部门主管：${department}`);
    }
    for(const row of ledgerDates){
      const leader=mapping.groupLeaders.find((item)=>item.departmentName===row.departmentName&&item.groupName===row.groupName);
      const supervisor=mapping.departmentSupervisors.find((item)=>item.departmentName===row.departmentName);
      if(leader&&leader.effectiveFrom>row.occurredOn)blockers.push(`小组负责人未覆盖历史日期：${row.departmentName}/${row.groupName}/${row.occurredOn}`);
      if(supervisor&&supervisor.effectiveFrom>row.occurredOn)blockers.push(`部门主管未覆盖历史日期：${row.departmentName}/${row.occurredOn}`);
    }
  }

  const peopleWithoutHistoricalPerformance = [...people].filter((name) => !ledgerPeople.has(name)).sort();
  const identityStatuses=[...people].sort().map((personName)=>{
    const row=rowsByPerson.get(personName)!;
    const hasHistoricalPerformance=ledgerPeople.has(personName);
    return {
      personName,
      hasHistoricalPerformance,
      departmentName:hasHistoricalPerformance?row.departmentName:null,
      groupName:hasHistoricalPerformance?row.groupName:null,
      membershipStatus:hasHistoricalPerformance?"baseline_candidate" as const:"identity_only_pending_effective_date" as const,
    };
  });
  return {
    ready: blockers.length === 0,
    counts: {
      identities: people.size,
      historicalPeople: ledgerPeople.size,
      historicalGroups: historicalUnitKeys.size,
      departments: departments.size,
      peopleWithoutHistoricalPerformance: peopleWithoutHistoricalPerformance.length,
    },
    identityStatuses,
    peopleWithoutHistoricalPerformance,
    blockers:[...new Set(blockers)],
  };
}

export function ledgerUnitEvidenceKey(personName:string, departmentName:string, groupName:string):string {
  return `${personName}\u0000${departmentName}\u0000${groupName}`;
}
