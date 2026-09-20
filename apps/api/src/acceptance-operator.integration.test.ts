import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ROLE_POLICIES } from "./modules/authorization.js";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

test("单账号验收贯穿目标各层及修改审批；普通全角色、关闭开关和过期均不获得例外",async()=>{
  const before=process.env.SAMPLEFLOW_ACCEPTANCE_OVERRIDE;
  try{await withMigratedTestDatabase(async database=>{
    const operator=await seedTestUser(database.url,{username:"uat_operator",displayName:"验收",password:"Test@12345",roleCode:"sales_manager",roleName:"销售经理"});
    const normal=await seedTestUser(database.url,{username:"normal_all",displayName:"普通全角色",password:"Test@12345",roleCode:"sales_manager",roleName:"销售经理"});
    const client=new pg.Client({connectionString:database.url});await client.connect();
    try{
      for(const [role,policy] of Object.entries(ROLE_POLICIES)){
        await client.query("insert into roles(code,name) values($1,$2) on conflict do nothing",[role,policy.name]);
        for(const id of [operator,normal])await client.query("insert into user_roles(user_id,role_code) values($1,$2) on conflict do nothing",[id,role]);
      }
      const persons=(await client.query("select user_id::text,id::text from people where user_id=any($1::bigint[])",[[operator,normal]])).rows;
      const person=(id:string)=>persons.find(r=>r.user_id===id).id as string;
      await client.query("insert into acceptance_operator(user_id,database_name,expires_at) values($1,current_database(),now()+interval '1 day')",[operator]);
      const department=(await client.query("insert into org_units(name,unit_type) values('验收部门','department') returning id::text")).rows[0].id;
      const group=(await client.query("insert into org_units(name,unit_type,parent_id) values('验收小组','group',$1) returning id::text",[department])).rows[0].id;
      await client.query("insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$2,'supervisor','2026-01-01'),($1,$3,'leader','2026-01-01')",[person(normal),department,group]);
      await client.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[person(normal),department,group]);
      await client.query("update org_units set is_active=true where id=any($1::bigint[])",[[department,group]]);
      await withTestApi(database.url,async app=>{
        async function login(username:string){const r=await app.inject({method:"POST",url:"/api/auth/login",headers:{origin:"http://127.0.0.1:4174"},payload:{username,password:"Test@12345"}});assert.equal(r.statusCode,200,r.body);const raw=r.headers["set-cookie"]!;const cookies=(Array.isArray(raw)?raw:[raw]).map(v=>String(v).split(";")[0]!);return{origin:"http://127.0.0.1:4174",cookie:cookies.join("; "),"x-csrf-token":decodeURIComponent(cookies.find(v=>v.startsWith("sampleflow_csrf="))!.slice(16))};}
        const own=await login("uat_operator"),other=await login("normal_all");
        const post=async(url:string,payload:object={},headers=own,code=200)=>{const r=await app.inject({method:"POST",url,headers,payload});assert.equal(r.statusCode,code,r.body);return r.json();};
        const create=(month:string,owner:string,headers=own)=>post("/api/goals",{periodMonth:month,level:"sales_manager",ownerPersonId:owner,amount:1000},headers,201);
        delete process.env.SAMPLEFLOW_ACCEPTANCE_OVERRIDE;
        const root=await create("2026-09",person(operator));
        await post(`/api/goal-versions/${root.versionId}/confirm`);
        const decision={expectedVersionId:root.versionId,decision:"approved",comment:"验收"};
        await post(`/api/goals/${root.id}/decision`,decision,own,409);
        process.env.SAMPLEFLOW_ACCEPTANCE_OVERRIDE="enabled-for-customer-uat";
        const me=await app.inject({url:"/api/auth/me",headers:own});assert.equal(me.json().user.acceptanceOperator,true);
        assert.equal((await app.inject({url:"/api/auth/me",headers:other})).json().user.acceptanceOperator,false);
        assert.ok((await app.inject({url:"/api/goals?pendingOnly=true",headers:own})).json().goals.some((g:{id:string})=>g.id===root.id));
        await post(`/api/goals/${root.id}/decision`,decision);await post(`/api/goals/${root.id}/decision`,decision);
        const ordinary=await create("2026-10",person(normal),other);await post(`/api/goal-versions/${ordinary.versionId}/confirm`,{},other);
        await post(`/api/goals/${ordinary.id}/decision`,{...decision,expectedVersionId:ordinary.versionId},other,409);
        let parent=root.id;let last:{id:string;versionId:string}=root;
        for(const [level,orgUnitId] of [["department",department],["group",group],["personal",null]] as const){
          const options=await app.inject({url:`/api/goals/options?periodMonth=2026-09&level=${level}&parentGoalId=${parent}`,headers:own});assert.equal(options.statusCode,200,options.body);
          last=await post("/api/goals",{periodMonth:"2026-09",level,ownerPersonId:person(normal),orgUnitId,parentGoalId:parent,amount:100},own,201);
          await post(`/api/goal-versions/${last.versionId}/confirm`);await post(`/api/goals/${last.id}/decision`,{...decision,expectedVersionId:last.versionId});parent=last.id;
        }
        const changed=await post(`/api/goals/${last.id}/change-requests`,{requestedAmount:120,reason:"验收修改"},own,201);
        const workflows=await app.inject({url:"/api/goal-workflows",headers:own});assert.equal(workflows.statusCode,200,workflows.body);assert.ok(workflows.json().changeRequests.some((r:{id:string;canHandle:boolean})=>r.id===changed.id&&r.canHandle));
        await post(`/api/goal-change-requests/${changed.id}/accept`,{newAmount:120,comment:"验收接受"});
        const version=(await client.query("select id::text from goal_versions where goal_id=$1 order by version_no desc limit 1",[last.id])).rows[0].id;
        await post(`/api/goal-versions/${version}/confirm`);await post(`/api/goals/${last.id}/decision`,{...decision,expectedVersionId:version});
        const links=(await app.inject({url:"/api/goal-workflows",headers:own})).json().linkageDecisions;assert.ok(links.length);await post(`/api/goal-linkage-decisions/${links[0].id}/decide`,{decision:"keep_parent",reason:"验收保留"});
        const signature=(await client.query("select signature_text from goal_versions where id=$1",[version])).rows[0].signature_text;assert.match(signature,/验收专用账号代操作/);
        const order=await post("/api/performance/orders",{orderNo:"UAT-CORRECTION",customerName:"验收客户",customerUnit:"验收单位",businessRegionCode:"CN-JS",businessRegionSourceText:"江苏省",salespersonPersonId:person(normal),sourceReceivedOn:"2026-08-15",amount:100,reason:"验收"},own,201);
        await post("/api/accounting-periods/2026-08/confirm-close",{note:"核对"});await post("/api/accounting-periods/2026-08/close",{note:"验收自关账"});
        const correctionPayload={periodMonth:"2026-08",orderId:order.id,eventType:"revenue_change",occurredOn:"2026-08-20",reason:"验收更正",businessRegionCode:"CN-JS",businessRegionSourceText:"江苏省",customerUnit:"验收单位",analysisDimensionEvidence:"验收凭证"};
        const correction=await post("/api/accounting-corrections",correctionPayload,own,201);
        await post(`/api/accounting-corrections/${correction.id}/approve`,{note:"自批"});
        const execution={type:"revenue_change",newAmount:90,reason:"验收执行",idempotencyKey:"uat-correction-once",correctionRequestId:correction.id};
        await post(`/api/performance/orders/${order.id}/events`,execution,own,201);
        const countBefore=(await client.query("select count(*) from performance_events where order_id=$1",[order.id])).rows[0].count;
        await post(`/api/performance/orders/${order.id}/events`,execution,own,200);
        assert.equal((await client.query("select count(*) from performance_events where order_id=$1",[order.id])).rows[0].count,countBefore);
        const rejectCorrection=await post("/api/accounting-corrections",correctionPayload,own,201);await post(`/api/accounting-corrections/${rejectCorrection.id}/reject`,{note:"自拒绝"});
        const ordinaryCorrection=await post("/api/accounting-corrections",correctionPayload,other,201);await post(`/api/accounting-corrections/${ordinaryCorrection.id}/approve`,{note:"不能自批"},other,409);await post(`/api/accounting-corrections/${ordinaryCorrection.id}/reject`,{note:"不能自拒绝"},other,409);
        await assert.rejects(client.query("update accounting_correction_requests set reviewed_by_user_id=$2,reviewed_by_person_id=$3,acceptance_override=true where id=$1",[ordinaryCorrection.id,normal,person(normal)]),/accounting_correction_reviewer_separation/);
        const historical=(await client.query(`insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,salesperson_person_id,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,business_region_code,business_region_source_text)
          values('UAT-HISTORY','历史客户','验收单位','普通全角色',$1,'2026-08-15',100,100,100,'historical_review_required','CN-JS','江苏省') returning id::text`,[person(normal)])).rows[0];
        const reviewPayload={orderId:historical.id,lifecycleState:"active",currentRevenue:100,conclusion:"验收核对",evidence:"验收证据",reason:"验收"};
        const rejectedReview=await post("/api/historical-order-reviews",reviewPayload,own,201);await post(`/api/historical-order-reviews/${rejectedReview.id}/reject`,{note:"验收自拒绝"});
        const review=await post("/api/historical-order-reviews",reviewPayload,own,201);await post(`/api/historical-order-reviews/${review.id}/approve`,{note:"验收自批"});
        for(const [id,headers,expected] of [[operator,own,200],[normal,other,409]] as const){
          const draft=(await client.query(`insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,business_region_mapping,created_by)
            values($1,1,'验收规则','draft','分子','["订单编号"]','{}','{"江苏省":"CN-JS"}',$2) returning id::text`,['uat-'+id,id])).rows[0];
          await post(`/api/imports/configs/${draft.id}/approve`,{},headers,expected);
        }
        await post("/api/accounting-periods/2026-07/confirm-close",{note:"核对"},other);await post("/api/accounting-periods/2026-07/close",{note:"禁止自关账"},other,409);
        await client.query("update users set is_active=false where id=$1",[operator]);
        assert.equal((await app.inject({url:"/api/auth/me",headers:own})).statusCode,401);
        await client.query("update users set is_active=true where id=$1",[operator]);
        await client.query("update acceptance_operator set expires_at=now()-interval '1 second'");
        assert.equal((await client.query("select acceptance_override from accounting_correction_requests where id=$1",[correction.id])).rows[0].acceptance_override,true);
        await client.query("update accounting_correction_requests set review_note=review_note where id=$1",[correction.id]);
        assert.equal((await app.inject({url:"/api/auth/me",headers:own})).json().user.acceptanceOperator,false);
        const expired=await create("2026-11",person(operator));await post(`/api/goal-versions/${expired.versionId}/confirm`);await post(`/api/goals/${expired.id}/decision`,{...decision,expectedVersionId:expired.versionId},own,409);
        const unsafe=await app.inject({method:"POST",url:"/api/accounting-periods/2026-06/confirm-close",headers:{cookie:own.cookie,origin:own.origin},payload:{note:"不能省略CSRF"}});assert.equal(unsafe.statusCode,403);
        assert.ok(Number((await client.query("select count(*) from audit_logs where action='acceptance.operation_requested'")).rows[0].count)>0);
      });
    }finally{await client.end();}
  });}finally{if(before===undefined)delete process.env.SAMPLEFLOW_ACCEPTANCE_OVERRIDE;else process.env.SAMPLEFLOW_ACCEPTANCE_OVERRIDE=before;}
});

