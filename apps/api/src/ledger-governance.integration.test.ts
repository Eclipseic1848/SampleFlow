import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { assertAccountingPeriodOpen } from "./modules/accounting-periods.js";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Client }=pg;
const TEST_ORIGIN="http://127.0.0.1:4174";
const CORRECTION_DIMENSIONS={businessRegionCode:"CN-AH",businessRegionSourceText:"安徽历史凭证",customerUnit:"历史客户单位".repeat(40),analysisDimensionEvidence:"原业务单与客户凭证"};

async function writeHeaders(app:Parameters<Parameters<typeof withTestApi>[1]>[0],username:string,password="Role@123"){
  const login=await app.inject({method:"POST",url:"/api/auth/login",headers:{origin:TEST_ORIGIN},payload:{username,password}});
  assert.equal(login.statusCode,200,login.body);
  const setCookies=Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"].map(String):[String(login.headers["set-cookie"])];
  const cookies=setCookies.map((value)=>value.split(";",1)[0]??"");
  const csrf=cookies.find((value)=>value.startsWith("sampleflow_csrf="));
  assert.ok(csrf);
  return {cookie:cookies.join("; "),origin:TEST_ORIGIN,"x-csrf-token":decodeURIComponent(csrf.slice("sampleflow_csrf=".length))};
}

async function seedLedgerScenario(databaseUrl:string){
  const member=await seedTestUser(databaseUrl,{username:"ledger_member",displayName:"账本业务员",password:"Role@123",roleCode:"salesperson",roleName:"业务员"});
  const collaborator=await seedTestUser(databaseUrl,{username:"ledger_collaborator",displayName:"账本协作人",password:"Role@123",roleCode:"salesperson",roleName:"业务员"});
  const leader=await seedTestUser(databaseUrl,{username:"ledger_leader",displayName:"账本组长",password:"Role@123",roleCode:"sales_leader",roleName:"业务员组长"});
  const supervisor=await seedTestUser(databaseUrl,{username:"ledger_supervisor",displayName:"账本主管",password:"Role@123",roleCode:"sales_supervisor",roleName:"业务主管"});
  const assistant=await seedTestUser(databaseUrl,{username:"ledger_assistant",displayName:"账本销售助理",password:"Role@123",roleCode:"sales_assistant",roleName:"销售助理"});
  const assistantLeader=await seedTestUser(databaseUrl,{username:"ledger_assistant_leader",displayName:"账本销售助理组长",password:"Role@123",roleCode:"sales_assistant_leader",roleName:"销售助理组长"});
  const hr=await seedTestUser(databaseUrl,{username:"ledger_hr",displayName:"账本人事",password:"Role@123",roleCode:"hr",roleName:"人事部"});
  const client=new Client({connectionString:databaseUrl});await client.connect();
  try{
    const people=await client.query<{user_id:string;id:string}>("select user_id::text,p.id::text from people p where user_id=any($1::bigint[])",[[member,collaborator,leader,supervisor,assistant,assistantLeader,hr]]);
    const personId=(userId:string)=>people.rows.find((row)=>row.user_id===userId)!.id;
    const department=await client.query<{id:string}>("insert into org_units(name,unit_type) values('账本部门','department') returning id::text");
    const group=await client.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('账本小组','group',$1) returning id::text",[department.rows[0]!.id]);
    await client.query("begin");
    await client.query(`insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$3,'leader','2026-01-01'),($2,$4,'supervisor','2026-01-01')`,[personId(leader),personId(supervisor),group.rows[0]!.id,department.rows[0]!.id]);
    await client.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$3,$4,'2026-01-01'),($2,$3,$4,'2026-01-01')",[personId(member),personId(collaborator),department.rows[0]!.id,group.rows[0]!.id]);
    await client.query("update org_units set is_active=true where id=any($1::bigint[])",[[department.rows[0]!.id,group.rows[0]!.id]]);
    await client.query("commit");
    return {
      memberPersonId:personId(member),collaboratorPersonId:personId(collaborator),leaderPersonId:personId(leader),supervisorPersonId:personId(supervisor),
      assistantPersonId:personId(assistant),assistantLeaderPersonId:personId(assistantLeader),hrPersonId:personId(hr),
      departmentId:department.rows[0]!.id,groupId:group.rows[0]!.id,
    };
  }finally{await client.end();}
}

