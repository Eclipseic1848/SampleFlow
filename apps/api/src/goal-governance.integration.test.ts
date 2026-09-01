import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Client }=pg;
const TEST_ORIGIN="http://127.0.0.1:4174";
const GOAL_CONFIRMATION_STATEMENT="本人已核对并确认承担本目标版本。";
type GoalActor = "manager"|"supervisor"|"leader"|"salesperson"|"hr"|"gm"|"outsider";

async function headers(app:Parameters<Parameters<typeof withTestApi>[1]>[0],username:string){
  const login=await app.inject({method:"POST",url:"/api/auth/login",headers:{origin:TEST_ORIGIN},payload:{username,password:"Goal@123"}});
  assert.equal(login.statusCode,200,login.body);
  const setCookies=Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"].map(String):[String(login.headers["set-cookie"])];
  const cookies=setCookies.map((value)=>value.split(";",1)[0]??"");
  const csrf=cookies.find((value)=>value.startsWith("sampleflow_csrf="));assert.ok(csrf);
  return {cookie:cookies.join("; "),origin:TEST_ORIGIN,"x-csrf-token":decodeURIComponent(csrf.slice("sampleflow_csrf=".length))};
}

async function seedGoalScenario(databaseUrl:string){
  const users={
    manager:await seedTestUser(databaseUrl,{username:"goal_manager",displayName:"目标销售经理",password:"Goal@123",roleCode:"sales_manager",roleName:"销售经理"}),
    supervisor:await seedTestUser(databaseUrl,{username:"goal_supervisor",displayName:"目标主管",password:"Goal@123",roleCode:"sales_supervisor",roleName:"业务主管"}),
    leader:await seedTestUser(databaseUrl,{username:"goal_leader",displayName:"目标组长",password:"Goal@123",roleCode:"sales_leader",roleName:"业务员组长"}),
    salesperson:await seedTestUser(databaseUrl,{username:"goal_salesperson",displayName:"目标业务员",password:"Goal@123",roleCode:"salesperson",roleName:"业务员"}),
    hr:await seedTestUser(databaseUrl,{username:"goal_hr",displayName:"目标人事",password:"Goal@123",roleCode:"hr",roleName:"人事部"}),
    gm:await seedTestUser(databaseUrl,{username:"goal_gm",displayName:"目标总经理",password:"Goal@123",roleCode:"general_manager",roleName:"总经理"}),
    outsider:await seedTestUser(databaseUrl,{username:"goal_outsider",displayName:"目标范围外人员",password:"Goal@123",roleCode:"salesperson",roleName:"业务员"}),
  };
  const client=new Client({connectionString:databaseUrl});await client.connect();
  try{
    await client.query("insert into user_roles(user_id,role_code) values($1,'general_manager'),($1,'hr') on conflict do nothing",[users.manager]);
    const rows=await client.query<{user_id:string;id:string}>("select user_id::text,id::text from people where user_id=any($1::bigint[])",[Object.values(users)]);
    const person=(userId:string)=>rows.rows.find((row)=>row.user_id===userId)!.id;
    const department=await client.query<{id:string}>("insert into org_units(name,unit_type) values('目标部门','department') returning id::text");
    const group=await client.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('目标小组','group',$1) returning id::text",[department.rows[0]!.id]);
    await client.query("begin");
    await client.query(`insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
      values($1,$3,'supervisor','2026-01-01'),($2,$4,'leader','2026-01-01')`,[person(users.supervisor),person(users.leader),department.rows[0]!.id,group.rows[0]!.id]);
    await client.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[person(users.salesperson),department.rows[0]!.id,group.rows[0]!.id]);
    await client.query("update org_units set is_active=true where id=any($1::bigint[])",[[department.rows[0]!.id,group.rows[0]!.id]]);
    await client.query("commit");
    return {users,personIds:Object.fromEntries(Object.entries(users).map(([key,id])=>[key,person(id)])) as Record<keyof typeof users,string>,departmentId:department.rows[0]!.id,groupId:group.rows[0]!.id};
  }finally{await client.end();}
}

