import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { Database } from "../db.js";
import { postgresBigintIdSchema } from "../validation.js";
import { businessDate } from "../domain/business-time.js";
import { parseImportWorkbook, type ImportLayout } from "../domain/performance-import-xlsx.js";
import { ImportJobError, loadPeopleBySourceIdentity, loadOrganizationSnapshots, preflightImportRows, type ImportSourceRow, type ImportEventType } from "./import-job.js";

const name = z.string().trim().min(1).max(100);
export const importSetupSchema = z.strictObject({
  confirmed: z.literal(true),
  items: z.array(z.strictObject({
    key: z.string().min(1).max(1000),
    personId: postgresBigintIdSchema.nullable(),
    displayName: name,
    department: name,
    group: name,
    transfer: z.strictObject({ effectiveFrom: z.iso.date(), revision: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).optional(),
  })).min(1).max(500),
});

async function source(database: Pick<PoolClient,"query">, batchId: string) {
  const result = await database.query<{
    config_id:string; source_file_name:string; source_bytes:Buffer; status:string; purpose:string;
    sheet_name:string; expected_headers:unknown[]; column_mapping:ImportLayout["columnMapping"];
    person_mapping:Record<string,string>; fixed_event_type:ImportEventType|null;
  }>(`select b.config_id::text,b.source_file_name,b.source_bytes,b.status,b.purpose,
    c.sheet_name,c.expected_headers,c.column_mapping,c.person_mapping,c.fixed_event_type
    from import_batches b join import_configs c on c.id=b.config_id
    where b.id=$1 and c.status='approved'`,[batchId]);
  const batch=result.rows[0];
  if(!batch || batch.purpose!=="ledger_import" || batch.status!=="blocked") throw new ImportJobError("只能补齐尚未入账、检查未通过的业绩导入批次");
  const rows=await parseImportWorkbook(batch.source_file_name,batch.source_bytes,{
    sheetName:batch.sheet_name,expectedHeaders:batch.expected_headers,columnMapping:batch.column_mapping,
    personMapping:batch.person_mapping,...(batch.fixed_event_type?{fixedEventType:batch.fixed_event_type}:{}),
  });
  return {batch,rows};
}

// 按人员和表内归属集中处理，日期只取原文件实际发生日期，不猜测任职区间。
function groups(rows: readonly ImportSourceRow[]) {
  const result=new Map<string,{key:string;identity:string;department:string;group:string;dates:string[];rowNumbers:number[]}>();
  for(const row of rows){
    for(const [identity,department,group] of [[row.salespersonSourceKey,row.sourceDepartment??"",row.sourceGroup??""],[row.collaboratorSourceKey??"","",""]] as const){
      if(!identity)continue;
      const key=JSON.stringify([identity,department,group]);
      const value=result.get(key)??{key,identity,department,group,dates:[] as string[],rowNumbers:[] as number[]};
      if(!value.dates.includes(row.occurredOn))value.dates.push(row.occurredOn);
      value.rowNumbers.push(row.rowNumber);result.set(key,value);
    }
  }
  return [...result.values()];
}

function attributionRevision(personId:string,dates:readonly string[],coverage:Awaited<ReturnType<typeof loadOrganizationSnapshots>>){
  return createHash("sha256").update(JSON.stringify([personId,[...dates].sort().map(date=>{
    const value=coverage.get(`${personId}:${date}`);
    return [date,value?.departmentId??null,value?.groupId??null];
  })])).digest("hex");
}

export async function importSetupOptions(database:Database,batchId:string){
  const {batch,rows}=await source(database,batchId);
  const items=groups(rows);
  const resolved=await loadPeopleBySourceIdentity(database,items.map(item=>item.identity),batch.config_id);
  const people=await database.query<{id:string;displayName:string;sourceKey:string}>("select id::text,display_name as \"displayName\",source_key as \"sourceKey\" from people order by display_name,id");
  const units=await database.query<{id:string;name:string;unitType:string;parentId:string|null}>("select id::text,name,unit_type as \"unitType\",parent_id::text as \"parentId\" from org_units order by name,id");
  const coverage=await loadOrganizationSnapshots(database,items.flatMap(item=>{
    const personId=resolved.get(item.identity);
    return personId?item.dates.filter(date=>z.iso.date().safeParse(date).success).map(occurredOn=>({personId,occurredOn})):[];
  }));
  const pending=[];
  for(const item of items){
    const personId=resolved.get(item.identity)??null;
    const conflicts=item.dates.flatMap(date=>{
      const current=personId?coverage.get(`${personId}:${date}`):undefined;
      return current&&((item.department&&item.department!==current.departmentName)||(item.group&&item.group!==current.groupName))
        ?[{date,department:current.departmentName,group:current.groupName}]:[];
    });
    if(personId && !conflicts.length && item.dates.every(date=>coverage.has(`${personId}:${date}`)))continue;
    pending.push({...item,personId,conflicts,revision:personId?attributionRevision(personId,item.dates,coverage):null,displayName:people.rows.find(person=>person.id===personId)?.displayName??item.identity});
  }
  return {items:pending.slice(0,500),totalItems:pending.length,people:people.rows,units:units.rows};
}

async function unit(client:PoolClient,unitName:string,type:"department"|"group",parentId:string|null){
  const existing=await client.query<{id:string}>("select id::text from org_units where lower(name)=lower($1) and unit_type=$2 and parent_id is not distinct from $3::bigint",[unitName,type,parentId]);
  if(existing.rows[0])return existing.rows[0].id;
  const inserted=await client.query<{id:string}>("insert into org_units(name,unit_type,parent_id,is_active) values($1,$2,$3,false) returning id::text",[unitName,type,parentId]);
  return inserted.rows[0]!.id;
}

export async function completeImportSetup(database:Database,batchId:string,actorUserId:string,input:z.infer<typeof importSetupSchema>,ip:string){
  const client=await database.connect();
  let stored:Awaited<ReturnType<typeof source>>;
  try{
    await client.query("begin");
    const operator=await client.query("select 1 from users u join user_roles r on r.user_id=u.id where u.id=$1 and u.is_active and u.deleted_at is null and r.role_code='sales_assistant_leader'",[actorUserId]);
    if(!operator.rowCount)throw new ImportJobError("仅销售助理组长可以确认导入统计资料");
    // ponytail: 低频补齐用表锁串行保护；高并发时再改为统一的按人员锁协议。
    await client.query("set local lock_timeout='5s'");
    await client.query("select pg_advisory_xact_lock(hashtext('sampleflow:performance-import'))");
    await client.query("lock table people,org_units,org_memberships,performance_statistical_assignments,performance_statistical_transfers,import_person_links in share row exclusive mode");
    await client.query("select id from import_batches where id=$1 for update",[batchId]);
    stored=await source(client,batchId);
    const available=new Map(groups(stored.rows).map(item=>[item.key,item]));
    const seen=new Set<string>();
    for(const item of input.items){
      const evidence=available.get(item.key);
      if(!evidence || seen.has(item.key))throw new ImportJobError("补齐项不属于原文件或重复提交");
      seen.add(item.key);
      if(evidence.dates.some(date=>!z.iso.date().safeParse(date).success||date>businessDate(new Date())))throw new ImportJobError("请先修正文件中的无效或未来日期");
      if((evidence.department&&evidence.department!==item.department)||(evidence.group&&evidence.group!==item.group))throw new ImportJobError("统计归属须与文件一致；如原文件有误，请修改文件后重新检查");
      const matches=await loadPeopleBySourceIdentity(client,[evidence.identity],stored.batch.config_id);
      let personId=matches.get(evidence.identity);
      if(personId && item.personId && personId!==String(item.personId))throw new ImportJobError("该来源已对应其他人员，不能覆盖已有身份");
      if(!personId){
        if(item.personId){
          const selected=await client.query<{id:string}>("select id::text from people where id=$1",[item.personId]);
          if(!selected.rows[0])throw new ImportJobError("所选人员不存在");
          personId=selected.rows[0].id;
        }else{
          const duplicate=await client.query("select 1 from people where lower(btrim(display_name))=lower($1) or source_key=$2",[item.displayName,evidence.identity]);
          if(duplicate.rowCount)throw new ImportJobError(`“${item.displayName}”已有人员，请选择已有档案，不能重复新建`);
          const created=await client.query<{id:string}>("insert into people(display_name,identity_source,source_key) values($1,'performance_import',$2) returning id::text",[item.displayName,`import:${randomUUID()}`]);
          personId=created.rows[0]!.id;
        }
        await client.query("insert into import_person_links(config_id,source_identity,person_id,batch_id,created_by) values($1,$2,$3,$4,$5)",[stored.batch.config_id,evidence.identity,personId,batchId,actorUserId]);
      }
      const departmentId=await unit(client,item.department,"department",null);
      const groupId=await unit(client,item.group,"group",departmentId);
      if(item.transfer){
        if(!evidence.department||!evidence.group||item.transfer.effectiveFrom>businessDate(new Date()))throw new ImportJobError("调组须核对文件中的部门、小组及实际生效日期，不能使用未来日期");
        const coverage=await loadOrganizationSnapshots(client,evidence.dates.map(occurredOn=>({personId,occurredOn})));
        const stillDifferent=evidence.dates.some(date=>{
          const current=coverage.get(`${personId}:${date}`);
          return current&&(current.departmentId!==departmentId||current.groupId!==groupId);
        });
        if(stillDifferent&&item.transfer.revision!==attributionRevision(personId,evidence.dates,coverage))throw new ImportJobError("归属已被其他操作更新，请重新读取资料后核对调组");
      }
      for(const date of evidence.dates){
        const existing=await client.query<{department_id:string;group_id:string}>(`select department_id::text,group_id::text from performance_organization_memberships
          where person_id=$1 and effective_from<=$2 and (effective_to is null or effective_to>=$2)`,[personId,date]);
        if(existing.rows.length){
          if(existing.rows.length!==1)throw new ImportJobError(`${evidence.identity} 在 ${date} 存在多条归属，请先核对组织资料`);
          const previous=existing.rows[0]!;
          if(previous.department_id!==departmentId||previous.group_id!==groupId){
            if(!item.transfer)throw new ImportJobError(`${evidence.identity} 在 ${date} 的系统归属与文件不同；如已调组，请在本窗口填写生效日期并确认`);
            if(date<item.transfer.effectiveFrom)throw new ImportJobError(`${evidence.identity} 在 ${date} 早于调组日期，应保留原小组，请修正文件中该行的部门和小组`);
            await client.query(`insert into performance_statistical_transfers(person_id,occurred_on,effective_from,department_id,group_id,previous_department_id,previous_group_id,batch_id,created_by)
              values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[personId,date,item.transfer.effectiveFrom,departmentId,groupId,previous.department_id,previous.group_id,batchId,actorUserId]);
          }
          continue;
        }
        if(item.transfer&&date<item.transfer.effectiveFrom)throw new ImportJobError(`${evidence.identity} 在 ${date} 早于调组日期，请按原小组填写并重新检查`);
        await client.query("insert into performance_statistical_assignments(person_id,occurred_on,department_id,group_id,batch_id,created_by) values($1,$2,$3,$4,$5,$6)",[personId,date,departmentId,groupId,batchId,actorUserId]);
      }
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address)
        values($1,'import.statistical_setup','import_batch',$2,$3::jsonb,$4)`,[actorUserId,batchId,JSON.stringify({sourceIdentity:evidence.identity,personId,departmentId,groupId,dates:evidence.dates,rowNumbers:evidence.rowNumbers,...(item.transfer?{transferEffectiveFrom:item.transfer.effectiveFrom}: {})}),ip]);
    }
    await client.query("commit");
  }catch(error){await client.query("rollback");if(["23505","23503","23P01","P0001","40P01","55P03"].includes((error as {code?:string}).code??""))throw new ImportJobError("人员或统计归属发生冲突或正在被其他人维护，请刷新检查结果后重试");throw error;}finally{client.release();}
  // 补齐资料和入账是两件事。保留旧批次证据，重新生成检查结果，仍需单独确认入账。
  try{return {report:await preflightImportRows(database,{actorUserId,configId:stored.batch.config_id,sourceFileName:stored.batch.source_file_name,sourceBytes:stored.batch.source_bytes,rows:stored.rows})};}
  catch{return {message:"资料已保存，但重新检查未完成。请点击重新检查，不要重复新建人员。"};}
}
