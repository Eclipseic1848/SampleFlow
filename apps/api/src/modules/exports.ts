import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { Query } from "pg";
import type { Database } from "../db.js";
import { businessDate } from "../domain/business-time.js";
import { standardBusinessRegionName } from "../domain/business-regions.js";
import { postgresBigintIdSchema } from "../validation.js";
import { canReadGoals, canReadPerformance, performanceScopeSql, performanceScopeValues, resolveGoalAccess, resolvePerformanceAccess } from "./authorization.js";
import { loadFormalReport } from "./formal-reports.js";
import { latestOrderEventJoinSql, normalizeOrderFilters, orderFilterQuerySchema, orderFilterSql, orderFilterValues, type OrderFilters } from "./order-query.js";

function csvCell(value:unknown):string{if(value===null||value===undefined)return "";if(typeof value==="number"){if(!Number.isFinite(value))throw new Error("CSV 数值无效");return String(value);}let text=String(value);if(/^[\s\p{Cc}]*[=+\-@]/u.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;}
function csvLine(row:unknown[]):string{return row.map(csvCell).join(",");}
function csv(rows:unknown[][]):string{return "\ufeff"+rows.map((row)=>row.map(csvCell).join(",")).join("\r\n");}
async function auditFormalReportExport(db:Database,input:{actorUserId:string;goalId:string;filterSummary:Record<string,string>;rowCount:number;status:"completed"|"blocked";requestId:string;fileSha256:string|null;failureCode?:string},ipAddress:string){
  await db.query(
    `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address)
     values($1,'performance.formal_report_export','goal',$2,$3,$4)`,
    [input.actorUserId,String(input.goalId),JSON.stringify({filterSummary:input.filterSummary,rowCount:input.rowCount,status:input.status,requestId:input.requestId,fileSha256:input.fileSha256,...(input.failureCode?{failureCode:input.failureCode}:{})}),ipAddress],
  );
}
async function auditOrderExport(db:Database,input:{actorUserId:string;filters:OrderFilters;rowCount:number;status:"completed"|"blocked";requestId:string;fileSha256:string|null;failureCode?:string},ipAddress:string){
  await db.query(
    `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address)
     values($1,'performance.order_export','order_export',$2,$3,$4)`,
    [input.actorUserId,input.requestId,JSON.stringify({filterSummary:input.filters,rowCount:input.rowCount,status:input.status,requestId:input.requestId,fileSha256:input.fileSha256,...(input.failureCode?{failureCode:input.failureCode}:{})}),ipAddress],
  );
}
type OrderExportRow={orderNo:string;customerName:string;customerUnit:string;salespersonName:string;departmentName:string|null;groupName:string|null;businessRegionSourceText:string|null;businessRegionCode:string|null;sourceReceivedOn:string;currentRevenue:string;countedAmount:string;lifecycleState:string};
type PausableSource={pause():void;resume():void};
const orderExportHeader=["订单编号","客户","客户单位","业务员","部门","小组","来源区域原文","标准业务区域","到样日期","当前营业额","当前计入金额","状态"];
export async function registerExports(app:FastifyInstance,db:Database,clock:()=>Date=()=>new Date()){
  app.get("/api/exports/formal-reports/:goalId.csv",async(request,reply)=>{
    if(!request.currentUser)return reply.code(401).send({message:"尚未登录"});
    const parsedGoalId=postgresBigintIdSchema.safeParse((request.params as {goalId?:string}).goalId);
    if(!parsedGoalId.success)return reply.code(400).send({message:"目标标识无效"});
    const goalId=parsedGoalId.data;
    const result=await loadFormalReport(db,request.currentUser,goalId,businessDate(clock()));
    if(!result.ok){
      const failureCode=result.body.code??(result.statusCode===403?"ACCESS_DENIED":result.statusCode===404?"REPORT_NOT_FOUND":"REPORT_BLOCKED");
      await auditFormalReportExport(db,{actorUserId:request.currentUser.id,goalId,filterSummary:{goalId:String(goalId)},rowCount:0,status:"blocked",requestId:request.id,fileSha256:null,failureCode},request.ip);
      return reply.code(result.statusCode).send(result.body);
    }
    const report=result.report;
    const body=csv([["正式业绩报表"],["目标月份","目标层级","责任人","生效目标","实际业绩","目标差距","达成率"],[report.periodMonth,report.level,report.ownerName,report.targetAmount,report.actualAmount,report.gapAmount,report.achievementRate===null?"不计算":`${report.achievementRate}%`]]);
    const fileSha256=createHash("sha256").update(body).digest("hex");
    await auditFormalReportExport(db,{actorUserId:request.currentUser.id,goalId,filterSummary:{goalId:report.goalId,periodMonth:report.periodMonth,level:report.level},rowCount:1,status:"completed",requestId:request.id,fileSha256},request.ip);
    return reply.header("content-type","text/csv; charset=utf-8").header("content-disposition",`attachment; filename="sampleflow-formal-report-${report.periodMonth}-${report.goalId}.csv"`).send(body);
  });
  app.get("/api/exports/performance.csv",async(request,reply)=>{
    if(!request.currentUser)return reply.code(401).send({message:"尚未登录"});
    const access=await resolvePerformanceAccess(db,request.currentUser);
    const parsed=orderFilterQuerySchema.safeParse(request.query);
    const filters=parsed.success?normalizeOrderFilters(parsed.data):normalizeOrderFilters({});
    if(!canReadPerformance(access)){
      await auditOrderExport(db,{actorUserId:request.currentUser.id,filters,rowCount:0,status:"blocked",requestId:request.id,fileSha256:null,failureCode:"ACCESS_DENIED"},request.ip);
      return reply.code(403).send({message:"当前角色没有业务导出权限"});
    }
    if(!parsed.success){
      await auditOrderExport(db,{actorUserId:request.currentUser.id,filters,rowCount:0,status:"blocked",requestId:request.id,fileSha256:null,failureCode:"FILTER_INVALID"},request.ip);
      return reply.code(400).send({message:"查询条件无效"});
    }
    const client=await db.connect();
    const output=new PassThrough();
    const hash=createHash("sha256");
    const source=(client as unknown as {connection:{stream:PausableSource}}).connection.stream;
    let rowCount=0;
    let sourcePaused=false;
    let finished=false;
    const resume=()=>{if(sourcePaused&&!finished){sourcePaused=false;source.resume();}};
    const write=(chunk:string)=>{hash.update(chunk,"utf8");if(!output.write(chunk,"utf8")&&!sourcePaused){sourcePaused=true;source.pause();}};
    output.on("drain",resume);
    write(`\ufeff${csvLine(orderExportHeader)}`);
    const query=new Query<OrderExportRow>({
      text:`select performance_orders.qingflow_order_no as "orderNo",performance_orders.customer_name as "customerName",
                   performance_orders.customer_unit as "customerUnit",performance_orders.salesperson_name as "salespersonName",
                   latest.department_name as "departmentName",latest.group_name as "groupName",
                   performance_orders.business_region_source_text as "businessRegionSourceText",
                   performance_orders.business_region_code as "businessRegionCode",performance_orders.source_received_on::text as "sourceReceivedOn",
                   performance_orders.current_revenue::text as "currentRevenue",performance_orders.counted_amount::text as "countedAmount",
                   performance_orders.lifecycle_state as "lifecycleState"
            from performance_orders
            ${latestOrderEventJoinSql("performance_orders","latest")}
            where ${performanceScopeSql("latest",1)} and ${orderFilterSql("performance_orders","latest",5)}
            order by performance_orders.created_at desc,performance_orders.id desc`,
      values:[...performanceScopeValues(access),...orderFilterValues(filters)],
    });
    const release=(error?:Error)=>client.release(error);
    const fail=(error:Error,failureCode="EXPORT_FAILED")=>{
      if(finished)return;finished=true;output.off("drain",resume);release(error);
      void auditOrderExport(db,{actorUserId:request.currentUser!.id,filters,rowCount,status:"blocked",requestId:request.id,fileSha256:null,failureCode},request.ip)
        .catch(()=>undefined).finally(()=>output.destroy(error));
    };
    const abort=()=>fail(new Error("订单导出连接已中断"),"EXPORT_ABORTED");
    request.raw.once("aborted",abort);
    reply.raw.once("close",()=>{if(!reply.raw.writableEnded)abort();});
    query.on("row",(row:OrderExportRow)=>{
      if(finished)return;
      rowCount+=1;
      write(`\r\n${csvLine([row.orderNo,row.customerName,row.customerUnit,row.salespersonName,row.departmentName,row.groupName,row.businessRegionSourceText,standardBusinessRegionName(row.businessRegionCode??"")??row.businessRegionCode,row.sourceReceivedOn,Number(row.currentRevenue),Number(row.countedAmount),row.lifecycleState])}`);
    });
    query.once("error",fail);
    query.once("end",()=>{
      if(finished)return;finished=true;output.off("drain",resume);release();
      const fileSha256=hash.digest("hex");
      void auditOrderExport(db,{actorUserId:request.currentUser!.id,filters,rowCount,status:"completed",requestId:request.id,fileSha256},request.ip)
        .then(()=>output.end()).catch((error:Error)=>output.destroy(error));
    });
    try{client.query(query);}catch(error){fail(error instanceof Error?error:new Error("订单导出查询提交失败"));}
    return reply.header("content-type","text/csv; charset=utf-8").header("content-disposition",`attachment; filename="sampleflow-orders-${businessDate(clock())}.csv"`).send(output);
  });
  app.get("/api/exports/goals.csv",async(request,reply)=>{if(!request.currentUser)return reply.code(401).send({message:"尚未登录"});const access=await resolveGoalAccess(db,request.currentUser);if(!canReadGoals(access))return reply.code(403).send({message:"当前角色没有目标导出权限"});const result=await db.query(`select g.period_month::text,g.goal_level,u.username,u.display_name,v.version_no::text,v.amount::text,v.status,v.signature_text,v.signed_at::text,v.change_reason from goals g join users u on u.id=g.owner_user_id join goal_versions v on v.goal_id=g.id where ($1::boolean or g.owner_person_id=any($2::bigint[])) order by g.period_month,g.goal_level,u.display_name,v.version_no`,[access.all,access.ownerPersonIds]);const rows:unknown[][]=[["目标月份","目标层级","责任人账号","责任人姓名","版本","金额","状态","确认声明","确认时间","变更原因"],...result.rows.map((row)=>Object.values(row))];return reply.header("content-type","text/csv; charset=utf-8").header("content-disposition",`attachment; filename="sampleflow-goals-${new Date().toISOString().slice(0,10)}.csv"`).send(csv(rows));});
}