test("负数新订单保留应收未收语义且协作业绩按比例分配不放大公司总额",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedLedgerScenario(database.url);
    await withTestApi(database.url,async(app)=>{
      const assistant=await writeHeaders(app,"ledger_assistant");
      const primary=await writeHeaders(app,"ledger_member");
      const collaborator=await writeHeaders(app,"ledger_collaborator");
      const created=await app.inject({method:"POST",url:"/api/performance/orders",headers:assistant,payload:{
        orderNo:"RECEIVABLE-COLLAB-1",customerName:"协作客户",customerUnit:"协作单位",businessRegionSourceText:"台湾省",
        businessRegionCode:"CN-TW",salespersonPersonId:scenario.memberPersonId,collaboratorPersonId:scenario.collaboratorPersonId,
        collaborationRatio:0.2,serviceType:"检测服务",sourceReceivedOn:"2026-08-15",amount:-10000,reason:"应收未收",
      }});
      assert.equal(created.statusCode,201,created.body);
      const orderId=created.json<{id:string}>().id;
      const order=await app.inject({method:"GET",url:"/api/performance/orders?orderNo=RECEIVABLE-COLLAB-1",headers:{cookie:assistant.cookie}});
      assert.equal(order.statusCode,200,order.body);
      const orderRow=order.json().orders[0];
      assert.equal(orderRow.lifecycleState,"receivable_pending");
      assert.equal(orderRow.currentRevenue,"-10000.00");
      assert.equal(orderRow.businessRegionCode,"CN-TW");
      assert.equal(orderRow.collaboratorName,"账本协作人");
      assert.equal(orderRow.collaborationRatio,"0.200000");
      assert.equal(orderRow.serviceType,"检测服务");
      assert.equal(orderRow.note,"应收未收");
      const primaryDashboard=await app.inject({method:"GET",url:"/api/performance/dashboard?month=2026-08",headers:{cookie:primary.cookie}});
      const collaboratorDashboard=await app.inject({method:"GET",url:"/api/performance/dashboard?month=2026-08",headers:{cookie:collaborator.cookie}});
      const companyDashboard=await app.inject({method:"GET",url:"/api/performance/dashboard?month=2026-08",headers:{cookie:assistant.cookie}});
      assert.equal(primaryDashboard.json().metrics.total,"-8000.00");
      assert.equal(collaboratorDashboard.json().metrics.total,"-2000.00");
      assert.equal(companyDashboard.json().metrics.total,"-10000.00");
      const adjusted=await app.inject({method:"POST",url:`/api/performance/orders/${orderId}/events`,headers:assistant,payload:{type:"revenue_change",newAmount:5000,reason:"到账并转正",idempotencyKey:"receivable-collab-settle"}});
      assert.equal(adjusted.statusCode,201,adjusted.body);
      assert.equal(adjusted.json().state.lifecycle,"active");
      const adjustedOrder=await app.inject({method:"GET",url:"/api/performance/orders?orderNo=RECEIVABLE-COLLAB-1",headers:{cookie:assistant.cookie}});
      assert.equal(adjustedOrder.json().orders[0].note,"应收未收");
      const credits=new Client({connectionString:database.url});await credits.connect();
      try{
        const amounts=await credits.query<{attribution_role:string;amount:string}>(`select attribution_role,sum(attributed_amount)::text amount from performance_event_attributions credit join performance_events event on event.id=credit.event_id where event.order_id=$1 group by attribution_role order by attribution_role`,[orderId]);
        assert.deepEqual(amounts.rows,[{attribution_role:"collaborator",amount:"1000.00"},{attribution_role:"primary",amount:"4000.00"}]);
      }finally{await credits.end();}
    },{clock:()=>new Date("2026-09-01T01:02:03.000Z")});
  });
});

