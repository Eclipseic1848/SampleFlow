import type { Database } from "../db.js";
import {
  ledgerUnitEvidenceKey,
  preflightOrganizationImport,
  type LeadershipMapping,
  type OrganizationImportBaseline,
  type OrganizationPreflightReport,
  type OrganizationSourceRow,
} from "../domain/organization-import.js";

export type LedgerOrganizationRow = Readonly<OrganizationSourceRow & { occurredOn:string;amount:number }>;

export type OrganizationImportInput = Readonly<{
  sourceFile:string;
  sourceSha256:string;
  mappingFile:string;
  mappingSha256:string;
  organizationRows:readonly OrganizationSourceRow[];
  ledgerRows:readonly LedgerOrganizationRow[];
  mapping:LeadershipMapping;
  expectedBaseline:OrganizationImportBaseline;
}>;

export type OrganizationImportReport = OrganizationPreflightReport & Readonly<{
  skipped:boolean;
  importedIdentities:number;
  importedMemberships:number;
  importedResponsibilities:number;
  backfilledOrders:number;
  backfilledEvents:number;
  eventAmountBefore:string;
  eventAmountAfter:string;
  sourceAmount:string;
  mappingConfirmation:Readonly<{ source:string; confirmedBy:string; confirmedAt:string }>;
  mappingSnapshot:Pick<LeadershipMapping,"groupLeaders"|"departmentSupervisors">;
  mappingDifferences:string[];
  accountBindingCandidates:readonly Readonly<{ personName:string; usernames:string[] }>[];
  identityAccountStatuses:readonly Readonly<{
    personName:string;
    status:"bound"|"unbound"|"candidate"|"ambiguous";
    boundUsername:string|null;
    candidateUsernames:string[];
  }>[];
}>;

export class OrganizationImportError extends Error {
  constructor(message:string, readonly report:OrganizationPreflightReport & { mappingDifferences?:string[] }) {
    super(message);
  }
}

function mappingDifferences(previous:OrganizationImportReport["mappingSnapshot"],current:LeadershipMapping):string[]{
  const describe=(rows:readonly Record<string,string>[],keys:readonly string[])=>new Map(rows.map((row)=>[keys.map((key)=>row[key]).join("/"),`${row.personName}@${row.effectiveFrom}`]));
  const pairs:[string,Map<string,string>,Map<string,string>][]=[
    ["小组负责人",describe(previous.groupLeaders,["departmentName","groupName"]),describe(current.groupLeaders,["departmentName","groupName"])],
    ["部门主管",describe(previous.departmentSupervisors,["departmentName"]),describe(current.departmentSupervisors,["departmentName"])],
  ];
  const result:string[]=[];
  for(const [kind,before,after] of pairs){
    for(const key of new Set([...before.keys(),...after.keys()])){
      if(!before.has(key))result.push(`${kind}新增：${key}=${after.get(key)}`);
      else if(!after.has(key))result.push(`${kind}删除：${key}=${before.get(key)}`);
      else if(before.get(key)!==after.get(key))result.push(`${kind}变更：${key} ${before.get(key)} -> ${after.get(key)}`);
    }
  }
  return result;
}

function sourceKey(personName:string):string {
  return `legacy-organization:${personName}`;
}