test("四级目标只能由合法直属角色和同月父目标创建并按稳定人员职责审批",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedGoalScenario(database.url);
    await withTestApi(database.url,async(app)=>{
      const manager=await headers(app,"goal_manager");const supervisor=await headers(app,"goal_supervisor");
      const leader=await headers(app,"goal_leader");const salesperson=await headers(app,"goal_salesperson");
      const gm=await headers(app,"goal_gm");const hr=await headers(app,"goal_hr");const outsider=await headers(app,"goal_outsider");
      const create=async(actor:typeof manager,payload:Record<string,unknown>)=>app.inject({method:"POST",url:"/api/goals",headers:actor,payload});
      const sign=async(actor:typeof manager,id:string,knownVersionId?:string)=>{const list=knownVersionId?null:await app.inject({method:"GET",url:"/api/goals",headers:{cookie:actor.cookie}});const versionId=knownVersionId??list!.json().goals.find((goal:{id:string})=>goal.id===id).versionId;return app.inject({method:"POST",url:`/api/goal-versions/${versionId}/confirm`,headers:actor,payload:{}});};
      const decide=async(actor:typeof manager,id:string,decision="approved")=>app.inject({method:"POST",url:`/api/goals/${id}/decision`,headers:actor,payload:{decision,comment:"审批意见"}});

      const top=await create(manager,{periodMonth:"2026-09",level:"sales_manager",ownerPersonId:Number(scenario.personIds.manager),orgUnitId:null,parentGoalId:null,amount:1000,changeReason:"公司目标"});
      assert.equal(top.statusCode,201,top.body);const topId=top.json().id as string;
      const preciseMissingVersion=await app.inject({method:"POST",url:"/api/goal-versions/9007199254740993/confirm",headers:manager,payload:{}});
      assert.equal(preciseMissingVersion.statusCode,404,preciseMissingVersion.body);
      const overflowingVersion=await app.inject({method:"POST",url:"/api/goal-versions/9223372036854775808/confirm",headers:manager,payload:{}});
      assert.equal(overflowingVersion.statusCode,400,overflowingVersion.body);
      const legacySignature=await app.inject({method:"POST",url:`/api/goal-versions/${top.json().versionId}/confirm`,headers:manager,payload:{signatureText:"手写签名"}});
      assert.equal(legacySignature.statusCode,400,legacySignature.body);
      const confirmations=await Promise.all([
        app.inject({method:"POST",url:`/api/goal-versions/${top.json().versionId}/confirm`,headers:manager,payload:{}}),
        app.inject({method:"POST",url:`/api/goal-versions/${top.json().versionId}/confirm`,headers:manager,payload:{}}),
      ]);
      assert.deepEqual(confirmations.map((response)=>response.statusCode),[200,200]);
      assert.deepEqual(confirmations.map((response)=>response.json().changed).sort(),[false,true]);
      const confirmationClient=new Client({connectionString:database.url});await confirmationClient.connect();
      try{
        const confirmed=await confirmationClient.query(
          `select signed_by::text,signed_by_person_id::text,signed_at::text,signature_text
           from goal_versions where id=$1`,
          [top.json().versionId],
        );
        assert.deepEqual(
          [confirmed.rows[0]?.signed_by,confirmed.rows[0]?.signed_by_person_id,confirmed.rows[0]?.signature_text],
          [scenario.users.manager,scenario.personIds.manager,GOAL_CONFIRMATION_STATEMENT],
        );
        assert.ok(confirmed.rows[0]?.signed_at);
        await assert.rejects(
          confirmationClient.query("update goal_versions set amount=amount+1 where id=$1",[top.json().versionId]),
          /目标版本内容不可修改/,
        );
        await assert.rejects(
          confirmationClient.query("update goal_versions set signature_text='tampered' where id=$1",[top.json().versionId]),
          /目标确认信息不可修改/,
        );
        const confirmationAudit=await confirmationClient.query<{id:string;actor_user_id:string;after_data:{accountId:string;personId:string;statement:string;confirmedAt:string}}>(
          `select id::text,actor_user_id::text,after_data from audit_logs
           where action='goal.version_confirmed' and entity_type='goal_version' and entity_id=$1`,
          [top.json().versionId],
        );
        assert.equal(confirmationAudit.rowCount,1);
        assert.deepEqual(
          [confirmationAudit.rows[0]?.actor_user_id,confirmationAudit.rows[0]?.after_data.accountId,confirmationAudit.rows[0]?.after_data.personId,confirmationAudit.rows[0]?.after_data.statement],
          [scenario.users.manager,scenario.users.manager,scenario.personIds.manager,GOAL_CONFIRMATION_STATEMENT],
        );
        assert.ok(confirmationAudit.rows[0]?.after_data.confirmedAt);
        await assert.rejects(
          confirmationClient.query("update audit_logs set action='tampered' where id=$1",[confirmationAudit.rows[0]!.id]),
          /审计日志不可更新或删除/,
        );
        await assert.rejects(
          confirmationClient.query("delete from audit_logs where id=$1",[confirmationAudit.rows[0]!.id]),
          /审计日志不可更新或删除/,
        );
      }finally{await confirmationClient.end();}
      const blankDecision=await app.inject({method:"POST",url:`/api/goals/${topId}/decision`,headers:gm,payload:{decision:"approved",comment:""}});
      assert.equal(blankDecision.statusCode,400,blankDecision.body);
      assert.equal((await decide(manager,topId)).statusCode,409,"确认者即使兼任总经理也不能自批");
      assert.equal((await decide(gm,topId)).statusCode,200);
      assert.equal((await decide(manager,topId)).statusCode,409,"确认者即使兼任人事也不能终审");
      assert.equal((await decide(hr,topId)).statusCode,200);
      const replayAfterApproval=await app.inject({method:"POST",url:`/api/goal-versions/${top.json().versionId}/confirm`,headers:manager,payload:{}});
      assert.equal(replayAfterApproval.statusCode,200,replayAfterApproval.body);
      assert.equal(replayAfterApproval.json().changed,false);
      assert.equal((await decide(hr,topId)).statusCode,409,"同一终审节点不能重复审批");

      const missingParent=await create(manager,{periodMonth:"2026-09",level:"department",ownerPersonId:Number(scenario.personIds.supervisor),orgUnitId:Number(scenario.departmentId),parentGoalId:null,amount:800,changeReason:"缺父目标"});
      assert.equal(missingParent.statusCode,400,missingParent.body);
      const unknownParent=await create(manager,{periodMonth:"2026-09",level:"department",ownerPersonId:Number(scenario.personIds.supervisor),orgUnitId:Number(scenario.departmentId),parentGoalId:999999,amount:800,changeReason:"不存在父目标"});
      assert.equal(unknownParent.statusCode,404,unknownParent.body);
      assert.doesNotMatch(unknownParent.body,/constraint|foreign key/i);
      const wrongOwner=await create(manager,{periodMonth:"2026-09",level:"department",ownerPersonId:Number(scenario.personIds.hr),orgUnitId:Number(scenario.departmentId),parentGoalId:Number(topId),amount:800,changeReason:"错误责任人"});
      assert.equal(wrongOwner.statusCode,409,wrongOwner.body);

      const department=await create(manager,{periodMonth:"2026-09",level:"department",ownerPersonId:Number(scenario.personIds.supervisor),orgUnitId:Number(scenario.departmentId),parentGoalId:Number(topId),amount:800,changeReason:"部门目标"});
      assert.equal(department.statusCode,201,department.body);const departmentId=department.json().id as string;
      const wrongMonth=await create(manager,{periodMonth:"2026-10",level:"department",ownerPersonId:Number(scenario.personIds.supervisor),orgUnitId:Number(scenario.departmentId),parentGoalId:Number(topId),amount:800,changeReason:"跨月父目标"});
      assert.equal(wrongMonth.statusCode,409,wrongMonth.body);
      assert.equal((await sign(outsider,departmentId,department.json().versionId)).statusCode,403);
      assert.equal((await sign(supervisor,departmentId)).statusCode,200);
      assert.equal((await decide(manager,departmentId)).statusCode,409,"下达人即使兼任人事也不能审批");
      assert.equal((await decide(hr,departmentId)).statusCode,200);

      const group=await create(supervisor,{periodMonth:"2026-09",level:"group",ownerPersonId:Number(scenario.personIds.leader),orgUnitId:Number(scenario.groupId),parentGoalId:Number(departmentId),amount:600,changeReason:"小组目标"});
      assert.equal(group.statusCode,201,group.body);const groupId=group.json().id as string;
      assert.equal((await sign(leader,groupId)).statusCode,200);assert.equal((await decide(hr,groupId)).statusCode,200);
      const personal=await create(leader,{periodMonth:"2026-09",level:"personal",ownerPersonId:Number(scenario.personIds.salesperson),orgUnitId:null,parentGoalId:Number(groupId),amount:400,changeReason:"个人目标"});
      assert.equal(personal.statusCode,201,personal.body);const personalId=personal.json().id as string;
      assert.equal((await sign(salesperson,personalId)).statusCode,200);assert.equal((await decide(hr,personalId)).statusCode,200);

      const options=await app.inject({method:"GET",url:`/api/goals/options?periodMonth=2026-09&level=personal&parentGoalId=${groupId}`,headers:{cookie:leader.cookie}});
      assert.equal(options.statusCode,200,options.body);
      assert.deepEqual(options.json().owners.map((owner:{personId:string})=>owner.personId),[scenario.personIds.salesperson]);
      const list=await app.inject({method:"GET",url:"/api/goals",headers:{cookie:hr.cookie}});
      assert.equal(list.statusCode,200,list.body);
      assert.deepEqual(list.json().goals.map((goal:{level:string})=>goal.level),["sales_manager","department","group","personal"]);
    });
  });
});