test("正常调整由服务端确定操作日并按稳定顺序幂等追加不可变事件",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedLedgerScenario(database.url);
    const now=new Date("2026-09-01T01:02:03.000Z");
    await withTestApi(database.url,async(app)=>{
      const headers=await writeHeaders(app,"ledger_assistant");
      const invalidBusinessRegion=await app.inject({method:"POST",url:"/api/performance/orders",headers,payload:{orderNo:"CHAIN-BAD-REGION",customerName:"错误区域客户",customerUnit:"测试单位",businessRegionSourceText:"未知区域原文",businessRegionCode:"CN-UNKNOWN",salespersonPersonId:scenario.memberPersonId,sourceReceivedOn:"2026-08-15",amount:1,reason:"非法业务区域"}});
      assert.equal(invalidBusinessRegion.statusCode,400,invalidBusinessRegion.body);
      const normalizedOrderNo=await app.inject({method:"POST",url:"/api/performance/orders",headers,payload:{orderNo:" CHAIN-NORMALIZED",customerName:"编号客户",customerUnit:"测试单位",businessRegionSourceText:"江苏线索",businessRegionCode:"CN-JS",salespersonPersonId:scenario.memberPersonId,sourceReceivedOn:"2026-08-15",amount:1,reason:"编号不得清洗"}});
      assert.equal(normalizedOrderNo.statusCode,400,normalizedOrderNo.body);
      const externalTrade=await app.inject({method:"POST",url:"/api/performance/orders",headers,payload:{orderNo:"CHAIN-EXTERNAL-TRADE",customerName:"外贸客户",customerUnit:"测试单位",businessRegionSourceText:"外贸线索",businessRegionCode:"EXT-TRADE",salespersonPersonId:scenario.memberPersonId,sourceReceivedOn:"2026-08-15",amount:1,reason:"外贸区域"}});
      assert.equal(externalTrade.statusCode,201,externalTrade.body);
      const created=await app.inject({method:"POST",url:"/api/performance/orders",headers,payload:{orderNo:"CHAIN-110",customerName:"链路客户",customerUnit:"测试单位",businessRegionSourceText:"江苏原始线索",businessRegionCode:"CN-JS",salespersonPersonId:scenario.memberPersonId,sourceReceivedOn:"2026-08-15",amount:110,reason:"首次录入"}});
      assert.equal(created.statusCode,201,created.body);
      const orderId=created.json().id;
      const changedDimensions=new Client({connectionString:database.url});await changedDimensions.connect();
      try{
        await changedDimensions.query(
          "update performance_orders set customer_unit='调整后单位',business_region_source_text='浙江原始线索',business_region_code='CN-ZJ' where id=$1",
          [orderId],
        );
      }finally{await changedDimensions.end();}
      const commands=[
        {type:"revenue_change",newAmount:100,reason:"改为 100",idempotencyKey:"chain-change"},
        {type:"pause",reason:"整单暂停",idempotencyKey:"chain-pause"},
        {type:"restart",reason:"订单重启",idempotencyKey:"chain-restart"},
      ];
      for(const command of commands){
        const response=await app.inject({method:"POST",url:`/api/performance/orders/${orderId}/events`,headers,payload:command});
        assert.equal(response.statusCode,201,response.body);
      }
      const changeCommand=commands[0]!;
      const replay=await app.inject({method:"POST",url:`/api/performance/orders/${orderId}/events`,headers,payload:changeCommand});
      assert.equal(replay.statusCode,200,replay.body);
      assert.equal(replay.json().replayed,true);
      const conflict=await app.inject({method:"POST",url:`/api/performance/orders/${orderId}/events`,headers,payload:{...changeCommand,newAmount:90}});
      assert.equal(conflict.statusCode,409,conflict.body);
      const forgedDate=await app.inject({method:"POST",url:`/api/performance/orders/${orderId}/events`,headers,payload:{type:"pause",reason:"伪造日期",idempotencyKey:"forged-date",occurredOn:"2025-01-01"}});
      assert.equal(forgedDate.statusCode,400,forgedDate.body);

      const events=await app.inject({method:"GET",url:`/api/performance/orders/${orderId}/events`,headers:{cookie:headers.cookie}});
      assert.equal(events.statusCode,200,events.body);
      assert.deepEqual(events.json().events.map((event:{deltaAmount:string})=>Number(event.deltaAmount)),[110,-10,-100,100]);
      assert.deepEqual(events.json().events.map((event:{sequence:number})=>event.sequence),[1,2,3,4]);
      assert.deepEqual(events.json().events.slice(1).map((event:{occurredOn:string})=>event.occurredOn),["2026-09-01","2026-09-01","2026-09-01"]);
      assert.deepEqual(events.json().events.slice(1).map((event:{accountingMonth:string})=>event.accountingMonth),["2026-09-01","2026-09-01","2026-09-01"]);
      assert.deepEqual(events.json().events.map((event:{businessRegionCode:string|null;businessRegionSourceText:string|null;customerUnit:string|null})=>({
        businessRegionCode:event.businessRegionCode,businessRegionSourceText:event.businessRegionSourceText,customerUnit:event.customerUnit,
      })),[
        {businessRegionCode:"CN-JS",businessRegionSourceText:"江苏原始线索",customerUnit:"测试单位"},
        ...Array.from({length:3},()=>({businessRegionCode:"CN-ZJ",businessRegionSourceText:"浙江原始线索",customerUnit:"调整后单位"})),
      ]);
    },{clock:()=>now});

    const client=new Client({connectionString:database.runtimeUrl});await client.connect();
    try{
      const businessRegion=await client.query("select business_region_source_text,business_region_code from performance_orders where qingflow_order_no='CHAIN-110'");
      assert.deepEqual(businessRegion.rows[0],{business_region_source_text:"浙江原始线索",business_region_code:"CN-ZJ"});
      const externalTrade=await client.query("select business_region_source_text,business_region_code from performance_orders where qingflow_order_no='CHAIN-EXTERNAL-TRADE'");
      assert.deepEqual(externalTrade.rows[0],{business_region_source_text:"外贸线索",business_region_code:"EXT-TRADE"});
      const snapshots=await client.query<{count:string}>(
        `select count(*)::text from performance_event_analysis_dimensions dimensions
         join performance_events event on event.id=dimensions.event_id
         join performance_orders orders on orders.id=event.order_id where orders.qingflow_order_no='CHAIN-110'`,
      );
      assert.equal(snapshots.rows[0]!.count,"4");
      await assert.rejects(client.query("update performance_event_analysis_dimensions set customer_unit='篡改'"),/业绩分析维度快照不可更新或删除/);
      await assert.rejects(client.query("delete from performance_event_analysis_dimensions"),/业绩分析维度快照不可更新或删除/);
      await assert.rejects(client.query("update performance_events set reason='篡改' where source_row_number is null"),/已入账业绩事件不可更新或删除/);
      await assert.rejects(client.query("delete from performance_events where source_row_number is null"),/已入账业绩事件不可更新或删除/);
    }finally{await client.end();}
  });
});

