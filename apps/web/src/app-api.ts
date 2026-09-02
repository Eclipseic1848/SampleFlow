export const GOAL_CONFIRMATION_STATEMENT="本人已核对并确认承担本目标版本。";

export const roleNames: Record<string, string> = { system_admin: "系统管理员", sales_assistant: "销售助理", sales_assistant_leader: "销售助理组长", sales_manager: "销售经理", sales_supervisor: "业务主管", sales_leader: "业务员组长", salesperson: "业务员", hr: "人事部", general_manager: "总经理" };
export function businessDateToday():string{const parts=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const value=(type:Intl.DateTimeFormatPartTypes)=>parts.find((part)=>part.type===type)?.value??"";return `${value("year")}-${value("month")}-${value("day")}`;}

export function readCsrfToken(): string | null {
  const cookie = document.cookie.split("; ").find((item) => item.startsWith("sampleflow_csrf="));
  return cookie ? decodeURIComponent(cookie.slice("sampleflow_csrf=".length)) : null;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrfToken = readCsrfToken();
    if (csrfToken) headers.set("x-csrf-token", csrfToken);
  }
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 && !["/api/auth/login","/api/auth/change-password"].some((path)=>String(input).startsWith(path))) {
    window.dispatchEvent(new Event("sampleflow:session-expired"));
  }
  return response;
}

export async function logoutCurrentSession():Promise<"logged-out"|"active"|"uncertain">{
  let requestFailed=false;
  try{const response=await apiFetch("/api/auth/logout",{method:"POST"});if(response.ok||response.status===401)return "logged-out";}catch{requestFailed=true;}
  try{if((await apiFetch("/api/auth/me")).status===401)return "logged-out";}catch{return "uncertain";}
  return requestFailed?"uncertain":"active";
}

export async function downloadApiFile(input: RequestInfo | URL): Promise<boolean> {
  const response = await apiFetch(input);
  if (response.status === 401) return false;
  if (!response.ok) throw new Error("导出失败，请重试。");
  const filename = /filename="?([^";]+)"?/i.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "sampleflow-export.csv";
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return true;
}

export async function readResponseJson<T>(response:Response,fallback:string):Promise<T>{
  try{return await response.json() as T;}catch{throw new Error(fallback);}
}

export function formatMoney(value: string | number) {
  if(typeof value==="string"){
    const decimal=/^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
    if(decimal)return `${decimal[1]}¥${new Intl.NumberFormat("zh-CN").format(BigInt(decimal[2]!))}.${(decimal[3]??"").padEnd(2,"0")}`;
  }
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(Number(value));
}
export function formatOperationTime(value:string){return new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(value));}
export function eventTypeName(type: string) { return ({ initial:"首次录入", revenue_change:"营业额修改", pause:"整单暂停", restart:"订单重启", first_include:"首次计入", legacy_adjustment:"历史迁移",historical_review_resolution:"历史核对解析" } as Record<string,string>)[type] ?? type; }