test("目标修改申请可重试、直属上级处理、责任人重新确认、人事审批并触发联动选择",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedGoalScenario(database.url);
    await withTestApi(database.url,async(app)=>{
      const actor=Object.fromEntries(await Promise.all((["manager","supervisor","leader","salesperson","hr","gm","outsider"] as const).map(async(key)=>[key,await headers(app,`goal_${key}`)]))) as Record<GoalActor,Awaited<ReturnType<typeof headers>>>;
      const create=async(who:GoalActor,payload:Record<string,unknown>)=>{const response=await app.inject({method:"POST",url:"/api/goals",headers:actor[who],payload});assert.equal(response.statusCode,201,response.body);return response.json().id as string;};
      const sign=async(who:GoalActor,id:string)=>{const list=await app.inject({method:"GET",url:"/api/goals",headers:{cookie:actor[who].cookie}});const versionId=list.json().goals.find((goal:{id:string})=>goal.id===id).versionId;const response=await app.inject({method:"POST",url:`/api/goal-versions/${versionId}/confirm`,headers:actor[who],payload:{}});assert.equal(response.statusCode,200,response.body);};
      const approve=async(who:GoalActor,id:string)=>{const response=await app.inject({method:"POST",url:`/api/goals/${id}/decision`,headers:actor[who],payload:{decision:"approved",comment:"同意"}});assert.equal(response.statusCode,200,response.body);};
      const top=await create("manager",{periodMonth:"2026-09",level:"sales_manager",ownerPersonId:Number(scenario.personIds.manager),parentGoalId:null,orgUnitId:null,amount:1000,changeReason:"顶层"});await sign("manager",top);await approve("gm",top);await approve("hr",top);
      const department=await create("manager",{periodMonth:"2026-09",level:"department",ownerPersonId:Number(scenario.personIds.supervisor),parentGoalId:Number(top),orgUnitId:Number(scenario.departmentId),amount:800,changeReason:"部门"});await sign("supervisor",department);await approve("hr",department);
      const group=await create("supervisor",{periodMonth:"2026-09",level:"group",ownerPersonId:Number(scenario.personIds.leader),parentGoalId:Number(department),orgUnitId:Number(scenario.groupId),amount:600,changeReason:"小组"});await sign("leader",group);await approve("hr",group);
      const personal=await create("leader",{periodMonth:"2026-09",level:"personal",ownerPersonId:Number(scenario.personIds.salesperson),parentGoalId:Number(group),orgUnitId:null,amount:400,changeReason:"个人"});await sign("salesperson",personal);await approve("hr",personal);

      const requested=await app.inject({method:"POST",url:`/api/goals/${personal}/change-requests`,headers:actor.salesperson,payload:{requestedAmount:450,reason:"业务调整"}});
      assert.equal(requested.statusCode,201,requested.body);const requestId=requested.json().id as string;
      const replay=await app.inject({method:"POST",url:`/api/goals/${personal}/change-requests`,headers:actor.salesperson,payload:{requestedAmount:450,reason:"业务调整"}});
      assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().id,requestId);
      const forbidden=await app.inject({method:"POST",url:`/api/goal-change-requests/${requestId}/accept`,headers:actor.outsider,payload:{newAmount:450,comment:"越权"}});
      assert.equal(forbidden.statusCode,403,forbidden.body);
      const accepted=await app.inject({method:"POST",url:`/api/goal-change-requests/${requestId}/accept`,headers:actor.leader,payload:{newAmount:450,comment:"同意调整"}});
      assert.equal(accepted.statusCode,200,accepted.body);
      const beforeFinalApproval=await app.inject({method:"GET",url:"/api/goals",headers:{cookie:actor.leader.cookie}});
      assert.equal(beforeFinalApproval.statusCode,200,beforeFinalApproval.body);
      const groupBeforeFinal=beforeFinalApproval.json().goals.find((goal:{id:string})=>goal.id===group);
      const personalBeforeFinal=beforeFinalApproval.json().goals.find((goal:{id:string})=>goal.id===personal);
      assert.equal(groupBeforeFinal.allocatedAmount,"400.00","未终审的下级候选版本不能改变上级生效分配金额");
      assert.deepEqual([personalBeforeFinal.amount,personalBeforeFinal.effectiveAmount],["450.00","400.00"],"候选版本可操作，但必须同时标明当前生效金额");
      const pendingWorkflows=await app.inject({method:"GET",url:"/api/goal-workflows",headers:{cookie:actor.leader.cookie}});
      assert.equal(pendingWorkflows.statusCode,200,pendingWorkflows.body);
      const pendingWorkflow=pendingWorkflows.json().changeRequests.find((item:{id:string})=>item.id===requestId);
      assert.deepEqual([pendingWorkflow.currentAmount,pendingWorkflow.newAmount,pendingWorkflow.amountDifference],["400.00","450.00","50.00"]);
      const confirmationVersions=await app.inject({method:"GET",url:`/api/goals/${personal}/history`,headers:{cookie:actor.salesperson.cookie}});
      assert.equal(confirmationVersions.statusCode,200,confirmationVersions.body);
      assert.deepEqual(
        confirmationVersions.json().versions.slice(0,2).map((version:{amount:string;signatureText:string|null})=>[version.amount,version.signatureText]),
        [["450.00",null],["400.00",GOAL_CONFIRMATION_STATEMENT]],
        "金额变化必须产生尚未确认的新版本，旧版本确认保持不变",
      );
      await sign("salesperson",personal);await approve("hr",personal);

      const workflows=await app.inject({method:"GET",url:"/api/goal-workflows",headers:{cookie:actor.leader.cookie}});
      assert.equal(workflows.statusCode,200,workflows.body);
      assert.equal(workflows.json().changeRequests.find((item:{id:string})=>item.id===requestId).status,"completed");
      const linkage=workflows.json().linkageDecisions.find((item:{parentGoalId:string;status:string})=>item.parentGoalId===group&&item.status==="pending");
      assert.ok(linkage);
      const kept=await app.inject({method:"POST",url:`/api/goal-linkage-decisions/${linkage.id}/decide`,headers:actor.leader,payload:{decision:"keep_parent",reason:"组目标保持不变"}});
      assert.equal(kept.statusCode,200,kept.body);
      const repeatedKeep=await app.inject({method:"POST",url:`/api/goal-linkage-decisions/${linkage.id}/decide`,headers:actor.leader,payload:{decision:"keep_parent",reason:"重复处理"}});
      assert.equal(repeatedKeep.statusCode,409,repeatedKeep.body);

      const second=await app.inject({method:"POST",url:`/api/goals/${personal}/change-requests`,headers:actor.salesperson,payload:{reason:"人事终审测试"}});
      assert.equal(second.statusCode,201,second.body);const secondId=second.json().id as string;
      const acceptedAgain=await app.inject({method:"POST",url:`/api/goal-change-requests/${secondId}/accept`,headers:actor.leader,payload:{newAmount:455,comment:"上级再次接受"}});
      assert.equal(acceptedAgain.statusCode,200,acceptedAgain.body);await sign("salesperson",personal);
      const hrRejected=await app.inject({method:"POST",url:`/api/goals/${personal}/decision`,headers:actor.hr,payload:{decision:"rejected",comment:"人事要求重新核对"}});
      assert.equal(hrRejected.statusCode,200,hrRejected.body);
      const third=await app.inject({method:"POST",url:`/api/goals/${personal}/change-requests`,headers:actor.salesperson,payload:{reason:"人事拒绝后重提"}});
      assert.equal(third.statusCode,201,`人事拒绝候选版本后应允许基于仍生效版本重提：${third.body}`);
      const rejected=await app.inject({method:"POST",url:`/api/goal-change-requests/${third.json().id}/reject`,headers:actor.leader,payload:{comment:"暂不调整"}});
      assert.equal(rejected.statusCode,200,rejected.body);
      const fourth=await app.inject({method:"POST",url:`/api/goals/${personal}/change-requests`,headers:actor.salesperson,payload:{reason:"再次重提申请"}});
      assert.equal(fourth.statusCode,201,fourth.body);
      const concurrent=await Promise.all([
        app.inject({method:"POST",url:`/api/goal-change-requests/${fourth.json().id}/withdraw`,headers:actor.salesperson,payload:{}}),
        app.inject({method:"POST",url:`/api/goal-change-requests/${fourth.json().id}/accept`,headers:actor.leader,payload:{newAmount:460,comment:"并发接受"}}),
      ]);
      assert.deepEqual(concurrent.map((response)=>response.statusCode).sort(),[200,409]);
      if(concurrent[1]!.statusCode===200){await sign("salesperson",personal);const cleanup=await app.inject({method:"POST",url:`/api/goals/${personal}/decision`,headers:actor.hr,payload:{decision:"rejected",comment:"并发测试候选清理"}});assert.equal(cleanup.statusCode,200,cleanup.body);}

      const direct=new Client({connectionString:database.url});await direct.connect();
      try{
        await direct.query("begin");
        await direct.query(
          `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,signed_by,signed_by_person_id,signed_at,signature_text,change_reason)
           select $1,max(version_no)+1,470,'pending_hr',$2,$3,$4,$5,now(),'并发确认','并发候选版本' from goal_versions where goal_id=$1`,
          [personal,scenario.users.leader,scenario.personIds.leader,scenario.users.salesperson,scenario.personIds.salesperson],
        );
        await direct.query("commit");
      }catch(error){await direct.query("rollback");throw error;}finally{await direct.end();}
      const staleRequest=await app.inject({method:"POST",url:`/api/goals/${personal}/change-requests`,headers:actor.salesperson,payload:{reason:"并发版本变化测试"}});
      assert.equal(staleRequest.statusCode,201,staleRequest.body);
      await approve("hr",personal);
      const invalidated=await app.inject({method:"GET",url:"/api/goal-workflows",headers:{cookie:actor.leader.cookie}});
      assert.equal(invalidated.json().changeRequests.find((item:{id:string})=>item.id===staleRequest.json().id).status,"invalidated");
      const staleWithdraw=await app.inject({method:"POST",url:`/api/goal-change-requests/${staleRequest.json().id}/withdraw`,headers:actor.salesperson,payload:{}});
      const staleReject=await app.inject({method:"POST",url:`/api/goal-change-requests/${staleRequest.json().id}/reject`,headers:actor.leader,payload:{comment:"错误处理旧申请"}});
      assert.deepEqual([staleWithdraw.statusCode,staleReject.statusCode],[409,409],"自动失效申请不能再被撤回或拒绝");

      const history=await app.inject({method:"GET",url:`/api/goals/${personal}/history`,headers:{cookie:actor.salesperson.cookie}});
      assert.equal(history.statusCode,200,history.body);
      assert.ok(history.json().versions.length>=2);
      assert.ok(history.json().versions.some((version:{amountDifference:string|null})=>version.amountDifference!==null));
      assert.ok(history.json().audit.some((item:{action:string})=>item.action==="goal.change_completed"));
    });
  });
});