export async function applyOrganizationImport(database:Database, input:OrganizationImportInput):Promise<OrganizationImportReport> {
  const ledgerPeople = new Set(input.ledgerRows.map((row) => row.personName));
  const ledgerUnits = new Set(input.ledgerRows.map((row) => ledgerUnitEvidenceKey(row.personName,row.departmentName,row.groupName)));
  const preflight = preflightOrganizationImport(input.organizationRows,ledgerPeople,ledgerUnits,input.mapping,input.ledgerRows,input.expectedBaseline);
  if(!preflight.ready)throw new OrganizationImportError("组织导入预检未通过",preflight);
  const client = await database.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('sampleflow.organization-import'))");
    const previous = await client.query<{mapping_sha256:string;report:OrganizationImportReport}>(
      "select mapping_sha256,report from organization_import_runs where source_sha256=$1 order by id desc limit 1",
      [input.sourceSha256],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].mapping_sha256 !== input.mappingSha256) {
        const differences=mappingDifferences(previous.rows[0].report.mappingSnapshot,input.mapping);
        throw new OrganizationImportError("同一来源已使用不同负责人映射导入，禁止覆盖", {
          ...preflight,
          ready:false,
          blockers:[`已应用映射 ${previous.rows[0].mapping_sha256}，当前映射 ${input.mappingSha256}`,...differences],
          mappingDifferences:differences,
        });
      }
      await client.query("rollback");
      return { ...previous.rows[0].report, skipped:true };
    }

    const sourceRun=await client.query<{source_rows:number;imported_events:number}>(
      "select source_rows,imported_events from legacy_import_runs where source_sha256=$1",
      [input.sourceSha256],
    );
    const sourceRunCount=await client.query<{count:string}>("select count(*)::text as count from legacy_import_runs");
    if(sourceRun.rows.length!==1||Number(sourceRunCount.rows[0]!.count)!==1){
      throw new OrganizationImportError("组织来源无法与唯一既有历史账本绑定",{
        ...preflight,ready:false,blockers:["必须先完成且只能存在一个与来源 SHA-256 一致的历史账本导入批次"],
      });
    }
    if(sourceRun.rows[0]!.source_rows!==input.ledgerRows.length||sourceRun.rows[0]!.imported_events!==input.ledgerRows.length){
      throw new OrganizationImportError("组织来源行数与既有历史账本不一致",{
        ...preflight,ready:false,blockers:[`来源 ${input.ledgerRows.length} 行；账本记录 ${sourceRun.rows[0]!.source_rows} 行/${sourceRun.rows[0]!.imported_events} 事件`],
      });
    }

    let importedIdentities = 0;
    const people = new Map<string,string>();
    for (const row of input.organizationRows) {
      const inserted = await client.query<{id:string}>(
        `insert into people(display_name,identity_source,source_key)
         values($1,'legacy_organization',$2) on conflict(source_key) do nothing returning id::text`,
        [row.personName,sourceKey(row.personName)],
      );
      importedIdentities += inserted.rowCount ?? 0;
      const person = await client.query<{id:string;display_name:string}>("select id::text,display_name from people where source_key=$1",[sourceKey(row.personName)]);
      if (!person.rows[0] || person.rows[0].display_name !== row.personName) throw new Error(`人员来源键冲突：${row.personName}`);
      people.set(row.personName,person.rows[0].id);
    }

    const historicalRows = input.organizationRows.filter((row) => ledgerPeople.has(row.personName));
    const departments = new Map<string,string>();
    for (const name of new Set(historicalRows.map((row) => row.departmentName))) {
      await client.query("insert into org_units(name,unit_type) values($1,'department') on conflict do nothing",[name]);
      const unit = await client.query<{id:string}>("select id::text from org_units where unit_type='department' and lower(name)=lower($1)",[name]);
      departments.set(name,unit.rows[0]!.id);
    }
    const groups = new Map<string,string>();
    for (const row of historicalRows) {
      const key = `${row.departmentName}\u0000${row.groupName}`;
      if (groups.has(key)) continue;
      const departmentId = departments.get(row.departmentName)!;
      await client.query("insert into org_units(name,unit_type,parent_id) values($1,'group',$2) on conflict do nothing",[row.groupName,departmentId]);
      const unit = await client.query<{id:string}>("select id::text from org_units where unit_type='group' and parent_id=$1 and lower(name)=lower($2)",[departmentId,row.groupName]);
      groups.set(key,unit.rows[0]!.id);
    }

    let importedMemberships = 0;
    const provenance = JSON.stringify({
      sourceSha256:input.sourceSha256,mappingSha256:input.mappingSha256,baseline:"2026-01-01",
      mappingConfirmation:{ source:input.mapping.source,confirmedBy:input.mapping.confirmedBy,confirmedAt:input.mapping.confirmedAt },
    });
    for (const row of historicalRows) {
      const personId = people.get(row.personName)!;
      const departmentId = departments.get(row.departmentName)!;
      const groupId = groups.get(`${row.departmentName}\u0000${row.groupName}`)!;
      const existing = await client.query<{department_id:string;group_id:string;effective_from:string;effective_to:string|null}>(
        "select department_id::text,group_id::text,effective_from::text,effective_to::text from org_memberships where person_id=$1",
        [personId],
      );
      if (existing.rows.length) {
        const exact = existing.rows.some((item) => item.department_id===departmentId && item.group_id===groupId && item.effective_from==="2026-01-01" && item.effective_to===null);
        if (!exact) throw new Error(`人员已有不同任职，禁止覆盖：${row.personName}`);
        continue;
      }
      await client.query(
        `insert into org_memberships(person_id,department_id,group_id,effective_from,provenance)
         values($1,$2,$3,'2026-01-01',$4::jsonb)`,
        [personId,departmentId,groupId,provenance],
      );
      importedMemberships += 1;
    }

    let importedResponsibilities = 0;
    for (const responsibility of [
      ...input.mapping.groupLeaders.map((row) => ({ personName:row.personName, unitId:groups.get(`${row.departmentName}\u0000${row.groupName}`), type:"leader", effectiveFrom:row.effectiveFrom })),
      ...input.mapping.departmentSupervisors.map((row) => ({ personName:row.personName, unitId:departments.get(row.departmentName), type:"supervisor", effectiveFrom:row.effectiveFrom })),
    ]) {
      const personId = people.get(responsibility.personName);
      if (!personId || !responsibility.unitId) throw new Error(`负责人映射无法解析：${responsibility.personName}`);
      await client.query(
        `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from,provenance)
         values($1,$2,$3,$4,$5::jsonb)`,
        [personId,responsibility.unitId,responsibility.type,responsibility.effectiveFrom,provenance],
      );
      importedResponsibilities += 1;
    }

    await client.query("update org_units set is_active=true where id=any($1::bigint[])",[[...departments.values(),...groups.values()]]);

    const amountBefore = await client.query<{amount:string}>("select coalesce(sum(delta_amount),0)::text as amount from performance_events where event_type='legacy_adjustment'");
    const sourceAmount=(Math.round(input.ledgerRows.reduce((sum,row)=>sum+row.amount,0)*100)/100).toFixed(2);
    const sourceEventCount=await client.query<{count:string}>("select count(*)::text as count from performance_events where event_type='legacy_adjustment'");
    if(Number(sourceEventCount.rows[0]!.count)!==input.ledgerRows.length||Number(amountBefore.rows[0]!.amount)!==Number(sourceAmount)){
      throw new OrganizationImportError("组织来源数量或金额与既有历史账本不一致",{
        ...preflight,ready:false,blockers:[`来源 ${input.ledgerRows.length} 行/${sourceAmount}；账本 ${sourceEventCount.rows[0]!.count} 事件/${amountBefore.rows[0]!.amount}`],
      });
    }
    const unresolved = await client.query<{count:string}>(
      `select count(*)::text as count from performance_events e
       where e.event_type='legacy_adjustment' and e.salesperson_person_id is null
         and not exists(
           select 1 from people p join org_memberships m on m.person_id=p.id
           join org_units d on d.id=m.department_id join org_units g on g.id=m.group_id
           join org_responsibilities lr on lr.org_unit_id=g.id and lr.responsibility_type='leader'
           join org_responsibilities sr on sr.org_unit_id=d.id and sr.responsibility_type='supervisor'
           where p.source_key='legacy-organization:'||e.salesperson_name
             and d.name=e.department_name and g.name=e.group_name
             and m.effective_from<=e.occurred_on and (m.effective_to is null or m.effective_to>=e.occurred_on)
             and lr.effective_from<=e.occurred_on and (lr.effective_to is null or lr.effective_to>=e.occurred_on)
             and sr.effective_from<=e.occurred_on and (sr.effective_to is null or sr.effective_to>=e.occurred_on)
         )`,
    );
    if (Number(unresolved.rows[0]!.count)>0) throw new Error(`仍有 ${unresolved.rows[0]!.count} 条历史事件无法解析唯一组织快照`);

    await client.query("select set_config('sampleflow.event_identity_backfill_source_sha256',$1,true)",[input.sourceSha256]);
    const events = await client.query(
      `with resolved as (
         select e.id,p.id as person_id,d.id as department_id,g.id as group_id,
                leader.id as leader_id,leader.display_name as leader_name,
                supervisor.id as supervisor_id,supervisor.display_name as supervisor_name
         from performance_events e
         join people p on p.source_key='legacy-organization:'||e.salesperson_name
         join org_memberships m on m.person_id=p.id and m.effective_from<=e.occurred_on and (m.effective_to is null or m.effective_to>=e.occurred_on)
         join org_units d on d.id=m.department_id and d.name=e.department_name
         join org_units g on g.id=m.group_id and g.name=e.group_name
         join org_responsibilities lr on lr.org_unit_id=g.id and lr.responsibility_type='leader' and lr.effective_from<=e.occurred_on and (lr.effective_to is null or lr.effective_to>=e.occurred_on)
         join people leader on leader.id=lr.person_id
         join org_responsibilities sr on sr.org_unit_id=d.id and sr.responsibility_type='supervisor' and sr.effective_from<=e.occurred_on and (sr.effective_to is null or sr.effective_to>=e.occurred_on)
         join people supervisor on supervisor.id=sr.person_id
         where e.event_type='legacy_adjustment' and e.salesperson_person_id is null
       )
       update performance_events e set salesperson_person_id=r.person_id,department_unit_id=r.department_id,
         group_unit_id=r.group_id,leader_person_id=r.leader_id,leader_name=r.leader_name,
         supervisor_person_id=r.supervisor_id,supervisor_name=r.supervisor_name
       from resolved r where e.id=r.id`,
    );
    const orders = await client.query(
      `with resolved as (
         select order_id,min(salesperson_person_id) as person_id
         from performance_events where event_type='legacy_adjustment' group by order_id
         having count(distinct salesperson_person_id)=1
       )
       update performance_orders o set salesperson_person_id=r.person_id
       from resolved r where o.id=r.order_id and o.salesperson_person_id is null`,
    );
    const conflictingOrders = await client.query<{count:string}>(
      `select count(*)::text as count from (
         select order_id from performance_events where event_type='legacy_adjustment'
         group by order_id having count(distinct salesperson_person_id)<>1
       ) conflict`,
    );
    if (Number(conflictingOrders.rows[0]!.count)>0) throw new Error(`存在 ${conflictingOrders.rows[0]!.count} 笔订单关联多个或零个人员身份`);
    const amountAfter = await client.query<{amount:string}>("select coalesce(sum(delta_amount),0)::text as amount from performance_events where event_type='legacy_adjustment'");
    if (amountBefore.rows[0]!.amount!==amountAfter.rows[0]!.amount) throw new Error("组织回填改变了历史业绩金额");

    const accountStatuses=await client.query<{display_name:string;bound_username:string|null;candidate_usernames:string[]}>(
      `select p.display_name,bound.username as bound_username,
              coalesce(array_agg(candidate.username order by candidate.username) filter(where candidate.id is not null),'{}') as candidate_usernames
       from people p left join users bound on bound.id=p.user_id left join users candidate on candidate.display_name=p.display_name
       where p.identity_source='legacy_organization' group by p.id,bound.username order by p.display_name`,
    );
    const identityAccountStatuses=accountStatuses.rows.map((row)=>({
      personName:row.display_name,
      status:row.bound_username?"bound" as const:row.candidate_usernames.length===0?"unbound" as const:row.candidate_usernames.length===1?"candidate" as const:"ambiguous" as const,
      boundUsername:row.bound_username,
      candidateUsernames:row.candidate_usernames,
    }));
    const report:OrganizationImportReport = {
      ...preflight,
      skipped:false,
      importedIdentities,
      importedMemberships,
      importedResponsibilities,
      backfilledOrders:orders.rowCount??0,
      backfilledEvents:events.rowCount??0,
      eventAmountBefore:amountBefore.rows[0]!.amount,
      eventAmountAfter:amountAfter.rows[0]!.amount,
      sourceAmount,
      mappingConfirmation:{ source:input.mapping.source,confirmedBy:input.mapping.confirmedBy,confirmedAt:input.mapping.confirmedAt },
      mappingSnapshot:{ groupLeaders:input.mapping.groupLeaders,departmentSupervisors:input.mapping.departmentSupervisors },
      mappingDifferences:[],
      accountBindingCandidates:identityAccountStatuses.filter((row)=>row.candidateUsernames.length>0).map((row)=>({personName:row.personName,usernames:row.candidateUsernames})),
      identityAccountStatuses,
    };
    await client.query(
      `insert into organization_import_runs(source_file,source_sha256,mapping_file,mapping_sha256,report)
       values($1,$2,$3,$4,$5::jsonb)`,
      [input.sourceFile,input.sourceSha256,input.mappingFile,input.mappingSha256,JSON.stringify(report)],
    );
    await client.query("commit");
    return report;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