test("关闭期间仅允许经人事批准的单次范围更正且普通跨月调整进入操作月",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedLedgerScenario(database.url);
    const setupClient=new Client({connectionString:database.url});await setupClient.connect();
    try{
      await setupClient.query(`insert into user_roles(user_id,role_code)
        select id,'hr' from users where username='ledger_assistant_leader' on conflict do nothing`);
      await setupClient.query(`insert into user_roles(user_id,role_code)
        select id,'sales_assistant_leader' from users where username='ledger_hr' on conflict do nothing`);
    }finally{await setupClient.end();}
    const now=new Date("2026-09-10T01:02:03.000Z");
    await withTestApi(database.url,async(app)=>{
      const assistant=await writeHeaders(app,"ledger_assistant");
      const leader=await writeHeaders(app,"ledger_assistant_leader");
      const hr=await writeHeaders(app,"ledger_hr");
      const create=async(orderNo:string)=>{
        const response=await app.inject({method:"POST",url:"/api/performance/orders",headers:assistant,payload:{orderNo,customerName:"月结客户",customerUnit:"测试单位",businessRegionSourceText:"江苏原文",businessRegionCode:"CN-JS",salespersonPersonId:scenario.memberPersonId,sourceReceivedOn:"2026-08-15",amount:100,reason:"八月入账"}});
        assert.equal(response.statusCode,201,response.body);return response.json().id as string;
      };
      const normalOrderId=await create("PERIOD-NORMAL");
      const correctionOrderId=await create("PERIOD-CORRECTION");
      const changedDimensions=new Client({connectionString:database.url});await changedDimensions.connect();
      try{
        await changedDimensions.query(
          "update performance_orders set business_region_code='CN-ZJ',business_region_source_text='浙江当前资料',customer_unit='当前客户单位' where id=$1",
          [correctionOrderId],
        );
      }finally{await changedDimensions.end();}

      const confirmed=await app.inject({method:"POST",url:"/api/accounting-periods/2026-08/confirm-close",headers:leader,payload:{note:"八月数据已核对"}});
      assert.equal(confirmed.statusCode,200,confirmed.body);
      const sameActorClose=await app.inject({method:"POST",url:"/api/accounting-periods/2026-08/close",headers:leader,payload:{note:"同一人员不得关闭"}});
      assert.equal(sameActorClose.statusCode,409,sameActorClose.body);
      const closed=await app.inject({method:"POST",url:"/api/accounting-periods/2026-08/close",headers:hr,payload:{note:"人事关闭八月"}});
      assert.equal(closed.statusCode,200,closed.body);
      const backfill=await app.inject({method:"POST",url:"/api/performance/orders",headers:assistant,payload:{orderNo:"PERIOD-BLOCKED",customerName:"禁止回填",customerUnit:"测试单位",businessRegionSourceText:"江苏原文",businessRegionCode:"CN-JS",salespersonPersonId:scenario.memberPersonId,sourceReceivedOn:"2026-08-20",amount:50,reason:"关闭月补录"}});
      assert.equal(backfill.statusCode,409,backfill.body);
      assert.match(backfill.body,/记账期间已关闭/);

      const paused=await app.inject({method:"POST",url:`/api/performance/orders/${normalOrderId}/events`,headers:assistant,payload:{type:"pause",reason:"九月正常暂停",idempotencyKey:"period-normal-pause"}});
      assert.equal(paused.statusCode,201,paused.body);

      const requested=await app.inject({method:"POST",url:"/api/accounting-corrections",headers:leader,payload:{periodMonth:"2026-08",orderId:correctionOrderId,eventType:"revenue_change",occurredOn:"2026-08-20",reason:"八月原金额核对有误",...CORRECTION_DIMENSIONS}});
      assert.equal(requested.statusCode,201,requested.body);
      const requestId=requested.json().id as string;
      const samePersonApproval=await app.inject({method:"POST",url:`/api/accounting-corrections/${requestId}/approve`,headers:leader,payload:{note:"多角色不能绕过职责分离"}});
      assert.equal(samePersonApproval.statusCode,409,samePersonApproval.body);
      const approved=await app.inject({method:"POST",url:`/api/accounting-corrections/${requestId}/approve`,headers:hr,payload:{note:"同意单笔更正"}});
      assert.equal(approved.statusCode,200,approved.body);
      const forbidden=await app.inject({method:"POST",url:`/api/performance/orders/${correctionOrderId}/events`,headers:assistant,payload:{type:"revenue_change",newAmount:90,reason:"执行更正",idempotencyKey:"correction-once",correctionRequestId:requestId}});
      assert.equal(forbidden.statusCode,403,forbidden.body);

      const correctionPayload={type:"revenue_change",newAmount:90,reason:"执行更正",idempotencyKey:"correction-once",correctionRequestId:requestId};
      const reviewerExecution=await app.inject({method:"POST",url:`/api/performance/orders/${correctionOrderId}/events`,headers:hr,payload:correctionPayload});
      assert.equal(reviewerExecution.statusCode,409,reviewerExecution.body);
      const concurrent=await Promise.all([
        app.inject({method:"POST",url:`/api/performance/orders/${correctionOrderId}/events`,headers:leader,payload:correctionPayload}),
        app.inject({method:"POST",url:`/api/performance/orders/${correctionOrderId}/events`,headers:leader,payload:correctionPayload}),
      ]);
      assert.deepEqual(concurrent.map((response)=>response.statusCode).sort(),[200,201]);
      const reused=await app.inject({method:"POST",url:`/api/performance/orders/${correctionOrderId}/events`,headers:leader,payload:{...correctionPayload,idempotencyKey:"correction-second"}});
      assert.equal(reused.statusCode,409,reused.body);

      const reconfirmed=await app.inject({method:"POST",url:"/api/accounting-periods/2026-08/confirm-close",headers:leader,payload:{note:"更正后重新核对"}});
      assert.equal(reconfirmed.statusCode,200,reconfirmed.body);
      assert.equal(reconfirmed.json().status,"closed");
      const reclosed=await app.inject({method:"POST",url:"/api/accounting-periods/2026-08/close",headers:hr,payload:{note:"更正后重新关账"}});
      assert.equal(reclosed.statusCode,200,reclosed.body);
      assert.equal(reclosed.json().version,2);

      const client=new Client({connectionString:database.url});await client.connect();
      try{
        const evidence=await client.query<{normal_month:string;correction_month:string;correction_occurred_at:string;correction_events:string;request_status:string;audits:string;closure_versions:string;needs_reclose:boolean;business_region_code:string;business_region_source_text:string;customer_unit:string}>(
          `select
             (select accounting_month::text from performance_events where order_id=$1 order by order_sequence desc limit 1) as normal_month,
             (select accounting_month::text from performance_events where order_id=$2 order by order_sequence desc limit 1) as correction_month,
             (select occurred_at::text from performance_events where order_id=$2 order by order_sequence desc limit 1) as correction_occurred_at,
             (select count(*)::text from performance_events where order_id=$2 and event_type='revenue_change') as correction_events,
             (select status from accounting_correction_requests where id=$3) as request_status,
             (select count(*)::text from audit_logs where action like 'accounting.%') as audits,
             (select count(*)::text from accounting_period_closures where period_month='2026-08-01') as closure_versions,
             (select needs_reclose from accounting_periods where period_month='2026-08-01') as needs_reclose,
             (select dimensions.business_region_code from performance_event_analysis_dimensions dimensions join performance_events event on event.id=dimensions.event_id where event.order_id=$2 order by event.order_sequence desc limit 1) as business_region_code,
             (select dimensions.business_region_source_text from performance_event_analysis_dimensions dimensions join performance_events event on event.id=dimensions.event_id where event.order_id=$2 order by event.order_sequence desc limit 1) as business_region_source_text,
             (select dimensions.customer_unit from performance_event_analysis_dimensions dimensions join performance_events event on event.id=dimensions.event_id where event.order_id=$2 order by event.order_sequence desc limit 1) as customer_unit`,
          [normalOrderId,correctionOrderId,requestId],
        );
        assert.equal(evidence.rows[0]!.normal_month,"2026-09-01");
        assert.equal(evidence.rows[0]!.correction_month,"2026-08-01");
        assert.match(evidence.rows[0]!.correction_occurred_at,/2026-09-10/);
        assert.equal(evidence.rows[0]!.correction_events,"1");
        assert.equal(evidence.rows[0]!.request_status,"consumed");
        assert.ok(Number(evidence.rows[0]!.audits)>=4);
        assert.equal(evidence.rows[0]!.closure_versions,"2");
        assert.equal(evidence.rows[0]!.needs_reclose,false);
        assert.equal(evidence.rows[0]!.business_region_code,CORRECTION_DIMENSIONS.businessRegionCode);
        assert.equal(evidence.rows[0]!.business_region_source_text,CORRECTION_DIMENSIONS.businessRegionSourceText);
        assert.equal(evidence.rows[0]!.customer_unit,CORRECTION_DIMENSIONS.customerUnit);
        await assert.rejects(client.query("update accounting_period_closures set note='篡改' where period_month='2026-08-01'"),/记账期间关闭快照不可更新或删除/);
        await assert.rejects(client.query("delete from accounting_period_closures where period_month='2026-08-01'"),/记账期间关闭快照不可更新或删除/);
      }finally{await client.end();}
    },{clock:()=>now});
  });
});