export function goalLevelName(level: string) { return ({ sales_manager:"销售经理总目标", department:"部门目标", group:"小组目标", personal:"个人目标" } as Record<string,string>)[level] ?? level; }
export function goalStatusName(status: string) { return ({ draft:"草稿", pending_signature:"待责任人确认", pending_gm:"待总经理审批", pending_hr:"待人事审批", active:"已生效", rejected:"已拒绝", superseded:"已替代" } as Record<string,string>)[status] ?? status; }
export function workflowStatusName(status:string){return ({pending:"待处理",accepted:"已接受，待重新确认",rejected:"已拒绝",withdrawn:"已撤回",invalidated:"已失效",completed:"已完成"} as Record<string,string>)[status]??status;}
const auditActionNames:Record<string,string>={
  "auth.account_created":"创建账号","auth.account_roles_changed":"修改账号角色","auth.account_status_changed":"修改账号状态","auth.admin_bootstrapped":"初始化管理员","auth.login_succeeded":"登录成功","auth.logout":"退出登录","auth.password_changed":"修改密码","auth.password_reset":"重置密码",
  "organization.pagination_fixture":"组织分页记录","organization.unit_created":"新增组织单元","organization.unit_activated":"启用组织单元","organization.assignment_created":"新增人员任职","organization.assignment_closed":"关闭人员任职","organization.assignment_closed_for_transfer":"组织异动关闭原任职","organization.responsibility_created":"新增负责人职责","organization.responsibility_replaced":"更换负责人",
  "performance.order_posted":"订单入账","performance.event_posted":"业绩事件入账","performance.order_export":"导出授权范围订单","performance.formal_report_export":"导出正式业绩报表","performance.cursor_test":"业绩分页记录",
  "import.config_created":"创建导入配置","import.config_approved":"批准导入配置","import.batch_preflighted":"导入批次预检","import.batch_confirmed":"确认导入批次","import.dimension_backfill_preflighted":"分析维度补齐预检","import.dimension_backfill_confirmed":"确认分析维度补齐","import.dimension_backfill_confirm_failed":"分析维度补齐失败",
  "goal.version_created":"创建目标版本","goal.version_confirmed":"责任人实名确认","goal.version_signed":"历史责任人确认","goal.approved":"审批批准","goal.rejected":"审批拒绝","goal.version_superseded":"替代旧版本","goal.change_requested":"提交修改申请","goal.change_accepted":"接受修改申请","goal.change_rejected":"拒绝修改申请","goal.change_withdrawn":"撤回修改申请","goal.change_invalidated":"修改申请失效","goal.change_completed":"修改流程完成","goal.linkage_requested":"生成目标联动待办","goal.linkage_decided":"完成目标联动选择",
};
const auditDomainNames:Record<string,string>={auth:"账号",organization:"组织",performance:"业绩",import:"导入",goal:"目标",audit:"审计",development:"开发维护"};
const auditEntityNames:Record<string,string>={user:"账号",org_unit:"组织单元",org_membership:"人员任职",org_responsibility:"负责人职责",performance_order:"业绩订单",performance_event:"业绩事件",goal:"目标",goal_version:"目标版本",goal_change_request:"目标修改申请",goal_linkage_decision:"目标联动待办",import_config:"导入配置",import_batch:"导入批次"};
const auditFieldNames:Record<string,string>={roles:"角色",personId:"人员",isActive:"是否启用",name:"名称",unitType:"组织类型",parentId:"上级组织",effectiveFrom:"生效日期",effectiveTo:"结束日期",effectiveOn:"办理日期",result:"处理结果",ownerPersonId:"责任人",orgUnitId:"责任组织",parentGoalId:"上级目标",periodMonth:"目标月份",level:"目标层级",amount:"目标金额",previousAmount:"原目标金额",newAmount:"新目标金额",changeReason:"变更原因",status:"状态",statement:"确认声明",confirmedAt:"确认时间",decision:"处理决定",comment:"处理意见",requestId:"请求标识",rowCount:"记录数",fileSha256:"文件校验值",failureCode:"失败原因",filterSummary:"筛选范围",customer:"客户",currentRevenue:"当前营业额",countedAmount:"计入业绩",reason:"原因",sourceSha256:"来源文件校验值",sourceFilename:"来源文件",predecessor:"原负责人",successor:"继任负责人",username:"账号",displayName:"姓名"};
const auditValueNames:Record<string,string>={succeeded:"成功",completed:"已完成",blocked:"已阻止",approved:"已批准",rejected:"已拒绝",pending:"待处理",department:"部门",group:"小组",personal:"个人",sales_manager:"销售经理总目标",leader:"小组负责人",supervisor:"部门主管"};

export function auditActionName(action:string){return auditActionNames[action]??`${auditDomainNames[action.split(".")[0]??""]??"其他"}业务操作`;}
export function auditEntityName(entityType:string){return auditEntityNames[entityType]??"业务记录";}
function auditValueText(value:unknown):string{
  if(value===null||value===undefined)return "无";
  if(typeof value==="boolean")return value?"是":"否";
  if(typeof value==="string")return roleNames[value]??auditValueNames[value]??value;
  if(typeof value==="number"||typeof value==="bigint")return String(value);
  if(Array.isArray(value))return value.length?value.map(auditValueText).join("、"):"无";
  if(typeof value==="object")return Object.entries(value as Record<string,unknown>).map(([key,item])=>`${auditFieldNames[key]??"补充信息"}：${auditValueText(item)}`).join("；")||"无";
  return String(value);
}
export function auditDataText(value:unknown){return value===null||value===undefined?"—":auditValueText(value);}
export function goalAuditName(action:string){return auditActionName(action);}
