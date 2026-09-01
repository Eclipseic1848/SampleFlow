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
  return fetch(input, { ...init, headers });
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
export function goalAuditName(action:string){return ({"goal.version_created":"创建目标版本","goal.version_confirmed":"责任人实名确认","goal.version_signed":"历史责任人确认","goal.approved":"审批批准","goal.rejected":"审批拒绝","goal.version_superseded":"替代旧版本","goal.change_requested":"提交修改申请","goal.change_accepted":"接受修改申请","goal.change_rejected":"拒绝修改申请","goal.change_withdrawn":"撤回修改申请","goal.change_invalidated":"修改申请失效","goal.change_completed":"修改流程完成","goal.linkage_requested":"生成目标联动待办","goal.linkage_decided":"完成目标联动选择"} as Record<string,string>)[action]??action;}