test("个人、组、部门变更可逐级递归且顶层调整必须明确填写金额并重新审批",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedGoalScenario(database.url);
    await withTestApi(database.url,async(app)=>{
      const actor=Object.fromEntries(await Promise.all((["manager","supervisor","leader","salesperson","hr","gm","outsider"] as const).map(async(key)=>[key,await headers(app,`goal_${key}`)]))) as Record<GoalActor,Awaited<ReturnType<typeof headers>>>;
      const create=async(who:GoalActor,payload:Record<string,unknown>)=>{const response=await app.inject({method:"POST",url:"/api/goals",headers:actor[who],payload});assert.equal(response.statusCode,201,response.body);return response.json().id as string;};
      const sign=async(who:GoalActor,id:string)=>{const list=await app.inject({method:"GET",url:"/api/goals",headers:{cookie:actor[who].cookie}});const versionId=list.json().goals.find((goal:{id:string})=>goal.id===id).versionId;const response=await app.inject({method:"POST",url:`/api/goal-versions/${versionId}/confirm`,headers:actor[who],payload:{}});assert.equal(response.statusCode,200,response.body);};
      const approve=async(who:GoalActor,id:string)=>{const response=await app.inject({method:"POST",url:`/api/goals/${id}/decision`,headers:actor[who],payload:{decision:"approved",comment:"同意"}});assert.equal(response.statusCode,200,response.body);};
      const accept=async(who:GoalActor,requestId:string,newAmount:number)=>{const response=await app.inject({method:"POST",url:`/api/goal-change-requests/${requestId}/accept`,headers:actor[who],payload:{newAmount,comment:"明确调整金额"}});assert.equal(response.statusCode,200,response.body);};
      const linkage=async(who:GoalActor,parentGoalId:string)=>{const response=await app.inject({method:"GET",url:"/api/goal-workflows",headers:{cookie:actor[who].cookie}});assert.equal(response.statusCode,200,response.body);const item=response.json().linkageDecisions.find((candidate:{parentGoalId:string;status:string})=>candidate.parentGoalId===parentGoalId&&candidate.status==="pending");assert.ok(item);return item.id as string;};

      const top=await create("manager",{periodMonth:"2026-10",level:"sales_manager",ownerPersonId:Number(scenario.personIds.manager),parentGoalId:null,orgUnitId:null,amount:1000,changeReason:"顶层"});await sign("manager",top);await approve("gm",top);await approve("hr",top);
      const department=await create("manager",{periodMonth:"2026-10",level:"department",ownerPersonId:Number(scenario.personIds.supervisor),parentGoalId:Number(top),orgUnitId:Number(scenario.departmentId),amount:800,changeReason:"部门"});await sign("supervisor",department);await approve("hr",department);
      const group=await create("supervisor",{periodMonth:"2026-10",level:"group",ownerPersonId:Number(scenario.personIds.leader),parentGoalId:Number(department),orgUnitId:Number(scenario.groupId),amount:600,changeReason:"小组"});await sign("leader",group);await approve("hr",group);
      const personal=await create("leader",{periodMonth:"2026-10",level:"personal",ownerPersonId:Number(scenario.personIds.salesperson),parentGoalId:Number(group),orgUnitId:null,amount:400,changeReason:"个人"});await sign("salesperson",personal);await approve("hr",personal);

      const personalRequest=await app.inject({method:"POST",url:`/api/goals/${personal}/change-requests`,headers:actor.salesperson,payload:{reason:"个人目标变化"}});assert.equal(personalRequest.statusCode,201,personalRequest.body);
      await accept("leader",personalRequest.json().id,450);await sign("salesperson",personal);await approve("hr",personal);
      const groupLinkage=await linkage("leader",group);
      const groupAdjust=await app.inject({method:"POST",url:`/api/goal-linkage-decisions/${groupLinkage}/decide`,headers:actor.leader,payload:{decision:"adjust_parent",reason:"调整组目标"}});assert.equal(groupAdjust.statusCode,200,groupAdjust.body);assert.ok(groupAdjust.json().generatedChangeRequestId);
      await accept("supervisor",groupAdjust.json().generatedChangeRequestId,650);await sign("leader",group);await approve("hr",group);

      const departmentLinkage=await linkage("supervisor",department);
      const departmentAdjust=await app.inject({method:"POST",url:`/api/goal-linkage-decisions/${departmentLinkage}/decide`,headers:actor.supervisor,payload:{decision:"adjust_parent",reason:"调整部门目标"}});assert.equal(departmentAdjust.statusCode,200,departmentAdjust.body);assert.ok(departmentAdjust.json().generatedChangeRequestId);
      await accept("manager",departmentAdjust.json().generatedChangeRequestId,850);await sign("supervisor",department);await approve("hr",department);

      const topLinkage=await linkage("manager",top);
      const missingAmount=await app.inject({method:"POST",url:`/api/goal-linkage-decisions/${topLinkage}/decide`,headers:actor.manager,payload:{decision:"adjust_parent",reason:"总目标也要调整"}});
      assert.equal(missingAmount.statusCode,400,missingAmount.body);
      const topAdjust=await app.inject({method:"POST",url:`/api/goal-linkage-decisions/${topLinkage}/decide`,headers:actor.manager,payload:{decision:"adjust_parent",reason:"总目标也要调整",newAmount:1100}});
      assert.equal(topAdjust.statusCode,200,topAdjust.body);assert.ok(topAdjust.json().createdVersionId);
      await sign("manager",top);await approve("gm",top);await approve("hr",top);

      const history=await app.inject({method:"GET",url:`/api/goals/${top}/history`,headers:{cookie:actor.manager.cookie}});
      assert.equal(history.statusCode,200,history.body);assert.equal(history.json().versions[0].amount,"1100.00");assert.equal(history.json().versions[0].status,"active");
      assert.ok(history.json().audit.some((item:{action:string})=>item.action==="goal.version_superseded"));
    });
  });
});
