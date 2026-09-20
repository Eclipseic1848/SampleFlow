import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { strFromU8,strToU8,unzipSync,zipSync } from "fflate";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";
import { parseImportWorkbook } from "./domain/performance-import-xlsx.js";
import { resolveOrganization } from "./modules/organization.js";
import { resolveGoalAccess,resolvePerformanceAccess } from "./modules/authorization.js";
import type { CurrentUser } from "./modules/auth.js";
import { preflightImportRows,confirmImportBatch,loadOrganizationSnapshots } from "./services/import-job.js";
import { completeImportSetup,importSetupOptions,importSetupSchema } from "./services/import-setup.js";

test("导入调组按确认日期保存，保留历史、正式任职和权限，拒绝过期核对及越界日期",async()=>{
  await withMigratedTestDatabase(async database=>{
    const actor=await seedTestUser(database.url,{username:"transfer_leader",displayName:"调组核对人",password:"Role@123",roleCode:"sales_assistant_leader",roleName:"销售助理组长"});
    const member=await seedTestUser(database.url,{username:"transfer_member",displayName:"示例业务员",password:"Role@123",roleCode:"salesperson",roleName:"业务员"});
    const pool=new pg.Pool({connectionString:database.runtimeUrl});
    try{
      const personId=(await pool.query("select id::text from people where user_id=$1",[member])).rows[0].id;
      const oldDepartment=(await pool.query("insert into org_units(name,unit_type) values('原部门','department') returning id::text")).rows[0].id;
      const oldGroup=(await pool.query("insert into org_units(name,unit_type,parent_id) values('原小组','group',$1) returning id::text",[oldDepartment])).rows[0].id;
      await pool.query("insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$2,'leader','2026-01-01'),($1,$3,'supervisor','2026-01-01')",[personId,oldGroup,oldDepartment]);
      await pool.query("insert into org_memberships(person_id,department_id,group_id,effective_from,effective_to) values($1,$2,$3,'2026-01-01','2026-09-08')",[personId,oldDepartment,oldGroup]);
      await pool.query("update import_configs set status='approved',business_region_mapping='{\"外贸\":\"EXT-TRADE\"}',approved_at=now() where config_key='standard-performance' and version=2");
      const config=(await pool.query("select * from import_configs where config_key='standard-performance' and version=2")).rows[0];
      const template=await readFile(new URL("../../web/public/SampleFlow标准业绩导入模板.xlsx",import.meta.url));
      async function preflight(dates:string[],prefix:string,old=false){
        const archive=unzipSync(template);
        const xml=strFromU8(archive["xl/worksheets/sheet1.xml"]!);
        const sample=xml.match(/<row r="2">.*?<\/row>/)![0];
        const body=dates.map((date,index)=>{
          let row=sample;
          for(const [column,value] of [["A",`${Number(date.slice(5,7))}月`],["B",date],["C",`${prefix}-${index}`],...(old?[["H","原部门"],["I","原小组"]]:[])] ){
            row=row.replace(new RegExp(`<c r="${column}2"[^>]*>.*?</c>`),`<c r="${column}2" t="inlineStr"><is><t>${value}</t></is></c>`);
          }
          return row.replace(/r="([A-Z]*)2"/g,`r="$1${index+2}"`);
        }).join("");
        archive["xl/worksheets/sheet1.xml"]=strToU8(xml.replace(sample,body).replaceAll("A1:O2",`A1:O${dates.length+1}`));
        const bytes=Buffer.from(zipSync(archive));
        const rows=await parseImportWorkbook("调组测试.xlsx",bytes,{sheetName:config.sheet_name,expectedHeaders:config.expected_headers,columnMapping:config.column_mapping,fixedEventType:"initial"});
        return preflightImportRows(pool,{actorUserId:actor,configId:String(config.id),sourceFileName:"调组测试.xlsx",sourceBytes:bytes,rows});
      }
      const historical=await preflight(["2026-07-31"],"HISTORY",true);
      assert.equal(historical.status,"preflight_ready");
      await confirmImportBatch(pool,historical.batchId,actor,[],"127.0.0.1");
      const history=(await pool.query("select to_jsonb(e) data from performance_events e order by id")).rows;
      const formal=(await pool.query("select to_jsonb(m) data from org_memberships m order by id")).rows;
      const responsibilities=(await pool.query("select to_jsonb(r) data from org_responsibilities r order by id")).rows;
      const current={id:member,personId,roles:["salesperson"]} as CurrentUser;
      const permissions=[await resolveGoalAccess(pool,current),await resolvePerformanceAccess(pool,current)];
      const staleReady=await preflight(["2026-09-08"],"STALE",true);
      assert.equal(staleReady.status,"preflight_ready");

      const report=await preflight(["2026-08-01","2026-09-08","2026-09-09","2026-09-10"],"TRANSFER");
      assert.equal(report.status,"blocked");
      await pool.query("insert into performance_statistical_assignments(person_id,occurred_on,department_id,group_id,batch_id,created_by) values($1,'2026-09-09',$2,$3,$4,$5)",[personId,oldDepartment,oldGroup,report.batchId,actor]);
      const options=await importSetupOptions(pool,report.batchId);
      assert.equal(options.items.length,1);
      const item=options.items[0]!;
      assert.deepEqual(item.conflicts.map(conflict=>conflict.date),["2026-08-01","2026-09-08","2026-09-09"]);
      const basic={key:item.key,personId,displayName:item.displayName,department:item.department,group:item.group};
      const payload=importSetupSchema.parse({confirmed:true,items:[{...basic,transfer:{effectiveFrom:"2026-08-01",revision:item.revision,confirmed:true}}]});
      assert.equal(importSetupSchema.safeParse({...payload,items:[{...payload.items[0],transfer:{...payload.items[0]!.transfer,confirmed:false}}]}).success,false);
      await assert.rejects(completeImportSetup(pool,report.batchId,member,payload,"127.0.0.1"),/仅销售助理组长/);
      await assert.rejects(completeImportSetup(pool,report.batchId,actor,{confirmed:true,items:[basic]},"127.0.0.1"),/填写生效日期并确认/);
      await assert.rejects(completeImportSetup(pool,report.batchId,actor,{...payload,items:[{...payload.items[0]!,transfer:{...payload.items[0]!.transfer!,effectiveFrom:"2026-08-02"}}]},"127.0.0.1"),/早于调组日期/);
      await assert.rejects(completeImportSetup(pool,report.batchId,actor,{...payload,items:[{...payload.items[0]!,transfer:{...payload.items[0]!.transfer!,revision:"0".repeat(64)}}]},"127.0.0.1"),/重新读取资料/);
      assert.equal((await pool.query("select count(*) from performance_statistical_transfers")).rows[0].count,"0");

      const saved=await completeImportSetup(pool,report.batchId,actor,payload,"127.0.0.1");
      assert.ok("report" in saved);
      assert.equal(saved.report.status,"preflight_ready",JSON.stringify(saved));
      assert.equal((await pool.query("select count(*) from performance_statistical_transfers")).rows[0].count,"3");
      const retry=await completeImportSetup(pool,report.batchId,actor,payload,"127.0.0.1");
      assert.ok("report" in retry);assert.equal(retry.report.status,"preflight_ready");
      assert.equal((await pool.query("select count(*) from performance_statistical_transfers")).rows[0].count,"3");
      assert.equal((await importSetupOptions(pool,report.batchId)).items.length,0);
      await assert.rejects(confirmImportBatch(pool,staleReady.batchId,actor,[],"127.0.0.1"),/组织关系已变化/);
      assert.equal((await resolveOrganization(pool,personId,"2026-07-31")).groupName,"原小组");
      for(const date of ["2026-08-01","2026-09-08","2026-09-09","2026-09-10"]){
        assert.equal((await resolveOrganization(pool,personId,date)).groupName,"E2E 销售组");
        const snapshots=await loadOrganizationSnapshots(pool,[{personId,occurredOn:date}]);
        assert.equal(snapshots.get(`${personId}:${date}`)!.groupName,"E2E 销售组");
      }
      // 未在文件中确认的日期不被推断或覆盖；新日期仍须单独核对。
      assert.equal((await resolveOrganization(pool,personId,"2026-08-02")).groupName,"原小组");
      await assert.rejects(resolveOrganization(pool,personId,"2026-09-11"),/找不到唯一有效/);
      assert.deepEqual((await pool.query("select to_jsonb(e) data from performance_events e order by id")).rows,history);
      assert.deepEqual((await pool.query("select to_jsonb(m) data from org_memberships m order by id")).rows,formal);
      assert.deepEqual((await pool.query("select to_jsonb(r) data from org_responsibilities r order by id")).rows,responsibilities);
      assert.deepEqual([await resolveGoalAccess(pool,current),await resolvePerformanceAccess(pool,current)],permissions);
      const evidence=(await pool.query("select previous_department_id::text,previous_group_id::text,effective_from::text from performance_statistical_transfers order by id")).rows;
      assert.deepEqual(evidence,Array(3).fill({previous_department_id:oldDepartment,previous_group_id:oldGroup,effective_from:"2026-08-01"}));
      await assert.rejects(pool.query("update performance_statistical_transfers set group_id=group_id"),/不可覆盖或删除/);
      await assert.rejects(pool.query("delete from performance_statistical_transfers"),/不可覆盖或删除/);
      await confirmImportBatch(pool,retry.report.batchId,actor,[],"127.0.0.1");
      assert.deepEqual((await pool.query("select occurred_on::text,group_name,delta_amount::text from performance_events order by occurred_on")).rows,[
        {occurred_on:"2026-07-31",group_name:"原小组",delta_amount:"100.00"},
        ...["2026-08-01","2026-09-08","2026-09-09","2026-09-10"].map(occurred_on=>({occurred_on,group_name:"E2E 销售组",delta_amount:"100.00"})),
      ]);

      // 覆盖齐全但归属不符也必须可核对；日期边界拒绝整批，不能留下部分保存。
      const beforeDate=await preflight(["2026-07-30","2026-08-03"],"BAD-DATE");
      const pending=(await importSetupOptions(pool,beforeDate.batchId)).items[0]!;
      assert.equal(pending.conflicts.length,2);
      await assert.rejects(completeImportSetup(pool,beforeDate.batchId,actor,{confirmed:true,items:[{...basic,key:pending.key,transfer:{effectiveFrom:"2026-08-01",revision:pending.revision!,confirmed:true}}]},"127.0.0.1"),/早于调组日期/);
      assert.equal((await pool.query("select count(*) from performance_statistical_transfers")).rows[0].count,"3");
    }finally{await pool.end();}
  });
});
