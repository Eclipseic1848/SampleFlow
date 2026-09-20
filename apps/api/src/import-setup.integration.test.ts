import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";
import { resolveOrganization } from "./modules/organization.js";
import { resolvePerformanceAccess,resolveGoalAccess } from "./modules/authorization.js";
import type { CurrentUser } from "./modules/auth.js";
import { parseImportWorkbook } from "./domain/performance-import-xlsx.js";
import { preflightImportRows,confirmImportBatch } from "./services/import-job.js";

test("组长补齐统计资料后无负责人入账，重复提交安全且账号绑定不改变历史身份",async()=>{
  await withMigratedTestDatabase(async database=>{
    for(const role of ["sales_assistant_leader","sales_assistant","system_admin","sales_leader"]){
      await seedTestUser(database.url,{username:role,displayName:role,password:"Role@123",roleCode:role,roleName:role});
    }
    const pool=new pg.Pool({connectionString:database.runtimeUrl});
    try{
      await pool.query("insert into roles(code,name) values('salesperson','业务员') on conflict do nothing");
      await pool.query("update import_configs set status='approved',business_region_mapping='{\"外贸\":\"EXT-TRADE\"}',approved_at=now() where config_key='standard-performance' and version=2");
      const bytes=await readFile(new URL("../../web/public/SampleFlow标准业绩导入模板.xlsx",import.meta.url));
      const configId=(await pool.query("select id::text from import_configs where config_key='standard-performance' and version=2")).rows[0].id;
      await withTestApi(database.url,async app=>{
        const headers:Record<"sales_assistant_leader"|"sales_assistant"|"system_admin"|"sales_leader",Record<string,string>>={sales_assistant_leader:{},sales_assistant:{},system_admin:{},sales_leader:{}};
        for(const role of ["sales_assistant_leader","sales_assistant","system_admin","sales_leader"] as const){
          const login=await app.inject({method:"POST",url:"/api/auth/login",headers:{origin:"http://127.0.0.1:4174"},payload:{username:role,password:"Role@123"}});
          assert.equal(login.statusCode,200,login.body);
          const cookies=(login.headers["set-cookie"] as string[]).map(cookie=>cookie.split(";")[0]!);
          headers[role]={origin:"http://127.0.0.1:4174",cookie:cookies.join("; "),"x-csrf-token":decodeURIComponent(cookies.find(cookie=>cookie.startsWith("sampleflow_csrf="))!.split("=")[1]!)};
        }
        const preflight=await app.inject({method:"POST",url:"/api/imports/preflight",headers:headers.sales_assistant_leader,payload:{configId,fileName:"测试.xlsx",contentBase64:bytes.toString("base64")}});
        assert.equal(preflight.statusCode,200,preflight.body);const report=preflight.json();assert.equal(report.status,"blocked");
        const endpoint=`/api/imports/batches/${report.batchId}/setup`;
        for(const role of ["sales_assistant","system_admin","sales_leader"] as const){
          assert.equal((await app.inject({method:"GET",url:endpoint,headers:headers[role]})).statusCode,403);
          assert.equal((await app.inject({method:"POST",url:endpoint,headers:headers[role],payload:{}})).statusCode,403);
        }
        const options=(await app.inject({method:"GET",url:endpoint,headers:headers.sales_assistant_leader})).json();
        assert.equal(options.items.length,1);
        const item=options.items[0];
        const payload={confirmed:true,items:[{key:item.key,personId:null,displayName:"示例业务员",department:item.department||"统计测试部",group:item.group||"统计测试组"}]};
        const invalid=await app.inject({method:"POST",url:endpoint,headers:headers.sales_assistant_leader,payload:{...payload,items:[payload.items[0],{...payload.items[0],key:"伪造来源"}]}});
        assert.equal(invalid.statusCode,409);
        assert.equal((await pool.query("select count(*) from people where identity_source='performance_import'")).rows[0].count,"0");
        assert.equal((await pool.query("select count(*) from performance_statistical_assignments")).rows[0].count,"0");
        const escalation=await app.inject({method:"POST",url:endpoint,headers:headers.sales_assistant_leader,payload:{...payload,roles:["system_admin"]}});
        assert.equal(escalation.statusCode,400);
        const saved=await app.inject({method:"POST",url:endpoint,headers:headers.sales_assistant_leader,payload});
        assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().report.status,"preflight_ready",saved.body);
        const person=(await pool.query("select id::text,user_id from people where identity_source='performance_import'")).rows[0];
        assert.equal(person.user_id,null);
        assert.equal((await pool.query("select count(*) from org_responsibilities")).rows[0].count,"0");
        assert.equal((await pool.query("select count(*) from org_memberships")).rows[0].count,"0");
        assert.equal((await pool.query("select count(*) from org_units where is_active")).rows[0].count,"0");
        const retry=await app.inject({method:"POST",url:endpoint,headers:headers.sales_assistant_leader,payload});
        assert.equal(retry.statusCode,200,retry.body);
        assert.equal((await pool.query("select count(*) from people where identity_source='performance_import'")).rows[0].count,"1");
        const conflict=await app.inject({method:"POST",url:endpoint,headers:headers.sales_assistant_leader,payload:{...payload,items:[{...payload.items[0],department:"冲突部门"}]}});
        assert.equal(conflict.statusCode,409);
        const confirmed=await app.inject({method:"POST",url:`/api/imports/batches/${retry.json().report.batchId}/confirm`,headers:headers.sales_assistant_leader,payload:{confirmedWarnings:retry.json().report.issues.filter((issue:{severity:string})=>issue.severity==="warning").map((issue:{rowNumber:number;code:string})=>`${issue.rowNumber}:${issue.code}`)}});
        assert.equal(confirmed.statusCode,200,confirmed.body);
        const event=(await pool.query("select salesperson_person_id::text,leader_person_id,supervisor_person_id,delta_amount from performance_events")).rows[0];
        assert.equal(event.salesperson_person_id,person.id);assert.equal(event.leader_person_id,null);assert.equal(event.supervisor_person_id,null);assert.equal(event.delta_amount,"100.00");
        const snapshot=await resolveOrganization(pool,person.id,item.dates[0]);assert.equal(snapshot.leaderPersonId,null);
        const manager=(await pool.query("select u.id::text,p.id::text person_id from users u join people p on p.user_id=u.id where u.username='sales_leader'")).rows[0];
        const current={id:manager.id,personId:manager.person_id,roles:["sales_leader"]} as CurrentUser;
        assert.deepEqual((await resolvePerformanceAccess(pool,current)).groupIds,[]);
        assert.deepEqual((await resolveGoalAccess(pool,current)).ownerPersonIds,[manager.person_id]);
        const duplicateAccount=await app.inject({method:"POST",url:"/api/admin/users",headers:headers.system_admin,payload:{username:"new_person",displayName:"示例业务员",roles:["salesperson"]}});
        assert.equal(duplicateAccount.statusCode,409,duplicateAccount.body);
        const account=await app.inject({method:"POST",url:"/api/admin/users",headers:headers.system_admin,payload:{username:"new_person",displayName:"示例业务员",personId:person.id,roles:["salesperson"]}});
        assert.equal(account.statusCode,201,account.body);
        assert.equal((await pool.query("select salesperson_person_id::text from performance_events")).rows[0].salesperson_person_id,person.id);
        assert.equal((await pool.query("select count(*) from people where display_name='示例业务员'")).rows[0].count,"1");
        assert.ok(Number((await pool.query("select count(*) from audit_logs where action='import.statistical_setup'")).rows[0].count)>0);
        const collaborator=(await pool.query("insert into people(display_name,source_key) values('测试协作人','test:collaborator') returning id::text")).rows[0].id;
        await pool.query("insert into performance_statistical_assignments(person_id,occurred_on,department_id,group_id,batch_id,created_by) select $1,occurred_on,department_id,group_id,batch_id,created_by from performance_statistical_assignments where person_id=$2",[collaborator,person.id]);
        const layout=(await pool.query("select * from import_configs where id=$1",[configId])).rows[0];
        const rows=await parseImportWorkbook("测试.xlsx",bytes,{sheetName:layout.sheet_name,expectedHeaders:layout.expected_headers,columnMapping:layout.column_mapping,fixedEventType:"initial"});
        const actor=(await pool.query("select id::text from users where username='sales_assistant_leader'")).rows[0].id;
        const collaboration=await preflightImportRows(pool,{actorUserId:actor,configId,sourceFileName:"合成协作测试.xlsx",sourceBytes:Buffer.from("synthetic-collaboration"),rows:rows.map(row=>({...row,orderNo:"COLLAB-1",sourceRecordId:"COLLAB-1",collaboratorSourceKey:"test:collaborator",collaborationRatio:0.2}))});
        assert.equal(collaboration.status,"preflight_ready",JSON.stringify(collaboration));
        await confirmImportBatch(pool,collaboration.batchId,actor,[],"127.0.0.1");
        const shared=(await pool.query("select collaborator_person_id::text,collaborator_leader_person_id,collaborator_supervisor_person_id from performance_events where collaborator_person_id is not null")).rows[0];
        assert.equal(shared.collaborator_person_id,collaborator);assert.equal(shared.collaborator_leader_person_id,null);assert.equal(shared.collaborator_supervisor_person_id,null);
      });
    }finally{await pool.end();}
  });
});