test("关账与在途写入锁定同一期间行且关闭快照包含先取得锁的写入",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedLedgerScenario(database.url);
    const now=new Date("2026-09-10T01:02:03.000Z");
    await withTestApi(database.url,async(app)=>{
      const leader=await writeHeaders(app,"ledger_assistant_leader");
      const hr=await writeHeaders(app,"ledger_hr");
      assert.equal((await app.inject({method:"POST",url:"/api/accounting-periods/2026-08/confirm-close",headers:leader,payload:{note:"并发关账前核对"}})).statusCode,200);

      const writer=new Client({connectionString:database.url});await writer.connect();
      try{
        await writer.query("begin");
        await assertAccountingPeriodOpen(writer,"2026-08-01");
        const closing=app.inject({method:"POST",url:"/api/accounting-periods/2026-08/close",headers:hr,payload:{note:"等待在途写入后关闭"}});
        const early=await Promise.race([closing.then(()=>"closed"),new Promise<string>((resolve)=>setTimeout(()=>resolve("waiting"),75))]);
        assert.equal(early,"waiting");

        const order=await writer.query<{id:string}>(
          `insert into performance_orders
            (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,source_received_on,
             original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
           values('PERIOD-INFLIGHT','并发客户','测试单位',$1,'账本业务员','2026-08-20',25,25,25,'active',now()) returning id::text`,
          [scenario.memberPersonId],
        );
        await writer.query(
          `insert into performance_events
            (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,
             reason,salesperson_name,department_name,group_name,leader_name,supervisor_name,salesperson_person_id,
             department_unit_id,group_unit_id,leader_person_id,supervisor_person_id)
           values($1,'initial',25,25,25,'2026-08-01','2026-08-20','在途写入','账本业务员','账本部门','账本小组',
             '账本组长','账本主管',$2,$3,$4,$5,$6)`,
          [order.rows[0]!.id,scenario.memberPersonId,scenario.departmentId,scenario.groupId,scenario.leaderPersonId,scenario.supervisorPersonId],
        );
        await writer.query("commit");
        const closed=await closing;
        assert.equal(closed.statusCode,200,closed.body);
      }finally{
        await writer.query("rollback").catch(()=>undefined);
        await writer.end();
      }

      const verify=new Client({connectionString:database.url});await verify.connect();
      try{
        const closure=await verify.query<{event_count:string;total_amount:string}>(
          "select event_count::text,total_amount::text from accounting_period_closures where period_month='2026-08-01' and version=1",
        );
        assert.equal(closure.rows[0]!.event_count,"1");
        assert.equal(closure.rows[0]!.total_amount,"25.00");
      }finally{await verify.end();}
    },{clock:()=>now});
  });
});