test("显式作业创建九角色验收账号，首次改密和重复创建保护保留",async()=>{
  await withMigratedTestDatabase(async database=>{
    const directory=await mkdtemp(path.join(tmpdir(),"sampleflow-uat-provision-"));
    const output=path.join(directory,"credentials.json");
    const client=new pg.Client({connectionString:database.url});await client.connect();
    try{
      for(const [role,policy] of Object.entries(ROLE_POLICIES))await client.query("insert into roles(code,name) values($1,$2) on conflict do nothing",[role,policy.name]);
      const url=new URL(database.url);
      const run=()=>promisify(execFile)(process.execPath,["--import","tsx",fileURLToPath(new URL("./cli/create-acceptance-operator.ts",import.meta.url))],{env:{...process.env,DB_NAME:database.name,DB_ADMIN_HOST:url.hostname,DB_ADMIN_PORT:url.port,DB_ADMIN_USER:decodeURIComponent(url.username),DB_ADMIN_PASSWORD:decodeURIComponent(url.password),ACCEPTANCE_PROVISION_CONFIRM:"create-single-customer-uat",ACCEPTANCE_CREDENTIALS_FILE:output}});
      const result=await run();const credentials=JSON.parse(await readFile(output,"utf8"));assert.ok(!result.stdout.includes(credentials.password));
      const row=(await client.query("select u.must_change_password,count(ur.role_code)::int as roles from users u join user_roles ur on ur.user_id=u.id where username='customer_acceptance' group by u.id")).rows[0];
      assert.equal(row.roles,9);assert.equal(row.must_change_password,true);
      await assert.rejects(run(),/已登记/);
      assert.equal((await client.query("select count(*)::int as count from acceptance_operator")).rows[0].count,1);
    }finally{await client.end();await rm(directory,{recursive:true,force:true});}
  });
});