test("更正申请被拒绝、撤销或批准超过二十四小时后均不能执行",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedLedgerScenario(database.url);
    let now=new Date("2026-09-10T01:02:03.000Z");
    await withTestApi(database.url,async(app)=>{
      const assistant=await writeHeaders(app,"ledger_assistant");
      let leader=await writeHeaders(app,"ledger_assistant_leader");
      const hr=await writeHeaders(app,"ledger_hr");
      const create=async(orderNo:string)=>{
        const response=await app.inject({method:"POST",url:"/api/performance/orders",headers:assistant,payload:{orderNo,customerName:"更正治理客户",customerUnit:"测试单位",businessRegionSourceText:"江苏原文",businessRegionCode:"CN-JS",salespersonPersonId:scenario.memberPersonId,sourceReceivedOn:"2026-08-15",amount:100,reason:"八月入账"}});
        assert.equal(response.statusCode,201,response.body);return response.json().id as string;
      };
      const rejectedOrder=await create("CORRECTION-REJECTED");
      const revokedOrder=await create("CORRECTION-REVOKED");
      const expiredOrder=await create("CORRECTION-EXPIRED");
      assert.equal((await app.inject({method:"POST",url:"/api/accounting-periods/2026-08/confirm-close",headers:leader,payload:{note:"八月核对"}})).statusCode,200);
      assert.equal((await app.inject({method:"POST",url:"/api/accounting-periods/2026-08/close",headers:hr,payload:{note:"八月关账"}})).statusCode,200);

      const request=async(orderId:string,reason:string)=>{
        const response=await app.inject({method:"POST",url:"/api/accounting-corrections",headers:leader,payload:{periodMonth:"2026-08",orderId,eventType:"revenue_change",occurredOn:"2026-08-20",reason,...CORRECTION_DIMENSIONS}});
        assert.equal(response.statusCode,201,response.body);return response.json().id as string;
      };
      const execute=async(orderId:string,requestId:string,key:string)=>app.inject({method:"POST",url:`/api/performance/orders/${orderId}/events`,headers:leader,payload:{type:"revenue_change",newAmount:90,reason:"执行更正",idempotencyKey:key,correctionRequestId:requestId}});

      const rejectedId=await request(rejectedOrder,"申请后拒绝");
      assert.equal((await app.inject({method:"POST",url:`/api/accounting-corrections/${rejectedId}/reject`,headers:hr,payload:{note:"证据不足"}})).statusCode,200);
      assert.equal((await execute(rejectedOrder,rejectedId,"rejected-event")).statusCode,409);

      const revokedId=await request(revokedOrder,"批准后撤销");
      assert.equal((await app.inject({method:"POST",url:`/api/accounting-corrections/${revokedId}/approve`,headers:hr,payload:{note:"先批准"}})).statusCode,200);
      assert.equal((await app.inject({method:"POST",url:`/api/accounting-corrections/${revokedId}/revoke`,headers:hr,payload:{note:"发现新证据"}})).statusCode,200);
      assert.equal((await execute(revokedOrder,revokedId,"revoked-event")).statusCode,409);

      const expiredId=await request(expiredOrder,"批准后过期");
      assert.equal((await app.inject({method:"POST",url:`/api/accounting-corrections/${expiredId}/approve`,headers:hr,payload:{note:"批准"}})).statusCode,200);
      now=new Date(now.getTime()+24*60*60*1000+1);
      leader=await writeHeaders(app,"ledger_assistant_leader");
      const expired=await execute(expiredOrder,expiredId,"expired-event");
      assert.equal(expired.statusCode,409,expired.body);
      assert.match(expired.body,/已过期/);
    },{clock:()=>now});
  });
});

test("历史待核订单保留原始事件语义并经组长核对和人事批准后解锁",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedLedgerScenario(database.url);
    const client=new Client({connectionString:database.runtimeUrl});await client.connect();
    let orderId="";
    try{
      const order=await client.query<{id:string}>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,salesperson_person_id,salesperson_name,source_received_on,
           original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('LEGACY-REVIEW','历史待核客户','测试单位','江苏原文','CN-JS',$1,'账本业务员','2026-08-01',0,0,-50,'historical_review_required',now())
         returning id::text`,[scenario.memberPersonId],
      );
      orderId=order.rows[0]!.id;
      const common=[orderId,scenario.memberPersonId,scenario.departmentId,scenario.groupId,scenario.leaderPersonId,scenario.supervisorPersonId];
      // 模拟迁移前已经存在、没有受控维度证据的历史事件。
      await client.query("set session_replication_role=replica");
      try{
        await client.query(
          `insert into performance_events
            (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,
             reason,salesperson_name,department_name,group_name,leader_name,supervisor_name,source_row_number,
             salesperson_person_id,department_unit_id,group_unit_id,leader_person_id,supervisor_person_id,order_sequence)
           values($1,'legacy_adjustment',50,0,50,'2026-08-01','2026-08-01','原始正向行','账本业务员','账本部门','账本小组','账本组长','账本主管',90001,$2,$3,$4,$5,$6,1),
                 ($1,'legacy_adjustment',-100,0,-50,'2026-08-01','2026-08-02','原始负向行','账本业务员','账本部门','账本小组','账本组长','账本主管',90002,$2,$3,$4,$5,$6,2)`,common,
        );
      }finally{await client.query("set session_replication_role=origin");}
    }finally{await client.end();}

    const now=new Date("2026-09-12T02:00:00.000Z");
    await withTestApi(database.url,async(app)=>{
      const leader=await writeHeaders(app,"ledger_assistant_leader");
      const hr=await writeHeaders(app,"ledger_hr");
      const before=await app.inject({method:"GET",url:`/api/performance/orders/${orderId}/events`,headers:{cookie:leader.cookie}});
      assert.equal(before.statusCode,200,before.body);
      assert.equal(before.json().lifecycleState,"historical_review_required");
      assert.deepEqual(before.json().allowedActions,[]);
      assert.deepEqual(before.json().events.map((event:{resultingLifecycleState:string|null})=>event.resultingLifecycleState),[null,null]);
      assert.deepEqual(before.json().events.map((event:{businessRegionCode:string|null})=>event.businessRegionCode),[null,null]);

      const requested=await app.inject({
        method:"POST",url:"/api/historical-order-reviews",headers:leader,
        payload:{orderId,lifecycleState:"active",currentRevenue:80,conclusion:"核对为当前有效订单",evidence:"轻流订单详情及客户回款凭证",reason:"历史来源缺少初始入账行"},
      });
      assert.equal(requested.statusCode,201,requested.body);
      const reviewId=requested.json().id as string;
      const approved=await app.inject({method:"POST",url:`/api/historical-order-reviews/${reviewId}/approve`,headers:hr,payload:{note:"证据完整，同意解锁"}});
      assert.equal(approved.statusCode,200,approved.body);

      const after=await app.inject({method:"GET",url:`/api/performance/orders/${orderId}/events`,headers:{cookie:leader.cookie}});
      assert.equal(after.statusCode,200,after.body);
      assert.equal(after.json().lifecycleState,"active");
      assert.deepEqual(after.json().allowedActions,["revenue_change","pause"]);
      assert.deepEqual(after.json().events.map((event:{eventType:string})=>event.eventType),["legacy_adjustment","legacy_adjustment","historical_review_resolution"]);
      assert.deepEqual(after.json().events.map((event:{deltaAmount:string})=>Number(event.deltaAmount)),[50,-100,130]);
      assert.deepEqual(after.json().events.map((event:{businessRegionCode:string|null;businessRegionSourceText:string|null;customerUnit:string|null})=>({
        businessRegionCode:event.businessRegionCode,businessRegionSourceText:event.businessRegionSourceText,customerUnit:event.customerUnit,
      })),[
        {businessRegionCode:null,businessRegionSourceText:null,customerUnit:null},
        {businessRegionCode:null,businessRegionSourceText:null,customerUnit:null},
        {businessRegionCode:"CN-JS",businessRegionSourceText:"江苏原文",customerUnit:"测试单位"},
      ]);

      const verify=new Client({connectionString:database.url});await verify.connect();
      try{
        const evidence=await verify.query<{legacy_total:string;all_total:string;state:string;current_revenue:string;review_status:string;snapshot_count:string}>(
          `select
             (select sum(delta_amount)::text from performance_events where order_id=$1 and event_type='legacy_adjustment') as legacy_total,
             (select sum(delta_amount)::text from performance_events where order_id=$1) as all_total,
             (select lifecycle_state from performance_orders where id=$1) as state,
             (select current_revenue::text from performance_orders where id=$1) as current_revenue,
             (select status from historical_order_reviews where id=$2) as review_status,
             (select count(*)::text from performance_event_analysis_dimensions dimensions
                join performance_events event on event.id=dimensions.event_id where event.order_id=$1) as snapshot_count`,[orderId,reviewId],
        );
        assert.equal(evidence.rows[0]!.legacy_total,"-50.00");
        assert.equal(evidence.rows[0]!.all_total,"80.00");
        assert.equal(evidence.rows[0]!.state,"active");
        assert.equal(evidence.rows[0]!.current_revenue,"80.00");
        assert.equal(evidence.rows[0]!.review_status,"approved");
        assert.equal(evidence.rows[0]!.snapshot_count,"1");
      }finally{await verify.end();}
    },{clock:()=>now});
  });
});
