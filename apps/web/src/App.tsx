import { FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, BarChart3, ChevronRight, ClipboardCheck, Database, FileClock, LogOut, Network, PauseCircle, PlayCircle, Plus, RefreshCw, Search, ShieldCheck, Target, UsersRound, X } from "lucide-react";

type Capabilities = { viewPerformance:boolean; viewGoals:boolean; viewOrganization:boolean; viewApprovals:boolean; editPerformance:boolean; exportPerformance:boolean; exportGoals:boolean; manageAccounts:boolean; manageOrganization:boolean };
type User = { id: string; personId:string; username: string; displayName: string; mustChangePassword: boolean; roles: string[]; capabilities:Capabilities };
type AuthState = { status: "loading" } | { status: "guest" } | { status: "authenticated"; user: User };
type OrderLifecycle = "draft" | "active" | "paused" | "zero" | "historical_review_required";
type Order = { id: string; orderNo: string; customerName: string; customerUnit: string; salespersonName: string; serviceType: string | null; sourceReceivedOn: string; originalAmount: string; currentRevenue: string; countedAmount: string; lifecycleState: OrderLifecycle; postedAt: string; departmentName:string; groupName:string; leaderName:string|null; supervisorName:string|null };
type PerformanceEvent = { id:string; sequence:number; eventType:string; deltaAmount:string; resultingCurrentRevenue:string; resultingCountedAmount:string; resultingLifecycleState:OrderLifecycle|null; accountingMonth:string; occurredOn:string; occurredAt:string; reason:string|null; actorName:string|null; salespersonName:string; departmentName:string|null; groupName:string|null; leaderName:string|null; supervisorName:string|null };
type AccountingPeriod={periodMonth:string;status:"open"|"closed";version:number;needsReclose:boolean;verifiedAt:string|null;verifiedBy:string|null;closedAt:string|null;closedBy:string|null};
type AccountingCorrection={id:string;periodMonth:string;orderId:string;orderNo:string;eventType:string;occurredOn:string;reason:string;status:"pending"|"approved"|"rejected"|"consumed"|"revoked";requestedBy:string;reviewedBy:string|null;reviewNote:string|null;expiresAt:string|null};
type HistoricalReview={id:string;orderId:string;orderNo:string;lifecycleState:"active"|"paused"|"zero";currentRevenue:string;conclusion:string;evidence:string;reason:string;status:"pending"|"approved"|"rejected";requestedBy:string;reviewedBy:string|null;reviewNote:string|null};
type DashboardData = { month: string; metrics: { total: string; eventCount: number; negativeTotal: string; pendingApprovals: number }; monthly: Array<{ month: string; total: string }>; groups: Array<{ name: string; total: string }>; recent: Array<{ orderNo: string; salespersonName: string; eventType: string; month: string; amount: string; groupName: string }> };
type Goal = { id: string; periodMonth: string; level: "sales_manager"|"department"|"group"|"personal"; ownerUsername: string; ownerName: string; parentGoalId: string|null; versionId: string; versionNo: string; amount: string; status: string; signatureText: string|null; signedAt: string|null; changeReason: string; allocatedAmount: string };
type FormalReport = { goalId:string; periodMonth:string; level:Goal["level"]; ownerName:string; targetAmount:string; actualAmount:string; achievementRate:string|null };
type AdminUser = { id:string; username:string; displayName:string; isActive:boolean; mustChangePassword:boolean; roles:string[] };
type PersonOption = { id:string; displayName:string; username:string|null };
type RolePermission = { code:string; name:string; businessScope:"none"|"self"|"group"|"department"|"all"; businessOperations:readonly string[]; targetResponsibilities:string; exportPermission:string; forbidden:readonly string[] };
type OrgUnit = { id:string; name:string; unitType:"department"|"group"; parentId:string|null; parentName:string|null; isActive:boolean };
type Assignment = { id:string; username:string; displayName:string; departmentName:string|null; groupName:string|null; effectiveFrom:string; effectiveTo:string|null };
const roleNames: Record<string, string> = { system_admin: "系统管理员", sales_assistant: "销售助理", sales_assistant_leader: "销售助理组长", sales_manager: "销售经理", sales_supervisor: "业务主管", sales_leader: "业务员组长", salesperson: "业务员", hr: "人事部", general_manager: "总经理" };
function businessDateToday():string{const parts=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const value=(type:Intl.DateTimeFormatPartTypes)=>parts.find((part)=>part.type===type)?.value??"";return `${value("year")}-${value("month")}-${value("day")}`;}

function readCsrfToken(): string | null {
  const cookie = document.cookie.split("; ").find((item) => item.startsWith("sampleflow_csrf="));
  return cookie ? decodeURIComponent(cookie.slice("sampleflow_csrf=".length)) : null;
}

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrfToken = readCsrfToken();
    if (csrfToken) headers.set("x-csrf-token", csrfToken);
  }
  return fetch(input, { ...init, headers });
}

function passwordStrength(password: string): "弱" | "中" | "强" {
  const categoryCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (password.length >= 12 && categoryCount === 4) return "强";
  if (password.length >= 8 && categoryCount >= 3) return "中";
  return "弱";
}

async function getCurrentUser(): Promise<User | null> {
  const response = await apiFetch("/api/auth/me");
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("无法读取登录状态");
  return (await response.json() as { user: User }).user;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  useEffect(() => { getCurrentUser().then((user) => setAuth(user ? { status: "authenticated", user } : { status: "guest" })).catch(() => setAuth({ status: "guest" })); }, []);
  if (auth.status === "loading") return <div className="app-loading">正在连接 SampleFlow…</div>;
  if (auth.status === "guest") return <Login onLogin={(user) => setAuth({ status: "authenticated", user })} />;
  if (auth.user.mustChangePassword) return <ChangePassword onChanged={async()=>{const user=await getCurrentUser();if(user)setAuth({status:"authenticated",user});}}/>;
  return <Dashboard user={auth.user} onLogout={() => setAuth({ status: "guest" })} />;
}

function ChangePassword({onChanged}:{onChanged:()=>Promise<void>}){
  const[currentPassword,setCurrentPassword]=useState("");
  const[newPassword,setNewPassword]=useState("");
  const[message,setMessage]=useState("");
  async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/auth/change-password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({currentPassword,newPassword})});const data=await response.json() as {message?:string};if(!response.ok){setMessage(data.message??"密码修改失败");return;}await onChanged();}
  return <main className="password-shell"><section className="login-card"><div className="login-heading"><p>首次登录安全设置</p><h2>请修改初始密码</h2><span>6—128 位，并包含英文字母、数字和符号</span></div><form noValidate onSubmit={submit}><label htmlFor="current-password">当前密码</label><input id="current-password" type="password" value={currentPassword} onChange={(e)=>setCurrentPassword(e.target.value)} autoComplete="current-password"/><label htmlFor="new-password">新密码</label><input id="new-password" type="password" value={newPassword} onChange={(e)=>setNewPassword(e.target.value)} autoComplete="new-password"/><p className="password-strength" aria-live="polite">密码强度：{passwordStrength(newPassword)}</p><button type="submit">保存新密码</button>{message?<p className="form-error">{message}</p>:null}</form></section></main>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("sales_assistant");
  const [password, setPassword] = useState("SampleFlow@2026");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setSubmitting(true); setMessage("");
    try {
      const response = await apiFetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
      const data = await response.json() as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "登录失败");
      const user = await getCurrentUser();
      if (!user) throw new Error("登录会话创建失败");
      onLogin(user);
    } catch (error) { setMessage(error instanceof Error ? error.message : "登录失败"); }
    finally { setSubmitting(false); }
  }
  return <main className="login-shell">
    <section className="brand-panel"><div className="brand-mark">SF</div><div className="brand-copy"><p className="product-name">SampleFlow</p><h1>每一笔业绩，都有清晰的来路与责任。</h1><p className="brand-summary">面向销售到样业务的目标、订单、组织归属与审批系统。历史不重写，调整有事件，结果可追溯。</p></div><div className="principles"><div><Activity size={20} /><span>实时业绩事件</span></div><div><ShieldCheck size={20} /><span>角色权限分离</span></div><div><Database size={20} /><span>集中数据与审计</span></div></div></section>
    <section className="login-panel"><div className="login-card"><div className="login-heading"><p>销售到样业绩管理</p><h2>登录系统</h2><span>开发环境已预填销售助理演示账号</span></div><form noValidate onSubmit={submit}><label htmlFor="username">账号</label><input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /><label htmlFor="password">密码</label><input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" /><button type="submit" disabled={submitting}>{submitting ? "正在登录…" : "进入 SampleFlow"}<ChevronRight size={18} /></button>{message ? <p className="form-error" role="alert">{message}</p> : null}</form><div className="readiness readiness-ready"><span />前端、API 与数据库已连接</div></div></section>
  </main>;
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  type PageId = "overview"|"goals"|"orders"|"organization"|"approvals"|"accounts";
  const pages = [
    user.capabilities.viewPerformance ? {id:"overview" as const,Icon:BarChart3,label:"业绩总览"} : null,
    user.capabilities.viewGoals ? {id:"goals" as const,Icon:Target,label:"目标管理"} : null,
    user.capabilities.viewPerformance ? {id:"orders" as const,Icon:ClipboardCheck,label:"订单业绩"} : null,
    user.capabilities.viewOrganization ? {id:"organization" as const,Icon:Network,label:"组织架构"} : null,
    user.capabilities.viewApprovals ? {id:"approvals" as const,Icon:FileClock,label:"审批中心"} : null,
    user.capabilities.manageAccounts ? {id:"accounts" as const,Icon:UsersRound,label:"账号管理"} : null,
  ].filter((page):page is NonNullable<typeof page>=>page!==null);
  const [active, setActive] = useState<PageId>(user.capabilities.manageAccounts ? "accounts" : pages[0]?.id??"overview");
  async function logout() { await apiFetch("/api/auth/logout", { method: "POST" }); onLogout(); }
  const content = active === "orders"
    ? <OrdersPage user={user} />
    : active === "goals"
      ? <GoalsPage user={user} pendingOnly={false} />
      : active === "approvals"
        ? <GoalsPage user={user} pendingOnly />
      : active === "organization"
        ? <OrganizationPage user={user}/>
      : active === "accounts"
        ? <AccountsPage user={user}/>
      : <Overview canEdit={user.capabilities.editPerformance} canExport={user.capabilities.exportPerformance} onEnterOrders={() => setActive("orders")} />;
  return <div className="app-shell"><aside className="sidebar"><div className="sidebar-brand"><span>SF</span><strong>SampleFlow</strong></div><nav>{pages.map(({Icon,label,id}) => <button className={id === active ? "active" : ""} key={id} onClick={() => setActive(id)} aria-label={label} aria-current={id===active?"page":undefined}><Icon size={18}/><span>{label}</span></button>)}</nav><div className="sidebar-user"><div className="avatar">{user.displayName.slice(0,1)}</div><div><strong>{user.displayName}</strong><span>{user.roles.map((r) => roleNames[r] ?? r).join("、")}</span></div><button onClick={logout} aria-label="退出登录"><LogOut size={17}/></button></div></aside>{content}</div>;
}

function AccountsPage({user}:{user:User}){
  const [users,setUsers]=useState<AdminUser[]>([]);const [roles,setRoles]=useState<Array<{code:string;name:string}>>([]);const [permissionMatrix,setPermissionMatrix]=useState<RolePermission[]>([]);const [message,setMessage]=useState("");const [showCreate,setShowCreate]=useState(false);const [temporaryCredential,setTemporaryCredential]=useState<{username:string;password:string;expiresAt:string}|null>(null);const isAdmin=user.capabilities.manageAccounts;
  const load=useCallback(async()=>{if(!isAdmin)return;const response=await fetch("/api/admin/users");const data=await response.json() as {users?:AdminUser[];roles?:Array<{code:string;name:string}>;permissionMatrix?:RolePermission[];message?:string};if(!response.ok)throw new Error(data.message??"账号加载失败");setUsers(data.users??[]);setRoles(data.roles??[]);setPermissionMatrix(data.permissionMatrix??[]);},[isAdmin]);useEffect(()=>{load().catch((error)=>setMessage(error instanceof Error?error.message:"账号加载失败"));},[load]);
  async function toggle(item:AdminUser){const response=await apiFetch(`/api/admin/users/${item.id}/status`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({isActive:!item.isActive})});const data=await response.json() as {message?:string};if(!response.ok){setMessage(data.message??"状态修改失败");return;}await load();}
  async function resetPassword(item:AdminUser){const response=await apiFetch(`/api/admin/users/${item.id}/reset-password`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const data=await response.json() as {message?:string;temporaryPassword?:string;temporaryPasswordExpiresAt?:string};if(!response.ok||!data.temporaryPassword||!data.temporaryPasswordExpiresAt){setMessage(data.message??"密码重置失败");return;}setTemporaryCredential({username:item.username,password:data.temporaryPassword,expiresAt:data.temporaryPasswordExpiresAt});await load();}
  return <main className="dashboard"><header><div><h1>账号管理</h1><p>系统管理权限与业务权限分离；业务角色必须显式分配</p></div>{isAdmin?<button className="primary-action" onClick={()=>setShowCreate(true)}><Plus size={16}/>创建账号</button>:null}</header>{!isAdmin?<div className="permission-note"><ShieldCheck size={18}/>仅独立系统管理员可以维护账号和角色。</div>:null}{message?<p className="page-message">{message}</p>:null}{isAdmin?<><section className="orders-card"><div className="orders-toolbar"><div><h2>系统账号</h2><span>{users.length} 个账号</span></div></div><div className="orders-table-wrap"><table><thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{users.map((item)=><tr key={item.id}><td>{item.username}</td><td>{item.displayName}</td><td>{item.roles.map((role)=>roleNames[role]??role).join("、")}</td><td><span className={`status ${item.isActive?"status-active":"status-paused"}`}>{item.isActive?"启用":"停用"}</span></td><td><div className="table-actions"><button className="table-action" onClick={()=>resetPassword(item)}>重置密码</button><button className="table-action" onClick={()=>toggle(item)}>{item.isActive?"停用":"启用"}</button></div></td></tr>)}</tbody></table></div></section><section className="orders-card permission-matrix-card" aria-labelledby="permission-matrix-title"><div className="orders-toolbar"><div><h2 id="permission-matrix-title">角色权限说明</h2><span>多角色账号取各角色权限并集；系统管理员角色本身不增加业务权限</span></div></div><div className="orders-table-wrap"><table className="permission-matrix-table"><thead><tr><th>角色</th><th>数据范围</th><th>业务操作</th><th>目标职责</th><th>导出权限</th><th>明确禁止</th></tr></thead><tbody>{permissionMatrix.length===0?<tr><td colSpan={6} className="empty-cell">暂无角色权限定义</td></tr>:permissionMatrix.map((item)=><tr key={item.code}><td><strong>{item.name}</strong></td><td><span className={`scope-badge scope-${item.businessScope}`}>{scopeName(item.businessScope)}</span></td><td>{item.businessOperations.join("；")}</td><td>{item.targetResponsibilities}</td><td>{item.exportPermission}</td><td>{item.forbidden.join("；")}</td></tr>)}</tbody></table></div></section></>:null}{showCreate?<CreateAccount roles={roles} onClose={()=>setShowCreate(false)} onSaved={async()=>{setShowCreate(false);await load();}}/>:null}{temporaryCredential?<Modal title="临时密码已生成" note="该密码只显示一次，24 小时后失效" onClose={()=>setTemporaryCredential(null)}><div className="temporary-password-result"><p>账号：{temporaryCredential.username}</p><strong>{temporaryCredential.password}</strong><span>失效时间：{new Date(temporaryCredential.expiresAt).toLocaleString("zh-CN")}</span><div className="modal-actions"><button type="button" onClick={()=>setTemporaryCredential(null)}>我已安全保存</button></div></div></Modal>:null}</main>;
}

function scopeName(scope:RolePermission["businessScope"]):string{return{none:"无业务范围",self:"仅本人",group:"本人及所负责小组",department:"本人及所负责部门",all:"全公司 / 销售组织"}[scope];}

function CreateAccount({roles,onClose,onSaved}:{roles:Array<{code:string;name:string}>;onClose:()=>void;onSaved:()=>Promise<void>}){const[username,setUsername]=useState("");const[displayName,setDisplayName]=useState("");const[role,setRole]=useState(roles[0]?.code??"salesperson");const[personId,setPersonId]=useState("");const[people,setPeople]=useState<PersonOption[]>([]);const[error,setError]=useState("");const[created,setCreated]=useState<{temporaryPassword:string;temporaryPasswordExpiresAt:string}|null>(null);useEffect(()=>{fetch("/api/admin/people").then(async(response)=>{const data=await response.json() as {people?:PersonOption[];message?:string};if(!response.ok)throw new Error(data.message??"人员列表加载失败");setPeople((data.people??[]).filter((person)=>!person.username));}).catch((reason)=>setError(reason instanceof Error?reason.message:"人员列表加载失败"));},[]);async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/admin/users",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,displayName,roles:[role],personId:personId?Number(personId):null})});const data=await response.json() as {message?:string;temporaryPassword?:string;temporaryPasswordExpiresAt?:string};if(!response.ok||!data.temporaryPassword||!data.temporaryPasswordExpiresAt){setError(data.message??"创建失败");return;}setCreated({temporaryPassword:data.temporaryPassword,temporaryPasswordExpiresAt:data.temporaryPasswordExpiresAt});}return <Modal title="创建系统账号" note="可绑定已有人员身份；临时密码只显示一次，24 小时内必须完成首次改密" onClose={onClose}>{created?<div className="temporary-password-result"><p>请立即安全保存临时密码，关闭后无法再次查看。</p><strong>{created.temporaryPassword}</strong><span>失效时间：{new Date(created.temporaryPasswordExpiresAt).toLocaleString("zh-CN")}</span><div className="modal-actions"><button type="button" onClick={async()=>{await onSaved();}}>我已安全保存</button></div></div>:<form noValidate className="business-form" onSubmit={submit}><div className="form-grid"><Field label="登录账号" value={username} onChange={setUsername}/><Field label="账号显示姓名" value={displayName} onChange={setDisplayName}/><label className="field"><span>绑定已有人员（可选）</span><select value={personId} onChange={(event)=>setPersonId(event.target.value)}><option value="">新建人员身份</option>{people.map((person)=><option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><label className="field"><span>角色</span><select value={role} onChange={(event)=>setRole(event.target.value)}>{roles.map((item)=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label></div>{error?<p className="form-error">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">创建账号</button></div></form>}</Modal>}

function OrganizationPage({user}:{user:User}){const[units,setUnits]=useState<OrgUnit[]>([]);const[assignments,setAssignments]=useState<Assignment[]>([]);const[message,setMessage]=useState("");const[dialog,setDialog]=useState<"unit"|"assignment"|null>(null);const isAdmin=user.capabilities.manageOrganization;const load=useCallback(async()=>{const response=await fetch("/api/organization");const data=await response.json() as {units?:OrgUnit[];assignments?:Assignment[];message?:string};if(!response.ok)throw new Error(data.message??"组织架构加载失败");setUnits(data.units??[]);setAssignments(data.assignments??[]);},[]);useEffect(()=>{load().catch((error)=>setMessage(error instanceof Error?error.message:"组织架构加载失败"));},[load]);return <main className="dashboard"><header><div><h1>组织架构</h1><p>组织与人员任职按生效日期管理；业绩入账时固化组织快照</p></div>{isAdmin?<div className="header-actions"><button className="secondary-action" onClick={()=>setDialog("assignment")}>新增任职</button><button className="primary-action" onClick={()=>setDialog("unit")}><Plus size={16}/>新增组织</button></div>:null}</header>{message?<p className="page-message">{message}</p>:null}<section className="org-grid"><article className="orders-card"><div className="orders-toolbar"><div><h2>部门与小组</h2><span>{units.length} 个组织单元</span></div></div><div className="compact-list">{units.map((unit)=><div key={unit.id}><span>{unit.unitType==="department"?"部门":"小组"}</span><strong>{unit.name}</strong><small>{unit.parentName??"顶层"}</small></div>)}</div></article><article className="orders-card"><div className="orders-toolbar"><div><h2>人员任职</h2><span>{assignments.length} 条有效期记录</span></div></div><div className="compact-list">{assignments.length?assignments.map((item)=><div key={item.id}><span>{item.effectiveFrom}</span><strong>{item.displayName}</strong><small>{[item.departmentName,item.groupName].filter(Boolean).join(" / ")}</small></div>):<p className="empty-cell">暂无人员任职记录</p>}</div></article></section>{dialog==="unit"?<CreateOrgUnit units={units} onClose={()=>setDialog(null)} onSaved={async()=>{setDialog(null);await load();}}/>:null}{dialog==="assignment"?<CreateAssignment units={units} onClose={()=>setDialog(null)} onSaved={async()=>{setDialog(null);await load();}}/>:null}</main>}

function CreateOrgUnit({units,onClose,onSaved}:{units:OrgUnit[];onClose:()=>void;onSaved:()=>Promise<void>}){const[name,setName]=useState("");const[unitType,setUnitType]=useState<"department"|"group">("department");const[parentId,setParentId]=useState("");const[error,setError]=useState("");async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/admin/organization/units",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,unitType,parentId:parentId?Number(parentId):null})});const data=await response.json() as {message?:string};if(!response.ok){setError(data.message??"新增组织失败");return;}await onSaved();}return <Modal title="新增组织单元" note="小组必须归属于一个部门" onClose={onClose}><form noValidate className="business-form" onSubmit={submit}><Field label="名称" value={name} onChange={setName}/><label className="field"><span>类型</span><select value={unitType} onChange={(e)=>setUnitType(e.target.value as "department"|"group")}><option value="department">部门</option><option value="group">小组</option></select></label>{unitType==="group"?<label className="field"><span>所属部门</span><select required value={parentId} onChange={(e)=>setParentId(e.target.value)}><option value="">请选择</option>{units.filter((u)=>u.unitType==="department").map((u)=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>:null}{error?<p className="form-error">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">保存组织</button></div></form></Modal>}

function CreateAssignment({units,onClose,onSaved}:{units:OrgUnit[];onClose:()=>void;onSaved:()=>Promise<void>}){const[people,setPeople]=useState<PersonOption[]>([]);const[personId,setPersonId]=useState("");const[departmentId,setDepartmentId]=useState("");const[groupId,setGroupId]=useState("");const[leaderPersonId,setLeaderPersonId]=useState("");const[supervisorPersonId,setSupervisorPersonId]=useState("");const[effectiveFrom,setEffectiveFrom]=useState(businessDateToday);const[error,setError]=useState("");useEffect(()=>{fetch("/api/admin/people").then(async(response)=>{const data=await response.json() as {people?:PersonOption[];message?:string};if(!response.ok)throw new Error(data.message??"人员列表加载失败");setPeople(data.people??[]);}).catch((reason)=>setError(reason instanceof Error?reason.message:"人员列表加载失败"));},[]);async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/admin/organization/assignments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({personId:Number(personId),departmentId:Number(departmentId),groupId:Number(groupId),leaderPersonId:Number(leaderPersonId),supervisorPersonId:Number(supervisorPersonId),effectiveFrom,effectiveTo:null})});const data=await response.json() as {message?:string};if(!response.ok){setError(data.message??"任职保存失败");return;}await onSaved();}const personSelect=(label:string,value:string,onChange:(value:string)=>void)=><label className="field"><span>{label}</span><select required value={value} onChange={(event)=>onChange(event.target.value)}><option value="">请选择</option>{people.map((item)=><option key={item.id} value={item.id}>{item.displayName}{item.username?`（${item.username}）`:"（无登录账号）"}</option>)}</select></label>;return <Modal title="新增人员任职" note="成员归属与负责人职责均按生效日期保存；新任职不改写历史事件" onClose={onClose}><form noValidate className="business-form" onSubmit={submit}><div className="form-grid">{personSelect("任职人员",personId,setPersonId)}<Field label="生效日期" value={effectiveFrom} type="date" onChange={setEffectiveFrom}/><label className="field"><span>部门</span><select required value={departmentId} onChange={(event)=>{setDepartmentId(event.target.value);setGroupId("");}}><option value="">请选择</option>{units.filter((unit)=>unit.unitType==="department").map((unit)=><option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label><label className="field"><span>小组</span><select required value={groupId} onChange={(event)=>setGroupId(event.target.value)}><option value="">请选择</option>{units.filter((unit)=>unit.unitType==="group"&&unit.parentId===departmentId).map((unit)=><option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>{personSelect("小组负责人",leaderPersonId,setLeaderPersonId)}{personSelect("部门主管",supervisorPersonId,setSupervisorPersonId)}</div>{error?<p className="form-error">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">保存任职</button></div></form></Modal>}

function GoalsPage({ user, pendingOnly }: { user: User; pendingOnly: boolean }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState("");
  const [formalGoal, setFormalGoal] = useState<Goal | null>(null);
  const canCreate = user.roles.some((role) => ["sales_manager","sales_supervisor","sales_leader"].includes(role));
  const load = useCallback(async () => { const response=await fetch(pendingOnly?"/api/goals?pendingOnly=true":"/api/goals"); const data=await response.json() as {goals?:Goal[];message?:string}; if(!response.ok) throw new Error(data.message??"目标加载失败"); setGoals(data.goals??[]); },[pendingOnly]);
  useEffect(()=>{load().catch((error)=>setMessage(error instanceof Error?error.message:"目标加载失败"));},[load]);
  const visible = goals;
  async function action(goal: Goal, kind: "sign"|"approve"|"reject"|"request") {
    setMessage("");
    let url=`/api/goals/${goal.id}/decision`; let body: Record<string,unknown>={decision:kind==="reject"?"rejected":"approved",comment:"网页确认"};
    if(kind==="sign"){const signature=window.prompt("请输入签名姓名",user.displayName);if(!signature)return;url=`/api/goals/${goal.id}/sign`;body={signatureText:signature};}
    if(kind==="request"){const reason=window.prompt("请输入目标修改原因");if(!reason)return;url=`/api/goals/${goal.id}/change-requests`;body={reason};}
    const response=await apiFetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const data=await response.json() as {message?:string};if(!response.ok){setMessage(data.message??"操作失败");return;}await load();
  }
  const canExport=user.capabilities.exportGoals;
  return <main className="dashboard goals-page"><header><div><h1>{pendingOnly?"审批中心":"目标管理"}</h1><p>上级下达、责任人签名，最终由人事部审批后生效</p></div><div className="header-actions">{canExport?<button className="secondary-action" onClick={()=>{window.location.href="/api/exports/goals.csv"}}>导出目标</button>:null}{canCreate&&!pendingOnly?<button className="primary-action" onClick={()=>setShowCreate(true)}><Plus size={16}/>下达目标</button>:null}</div></header>{message?<p className="page-message">{message}</p>:null}<section className="orders-card"><div className="orders-toolbar"><div><h2>{pendingOnly?"待办目标":"目标责任台账"}</h2><span>{visible.length} 条记录</span></div></div><div className="orders-table-wrap"><table><thead><tr><th>月份</th><th>层级</th><th>责任人</th><th>目标</th><th>已下放</th><th>差额</th><th>状态</th><th>操作</th></tr></thead><tbody>{visible.length===0?<tr><td colSpan={8} className="empty-cell">暂无目标记录</td></tr>:visible.map((goal)=><tr key={goal.id}><td>{goal.periodMonth}</td><td>{goalLevelName(goal.level)}</td><td>{goal.ownerName}</td><td>{formatMoney(goal.amount)}</td><td>{formatMoney(goal.allocatedAmount)}</td><td className={Number(goal.allocatedAmount)>Number(goal.amount)?"warning":""}>{formatMoney(Number(goal.amount)-Number(goal.allocatedAmount))}</td><td><span className={`status goal-${goal.status}`}>{goalStatusName(goal.status)}</span></td><td><div className="row-actions">{goal.status==="active"?<button onClick={()=>setFormalGoal(goal)}>查看正式报表</button>:null}{goal.ownerUsername===user.username&&goal.status==="pending_signature"?<button onClick={()=>action(goal,"sign")}>确认签名</button>:null}{goal.ownerUsername===user.username&&goal.status!=="pending_signature"?<button onClick={()=>action(goal,"request")}>申请修改</button>:null}{goal.status==="pending_gm"&&user.roles.includes("general_manager")?<><button onClick={()=>action(goal,"approve")}>批准</button><button onClick={()=>action(goal,"reject")}>拒绝</button></>:null}{goal.status==="pending_hr"&&user.roles.includes("hr")?<><button onClick={()=>action(goal,"approve")}>批准</button><button onClick={()=>action(goal,"reject")}>拒绝</button></>:null}</div></td></tr>)}</tbody></table></div></section>{showCreate?<CreateGoal user={user} onClose={()=>setShowCreate(false)} onSaved={async()=>{setShowCreate(false);await load();}}/>:null}{formalGoal?<FormalReportDialog goal={formalGoal} onClose={()=>setFormalGoal(null)}/>:null}</main>;
}

function FormalReportDialog({goal,onClose}:{goal:Goal;onClose:()=>void}){
  const[report,setReport]=useState<FormalReport|null>(null);const[error,setError]=useState("");
  useEffect(()=>{fetch(`/api/performance/formal-reports/${goal.id}`).then(async(response)=>{const data=await response.json() as FormalReport&{message?:string};if(!response.ok)throw new Error(data.message??"正式报表加载失败");setReport(data);}).catch((reason)=>setError(reason instanceof Error?reason.message:"正式报表加载失败"));},[goal.id]);
  return <Modal title="正式业绩报表" note="目标已生效，达成率按该层级目标独立计算" onClose={onClose}>{error?<p className="form-error formal-report-content">{error}</p>:report?<div className="formal-report-content"><div><span>目标月份</span><strong>{report.periodMonth}</strong></div><div><span>责任层级</span><strong>{goalLevelName(report.level)}</strong></div><div><span>生效目标</span><strong>{formatMoney(report.targetAmount)}</strong></div><div><span>实际业绩</span><strong>{formatMoney(report.actualAmount)}</strong></div><div><span>达成率</span><strong>{report.achievementRate===null?"不计算":`${report.achievementRate}%`}</strong></div><div className="modal-actions"><button type="button" onClick={()=>{window.location.href=`/api/exports/formal-reports/${goal.id}.csv`;}}>导出正式报表</button></div></div>:<p className="formal-report-content">正在计算正式报表…</p>}</Modal>;
}

function CreateGoal({ user, onClose, onSaved }: { user: User; onClose:()=>void; onSaved:()=>Promise<void> }) {
  const available = user.roles.includes("sales_manager")?["sales_manager","department"]:user.roles.includes("sales_supervisor")?["group","personal"]:["personal"];
  const [periodMonth,setPeriodMonth]=useState("2026-09"); const [level,setLevel]=useState(available[0]!); const [ownerUsername,setOwnerUsername]=useState(level==="sales_manager"?user.username:""); const [amount,setAmount]=useState(""); const [parentGoalId,setParentGoalId]=useState(""); const [changeReason,setChangeReason]=useState("目标下达"); const [error,setError]=useState("");
  async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/goals",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({periodMonth,level,ownerUsername,parentGoalId:parentGoalId?Number(parentGoalId):null,amount:Number(amount),changeReason})});const data=await response.json() as {message?:string};if(!response.ok){setError(data.message??"目标下达失败");return;}await onSaved();}
  return <Modal title="下达目标" note="责任人签名后进入对应审批节点" onClose={onClose}><form noValidate className="business-form" onSubmit={submit}><div className="form-grid"><Field label="目标月份" value={periodMonth} type="month" onChange={setPeriodMonth}/><label className="field"><span>目标层级</span><select value={level} onChange={(event)=>{setLevel(event.target.value);if(event.target.value==="sales_manager")setOwnerUsername(user.username);}}>{available.map((item)=><option key={item} value={item}>{goalLevelName(item)}</option>)}</select></label><Field label="责任人账号" value={ownerUsername} onChange={setOwnerUsername}/><Field label="目标金额" value={amount} type="number" onChange={setAmount}/><Field label="上级目标 ID（顶层可空）" value={parentGoalId} type="number" onChange={setParentGoalId}/><Field label="下达 / 调整原因" value={changeReason} onChange={setChangeReason}/></div>{error?<p className="form-error">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">提交待确认</button></div></form></Modal>;
}

function Overview({ canEdit, canExport, onEnterOrders }: { canEdit: boolean; canExport: boolean; onEnterOrders: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  useEffect(() => { fetch("/api/performance/dashboard").then(async (response) => { if (!response.ok) throw new Error("总览加载失败"); setData(await response.json() as DashboardData); }).catch(() => setData(null)); }, []);
  const maxGroup = Math.max(1, ...(data?.groups.map((group) => Number(group.total)) ?? [1]));
  return <main className="dashboard"><header><div><h1>业绩账本总览</h1><p>{data ? `${data.month.replace("-", " 年 ")} 月 · 原始账本，不代表正式绩效结果` : "正在加载真实业绩账本…"}</p></div><div className="header-actions">{canExport?<button className="secondary-action" onClick={()=>{window.location.href="/api/exports/performance.csv"}}>导出业绩流水</button>:null}{canEdit?<button className="primary-action" onClick={onEnterOrders}>录入订单业绩</button>:null}</div></header><section className="metric-band"><Metric label="当月入账" value={data ? formatMoney(data.metrics.total) : "—"} note={`${data?.metrics.eventCount ?? 0} 条业绩事件`}/><Metric label="正式报表" value="从生效目标进入" note="未生效不计算达成率"/><Metric label="待处理审批" value={String(data?.metrics.pendingApprovals ?? 0)} note="目标确认与变更" warning/><Metric label="负向调整" value={data ? formatMoney(data.metrics.negativeTotal) : "—"} note="暂停与金额变更" negative/></section>
      <section className="dashboard-grid"><article className="trend-panel"><PanelTitle title="月度业绩趋势" note="2026 年 1—8 月正式入账金额"/><TrendChart values={data?.monthly.map((item) => Number(item.total)) ?? []}/></article><article className="ranking-panel"><PanelTitle title="小组业绩" note="按事件发生时组织归属"/>{data?.groups.map((group,i) => <div className="rank-row" key={group.name}><span>{i+1}</span><div><strong>{group.name}</strong><span><i style={{width:`${Math.max(0, Number(group.total)) / maxGroup * 100}%`}}/></span></div><b>{(Number(group.total)/10000).toFixed(1)}万</b></div>)}</article></section>
      <section className="events-panel"><div className="panel-title"><div><h2>最近业绩事件</h2><p>入账后不可覆盖或删除</p></div><button onClick={onEnterOrders}>查看全部</button></div><table><thead><tr><th>订单编号</th><th>业务员</th><th>事件类型</th><th>记账月</th><th>金额</th><th>组织归属</th><th>状态</th></tr></thead><tbody>{data?.recent.map((event) => <tr key={`${event.orderNo}-${event.month}-${event.amount}`}><td>{event.orderNo}</td><td>{event.salespersonName}</td><td>{eventTypeName(event.eventType)}</td><td>{event.month}</td><td className={Number(event.amount)<0?"negative":""}>{formatMoney(event.amount)}</td><td>{event.groupName}</td><td>已入账</td></tr>)}</tbody></table></section>
    </main>;
}

function OrdersPage({ user }: { user: User }) {
  const canEdit=user.capabilities.editPerformance;
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState("");
  const initialSearch = new URLSearchParams(window.location.search).get("orderSearch") ?? "";
  const [search, setSearch] = useState(initialSearch);
  const [committedSearch, setCommittedSearch] = useState(initialSearch);
  const [isComposing, setIsComposing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const commitSearch = useCallback((value:string, historyMode:"push"|"replace"="push") => {
    const normalized=value.trim();
    const params=new URLSearchParams(window.location.search);
    if(normalized)params.set("orderSearch",normalized);else params.delete("orderSearch");
    const next=`${window.location.pathname}${params.size?`?${params.toString()}`:""}${window.location.hash}`;
    window.history[historyMode==="push"?"pushState":"replaceState"]({},"",next);
    setCommittedSearch(normalized);
  },[]);
  useEffect(()=>{
    const restore=()=>{const value=new URLSearchParams(window.location.search).get("orderSearch")??"";setSearch(value);setCommittedSearch(value);};
    window.addEventListener("popstate",restore);return()=>window.removeEventListener("popstate",restore);
  },[]);
  useEffect(()=>{
    if(isComposing||search.trim()===committedSearch)return;
    const timer=window.setTimeout(()=>commitSearch(search),300);
    return()=>window.clearTimeout(timer);
  },[search,isComposing,committedSearch,commitSearch]);
  useEffect(() => {
    const controller=new AbortController();setLoading(true);setMessage("");
    const params=new URLSearchParams({limit:"100"});if(committedSearch)params.set("search",committedSearch);
    fetch(`/api/performance/orders?${params.toString()}`,{signal:controller.signal}).then(async(response)=>{
      const data=await response.json() as {orders?:Order[];message?:string};
      if(!response.ok)throw new Error(data.message??"订单加载失败");
      setOrders(data.orders??[]);
    }).catch((error)=>{if(error instanceof DOMException&&error.name==="AbortError")return;setMessage(error instanceof Error?error.message:"订单加载失败");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  }, [committedSearch,refreshVersion]);
  async function refresh() { setRefreshVersion((value)=>value+1); }
  function clearSearch(){setSearch("");commitSearch("");window.requestAnimationFrame(()=>searchRef.current?.focus());}
  return <main className="dashboard orders-page"><header><div><h1>订单业绩</h1><p>按订单编号维护不可变业绩事件；已入账记录不能覆盖或删除</p></div>{canEdit ? <button className="primary-action" onClick={() => setShowCreate(true)}><Plus size={16}/>录入新订单</button> : null}</header>
    {message ? <p className="page-message" role="status">{message}</p> : null}
    {!canEdit ? <div className="permission-note"><ShieldCheck size={18}/>当前角色仅可查看。只有销售助理及销售助理组长可以录入或调整业绩。</div> : null}
    <LedgerGovernancePanel user={user} orders={orders} onChanged={refresh}/>
    <section className="orders-card" aria-labelledby="orders-table-title"><div className="orders-toolbar"><div><h2 id="orders-table-title">订单台账</h2><span role="status">{loading?"正在查询…":`${orders.length} 笔订单`}</span></div><button className="icon-action" onClick={() => refresh()} aria-label="刷新订单"><RefreshCw size={17}/></button></div>
      <form className="order-search" role="search" noValidate onSubmit={(event)=>{event.preventDefault();if(!isComposing)commitSearch(search);}}><label htmlFor="order-search-input">定位订单</label><div><Search size={17} aria-hidden="true"/><input ref={searchRef} id="order-search-input" type="search" value={search} placeholder="输入订单编号、客户或业务员" onChange={(event)=>setSearch(event.target.value)} onCompositionStart={()=>setIsComposing(true)} onCompositionEnd={(event)=>{setIsComposing(false);setSearch(event.currentTarget.value);}}/>{search?<button type="button" onClick={clearSearch} aria-label="清除订单搜索"><X size={16}/></button>:null}</div><button type="submit">搜索</button></form>
      <div className="orders-table-wrap"><table><thead><tr><th scope="col">订单编号</th><th scope="col">客户</th><th scope="col">业务员</th><th scope="col">当前营业额</th><th scope="col">计入业绩</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>{!loading&&orders.length === 0 ? <tr><td colSpan={7} className="empty-cell">{committedSearch?`没有找到与“${committedSearch}”匹配的订单。`:"暂无订单，请录入第一笔业绩。"}</td></tr> : orders.map((order) => <tr key={order.id}><td>{order.orderNo}</td><td>{order.customerName}</td><td>{order.salespersonName}</td><td>{formatMoney(order.currentRevenue)}</td><td>{formatMoney(order.countedAmount)}</td><td><Status state={order.lifecycleState}/></td><td><button className="table-action" onClick={() => setSelected(order)}>查看 / 调整</button></td></tr>)}</tbody></table></div>
    </section>
    {showCreate ? <CreateOrder onClose={() => setShowCreate(false)} onSaved={async () => { setShowCreate(false); await refresh(); }} /> : null}
    {selected ? <AdjustOrder order={selected} canEdit={canEdit} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await refresh(); }} /> : null}
  </main>;
}

const initialOrder = { orderNo: "", customerName: "", customerUnit: "", salespersonPersonId: "", serviceType: "", sourceReceivedOn: businessDateToday(), amount: "", reason: "首次录入" };

function previousBusinessMonth():string{const [year,month]=businessDateToday().slice(0,7).split("-").map(Number);return new Date(Date.UTC(year!,month!-2,1)).toISOString().slice(0,7);}

function LedgerGovernancePanel({user,orders,onChanged}:{user:User;orders:Order[];onChanged:()=>Promise<void>}){
  const isLeader=user.roles.includes("sales_assistant_leader");
  const isHr=user.roles.includes("hr");
  const[periods,setPeriods]=useState<AccountingPeriod[]>([]);
  const[corrections,setCorrections]=useState<AccountingCorrection[]>([]);
  const[reviews,setReviews]=useState<HistoricalReview[]>([]);
  const[month,setMonth]=useState(previousBusinessMonth());
  const[periodNote,setPeriodNote]=useState("");
  const[decisionNote,setDecisionNote]=useState("");
  const[message,setMessage]=useState("");
  const[busy,setBusy]=useState(false);
  const[correction,setCorrection]=useState({orderId:"",eventType:"revenue_change",occurredOn:`${previousBusinessMonth()}-01`,reason:""});
  const[review,setReview]=useState({orderId:"",lifecycleState:"active",currentRevenue:"",conclusion:"",evidence:"",reason:""});
  const[execution,setExecution]=useState<AccountingCorrection|null>(null);
  const[executionAmount,setExecutionAmount]=useState("");
  const[executionReason,setExecutionReason]=useState("");
  const load=useCallback(async()=>{
    if(!isLeader&&!isHr)return;
    const responses=await Promise.all([fetch("/api/accounting-periods"),fetch("/api/accounting-corrections"),fetch("/api/historical-order-reviews")]);
    const data=await Promise.all(responses.map((response)=>response.json()));
    const failed=responses.findIndex((response)=>!response.ok);
    if(failed>=0)throw new Error((data[failed] as {message?:string}).message??"账本治理数据加载失败");
    setPeriods((data[0] as {periods:AccountingPeriod[]}).periods??[]);
    setCorrections((data[1] as {corrections:AccountingCorrection[]}).corrections??[]);
    setReviews((data[2] as {reviews:HistoricalReview[]}).reviews??[]);
  },[isHr,isLeader]);
  useEffect(()=>{load().catch((error)=>setMessage(error instanceof Error?error.message:"账本治理数据加载失败"));},[load]);
  useEffect(()=>{if(orders[0]){setCorrection((current)=>current.orderId?current:{...current,orderId:orders[0]!.id});setReview((current)=>current.orderId?current:{...current,orderId:orders[0]!.id});}},[orders]);
  if(!isLeader&&!isHr)return null;
  async function post(url:string,payload:unknown){
    setBusy(true);setMessage("");
    try{const response=await apiFetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});const data=await response.json() as {message?:string};if(!response.ok)throw new Error(data.message??"操作失败");await load();await onChanged();setMessage("操作已记录并刷新。");return true;}
    catch(error){setMessage(error instanceof Error?error.message:"操作失败");return false;}
    finally{setBusy(false);}
  }
  async function submitCorrection(event:FormEvent){event.preventDefault();const ok=await post("/api/accounting-corrections",{periodMonth:month,orderId:Number(correction.orderId),eventType:correction.eventType,occurredOn:correction.occurredOn,reason:correction.reason});if(ok)setCorrection((current)=>({...current,reason:""}));}
  async function submitReview(event:FormEvent){event.preventDefault();const ok=await post("/api/historical-order-reviews",{orderId:Number(review.orderId),lifecycleState:review.lifecycleState,currentRevenue:Number(review.currentRevenue),conclusion:review.conclusion,evidence:review.evidence,reason:review.reason});if(ok)setReview((current)=>({...current,currentRevenue:"",conclusion:"",evidence:"",reason:""}));}
  async function executeCorrection(event:FormEvent){event.preventDefault();if(!execution)return;const payload={type:execution.eventType,reason:executionReason,idempotencyKey:crypto.randomUUID(),correctionRequestId:Number(execution.id),...(execution.eventType==="revenue_change"?{newAmount:Number(executionAmount)}:{}),...(execution.eventType==="first_include"?{amount:Number(executionAmount)}:{})};const ok=await post(`/api/performance/orders/${execution.orderId}/events`,payload);if(ok){setExecution(null);setExecutionAmount("");setExecutionReason("");}}
  const reviewableOrders=orders.filter((order)=>order.lifecycleState==="historical_review_required");
  return <section className="governance-card" aria-labelledby="ledger-governance-title"><div className="orders-toolbar"><div><h2 id="ledger-governance-title">记账治理工作台</h2><span>关账、更正与历史核对均保留职责分离和审计</span></div><button className="icon-action" onClick={()=>load().catch((error)=>setMessage(error instanceof Error?error.message:"刷新失败"))} aria-label="刷新记账治理"><RefreshCw size={17}/></button></div>
    {message?<p className="page-message" role="status">{message}</p>:null}
    <div className="governance-grid"><form noValidate onSubmit={(event)=>event.preventDefault()}><h3>{isLeader&&isHr?"期间核对与关账":isHr?"人事关账":"组长核对确认"}</h3><label className="field"><span>记账月份</span><input type="month" value={month} onChange={(event)=>{setMonth(event.target.value);setCorrection((current)=>({...current,occurredOn:`${event.target.value}-01`}));}}/></label><Field label={isLeader&&isHr?"核对或关账说明":isHr?"关账说明":"核对说明"} value={periodNote} onChange={setPeriodNote}/>{isLeader?<button type="button" disabled={busy} onClick={()=>post(`/api/accounting-periods/${month}/confirm-close`,{note:periodNote})}>提交核对确认</button>:null}{isHr?<button type="button" disabled={busy} onClick={()=>post(`/api/accounting-periods/${month}/close`,{note:periodNote})}>关闭记账期间</button>:null}</form>
      {isLeader?<form noValidate onSubmit={submitCorrection}><h3>申请关闭月更正</h3><OrderSelect orders={orders} value={correction.orderId} onChange={(orderId)=>setCorrection((current)=>({...current,orderId}))}/><label className="field"><span>更正类型</span><select value={correction.eventType} onChange={(event)=>setCorrection((current)=>({...current,eventType:event.target.value}))}><option value="revenue_change">营业额修改</option><option value="pause">整单暂停</option><option value="restart">订单重启</option><option value="first_include">首次计入</option></select></label><Field label="原业务日期" type="date" value={correction.occurredOn} onChange={(occurredOn)=>setCorrection((current)=>({...current,occurredOn}))}/><Field label="申请原因" value={correction.reason} onChange={(reason)=>setCorrection((current)=>({...current,reason}))}/><button type="submit" disabled={busy}>提交更正申请</button></form>:null}
      {isLeader?<form noValidate onSubmit={submitReview}><h3>提交历史订单核对</h3><OrderSelect orders={reviewableOrders} value={review.orderId} onChange={(orderId)=>setReview((current)=>({...current,orderId}))}/><label className="field"><span>核对后状态</span><select value={review.lifecycleState} onChange={(event)=>setReview((current)=>({...current,lifecycleState:event.target.value}))}><option value="active">正向计入</option><option value="paused">已暂停</option><option value="zero">零金额</option></select></label><Field label="核对后当前营业额" type="number" value={review.currentRevenue} onChange={(currentRevenue)=>setReview((current)=>({...current,currentRevenue}))}/><Field label="核对结论" value={review.conclusion} onChange={(conclusion)=>setReview((current)=>({...current,conclusion}))}/><Field label="核对依据" value={review.evidence} onChange={(evidence)=>setReview((current)=>({...current,evidence}))}/><Field label="核对原因" value={review.reason} onChange={(reason)=>setReview((current)=>({...current,reason}))}/><button type="submit" disabled={busy||!reviewableOrders.length}>提交人事审批</button></form>:null}</div>
    {isHr?<label className="field governance-decision"><span>审批意见</span><input value={decisionNote} onChange={(event)=>setDecisionNote(event.target.value)} placeholder="批准、驳回或撤销前填写"/></label>:null}
    <div className="governance-lists"><div><h3>记账期间</h3>{periods.length?<ul>{periods.map((period)=><li key={period.periodMonth}><strong>{period.periodMonth.slice(0,7)}</strong><span>{period.status==="closed"?`已关闭 · 版本 ${period.version}`:"开放"}{period.needsReclose?" · 待重新关账":""}</span></li>)}</ul>:<p>尚无期间治理记录。</p>}</div><div><h3>更正申请</h3>{corrections.length?<ul>{corrections.map((item)=><li key={item.id}><strong>{item.orderNo} · {eventTypeName(item.eventType)}</strong><span>{item.periodMonth.slice(0,7)} · {item.status} · 申请人 {item.requestedBy}</span><div className="row-actions">{isHr&&item.status==="pending"?<><button onClick={()=>post(`/api/accounting-corrections/${item.id}/approve`,{note:decisionNote})}>批准</button><button onClick={()=>post(`/api/accounting-corrections/${item.id}/reject`,{note:decisionNote})}>驳回</button></>:null}{isHr&&item.status==="approved"?<button onClick={()=>post(`/api/accounting-corrections/${item.id}/revoke`,{note:decisionNote})}>撤销</button>:null}{isLeader&&item.status==="approved"?<button onClick={()=>setExecution(item)}>执行更正</button>:null}</div></li>)}</ul>:<p>暂无更正申请。</p>}</div><div><h3>历史核对</h3>{reviews.length?<ul>{reviews.map((item)=><li key={item.id}><strong>{item.orderNo} · {item.conclusion}</strong><span>{item.status} · 核对人 {item.requestedBy} · 依据 {item.evidence}</span>{isHr&&item.status==="pending"?<div className="row-actions"><button onClick={()=>post(`/api/historical-order-reviews/${item.id}/approve`,{note:decisionNote})}>批准并解析</button><button onClick={()=>post(`/api/historical-order-reviews/${item.id}/reject`,{note:decisionNote})}>驳回</button></div>:null}</li>)}</ul>:<p>暂无历史核对记录。</p>}</div></div>
    {execution?<Modal title={`执行更正 · ${execution.orderNo}`} note={`获批范围：${execution.periodMonth.slice(0,7)} / ${eventTypeName(execution.eventType)}`} onClose={()=>setExecution(null)}><form noValidate className="business-form" onSubmit={executeCorrection}>{["revenue_change","first_include"].includes(execution.eventType)?<Field label={execution.eventType==="revenue_change"?"调整后营业额":"首次计入金额"} type="number" value={executionAmount} onChange={setExecutionAmount}/>:null}<Field label="执行原因" value={executionReason} onChange={setExecutionReason}/><div className="modal-actions"><button type="button" onClick={()=>setExecution(null)}>取消</button><button type="submit" disabled={busy}>确认追加更正事件</button></div></form></Modal>:null}
  </section>;
}

function OrderSelect({orders,value,onChange}:{orders:Order[];value:string;onChange:(value:string)=>void}){return <label className="field"><span>订单</span><select aria-label="订单" value={orders.some((order)=>order.id===value)?value:""} onChange={(event)=>onChange(event.target.value)}><option value="">请选择当前列表中的订单</option>{orders.map((order)=><option key={order.id} value={order.id}>{order.orderNo} · {order.customerName}</option>)}</select></label>;}

function CreateOrder({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(initialOrder);
  const [people, setPeople] = useState<Array<{ id:string; displayName:string }>>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { fetch("/api/performance/people").then(async (response) => {
    const data = await response.json() as { people?:Array<{ id:string; displayName:string }>; message?:string };
    if (!response.ok) throw new Error(data.message ?? "业务员列表加载失败");
    setPeople(data.people ?? []);
  }).catch((reason) => setError(reason instanceof Error ? reason.message : "业务员列表加载失败")); }, []);
  function set(name: keyof typeof form, value: string) { setForm((current) => ({ ...current, [name]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await apiFetch("/api/performance/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, salespersonPersonId: Number(form.salespersonPersonId), amount: Number(form.amount) }) });
      const data = await response.json() as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "订单入账失败");
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "订单入账失败"); }
    finally { setSaving(false); }
  }
  return <Modal title="录入订单业绩" note="组织归属按业务员和收到日期自动解析并固化，后续只能追加更正事件" onClose={onClose}><form noValidate className="business-form" onSubmit={submit}><div className="form-grid"><Field label="订单编号" value={form.orderNo} onChange={(v) => set("orderNo",v)}/><Field label="收到日期" value={form.sourceReceivedOn} type="date" onChange={(v) => set("sourceReceivedOn",v)}/><Field label="客户名称" value={form.customerName} onChange={(v) => set("customerName",v)}/><Field label="客户单位" value={form.customerUnit} onChange={(v) => set("customerUnit",v)}/><label className="field"><span>业务员</span><select required value={form.salespersonPersonId} onChange={(event) => set("salespersonPersonId",event.target.value)}><option value="">请选择</option>{people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><Field label="服务类型" value={form.serviceType} onChange={(v) => set("serviceType",v)}/><Field label="营业额" value={form.amount} type="number" onChange={(v) => set("amount",v)}/><Field label="入账原因" value={form.reason} onChange={(v) => set("reason",v)}/></div>{error ? <p className="form-error">{error}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit" disabled={saving}>{saving ? "正在入账…" : "确认入账"}</button></div></form></Modal>;
}

function AdjustOrder({ order, canEdit, onClose, onSaved }: { order: Order; canEdit: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [events,setEvents]=useState<PerformanceEvent[]>([]);
  const [allowed,setAllowed]=useState<string[]>([]);
  const [lifecycle,setLifecycle]=useState<OrderLifecycle>(order.lifecycleState);
  const [loading,setLoading]=useState(true);
  const [type, setType] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving,setSaving]=useState(false);
  const idempotencyKey=useRef(crypto.randomUUID());
  useEffect(()=>{
    const controller=new AbortController();
    fetch(`/api/performance/orders/${order.id}/events`,{signal:controller.signal}).then(async(response)=>{
      const data=await response.json() as {events?:PerformanceEvent[];lifecycleState?:OrderLifecycle;allowedActions?:string[];message?:string};
      if(!response.ok)throw new Error(data.message??"事件链加载失败");
      const nextAllowed=data.allowedActions??[];setEvents(data.events??[]);setLifecycle(data.lifecycleState??order.lifecycleState);setAllowed(nextAllowed);setType((current)=>nextAllowed.includes(current)?current:(nextAllowed[0]??""));
    }).catch((failure)=>{if(failure instanceof DOMException&&failure.name==="AbortError")return;setError(failure instanceof Error?failure.message:"事件链加载失败");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[order.id,order.lifecycleState]);
  async function submit(event: FormEvent) {
    event.preventDefault();if(saving)return;setSaving(true);setError("");
    const payload = { type, reason, idempotencyKey:idempotencyKey.current, ...(type === "revenue_change" ? { newAmount: Number(amount) } : {}), ...(type === "first_include" ? { amount: Number(amount) } : {}) };
    try{
      const response = await apiFetch(`/api/performance/orders/${order.id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json() as { message?: string };
      if (!response.ok) { setError(data.message ?? "调整入账失败"); return; }
      await onSaved();
    }finally{setSaving(false);}
  }
  return <Modal title={order.orderNo} note={`${order.customerName} · 当前营业额 ${formatMoney(order.currentRevenue)} · 计入 ${formatMoney(order.countedAmount)}`} onClose={onClose}><section className="event-ledger" aria-labelledby="event-ledger-title"><div className="event-ledger-heading"><div><h3 id="event-ledger-title">不可变事件链</h3><p>{loading?"正在读取事件…":`${events.length} 条事件 · 按服务端账本序号排列`}</p></div><Status state={lifecycle}/></div>{!loading&&events.length?<ol>{events.map((item)=><li key={item.id}><span className="event-sequence" aria-label={`第 ${item.sequence} 条事件`}>{item.sequence}</span><div className="event-content"><div className="event-summary"><strong>{eventTypeName(item.eventType)}</strong><b className={Number(item.deltaAmount)<0?"negative":""}>{Number(item.deltaAmount)>0?"+":""}{formatMoney(item.deltaAmount)}</b>{item.resultingLifecycleState?<Status state={item.resultingLifecycleState}/>:<span className="legacy-semantic-note">原始状态未推断</span>}</div><dl><div><dt>业务日 / 记账月</dt><dd>{item.occurredOn} / {item.accountingMonth.slice(0,7)}</dd></div><div><dt>操作时间</dt><dd>{formatOperationTime(item.occurredAt)}</dd></div><div><dt>投影结果</dt><dd>营业额 {formatMoney(item.resultingCurrentRevenue)} · 计入 {formatMoney(item.resultingCountedAmount)}</dd></div><div><dt>原因 / 操作者</dt><dd>{item.reason||"—"} / {item.actorName||"历史导入"}</dd></div><div><dt>组织快照</dt><dd>{[item.departmentName,item.groupName].filter(Boolean).join(" / ")||"—"} · 组长 {item.leaderName||"—"} · 主管 {item.supervisorName||"—"}</dd></div></dl></div></li>)}</ol>:!loading&&!error?<p className="event-empty">没有可显示的事件。</p>:null}</section>{error ? <p className="form-error event-error" role="alert">{error}</p> : null}{!loading&&canEdit && allowed.length ? <form noValidate className="business-form event-form" onSubmit={submit}><div className="event-options">{allowed.includes("revenue_change") ? <button type="button" className={type==="revenue_change"?"selected":""} onClick={() => setType("revenue_change")}><RefreshCw size={17}/>修改营业额</button> : null}{allowed.includes("pause") ? <button type="button" className={type==="pause"?"selected":""} onClick={() => setType("pause")}><PauseCircle size={17}/>整单暂停</button> : null}{allowed.includes("restart") ? <button type="button" className={type==="restart"?"selected":""} onClick={() => setType("restart")}><PlayCircle size={17}/>订单重启</button> : null}{allowed.includes("first_include") ? <button type="button" className={type==="first_include"?"selected":""} onClick={() => setType("first_include")}><Plus size={17}/>首次计入</button> : null}</div><p className="form-note">操作时间和记账月由服务器确定，组织快照按该业务日的有效任职自动解析。</p><div className="form-grid">{type === "revenue_change" || type === "first_include" ? <Field label={type === "revenue_change" ? "调整后营业额" : "首次计入金额"} value={amount} type="number" onChange={setAmount}/> : null}<Field label="原因（必填）" value={reason} onChange={setReason}/></div><div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit" disabled={saving} aria-busy={saving}>{saving?"正在追加…":"确认追加事件"}</button></div></form> : !loading?<div className="permission-note">{lifecycle==="historical_review_required"?"该历史订单需要先完成核对与人事批准，当前不能追加事件。":"当前订单状态没有可执行操作，或当前角色仅可查看。"}</div>:null}</Modal>;
}

function Field({ label, value, onChange, type="text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) { return <label className="field"><span>{label}</span><input required value={value} type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.01" : undefined} onChange={(event) => onChange(event.target.value)}/></label>; }
function Modal({ title, note, onClose, children }: { title: string; note: string; onClose: () => void; children: ReactNode }) { const titleId=useId();const noteId=useId();const dialogRef=useRef<HTMLElement>(null);const closeRef=useRef(onClose);closeRef.current=onClose;useEffect(()=>{const prior=document.activeElement instanceof HTMLElement?document.activeElement:null;const root=document.getElementById("root");const priorOverflow=document.body.style.overflow;root?.setAttribute("inert","");root?.setAttribute("aria-hidden","true");document.body.style.overflow="hidden";const dialog=dialogRef.current;dialog?.focus();function keydown(event:KeyboardEvent){if(event.key==="Escape"){event.preventDefault();closeRef.current();return;}if(event.key!=="Tab"||!dialog)return;const controls=[...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')].filter((item)=>!item.hasAttribute("hidden"));if(!controls.length){event.preventDefault();dialog.focus();return;}const first=controls[0]!;const last=controls.at(-1)!;if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}document.addEventListener("keydown",keydown);return()=>{document.removeEventListener("keydown",keydown);root?.removeAttribute("inert");root?.removeAttribute("aria-hidden");document.body.style.overflow=priorOverflow;prior?.focus();};},[]);return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={noteId}><header><div><h2 id={titleId}>{title}</h2><p id={noteId}>{note}</p></div><button onClick={onClose} aria-label="关闭">×</button></header>{children}</section></div>,document.body); }
function Status({ state }: { state: OrderLifecycle }) { const names:Record<OrderLifecycle,string> = { draft:"草稿", active:"正向计入", paused:"已暂停", zero:"零金额",historical_review_required:"待历史核对" }; return <span className={`status status-${state}`}>{names[state]}</span>; }
function formatMoney(value: string | number) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(Number(value)); }
function formatOperationTime(value:string){return new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(value));}
function eventTypeName(type: string) { return ({ initial:"首次录入", revenue_change:"营业额修改", pause:"整单暂停", restart:"订单重启", first_include:"首次计入", legacy_adjustment:"历史迁移",historical_review_resolution:"历史核对解析" } as Record<string,string>)[type] ?? type; }
function goalLevelName(level: string) { return ({ sales_manager:"销售经理总目标", department:"部门目标", group:"小组目标", personal:"个人目标" } as Record<string,string>)[level] ?? level; }
function goalStatusName(status: string) { return ({ draft:"草稿", pending_signature:"待责任人签名", pending_gm:"待总经理审批", pending_hr:"待人事审批", active:"已生效", rejected:"已拒绝", superseded:"已替代" } as Record<string,string>)[status] ?? status; }

function PanelTitle({ title, note }: { title: string; note: string }) { return <div className="panel-title"><div><h2>{title}</h2><p>{note}</p></div></div>; }
function Metric({label,value,note,warning,negative}:{label:string;value:string;note:string;warning?:boolean;negative?:boolean}) { return <div className="metric"><span>{label}</span><strong className={negative?"negative":""}>{value}</strong><small className={warning?"warning":""}>{note}</small></div>; }
function TrendChart({ values = [0,0,0,0,0,0,0,0] }: { values?: number[] }) { const filled=Array.from({length:8},(_,i)=>values[i]??0); const max=Math.max(1,...filled); const points=filled.map((v,i)=>`${44+i*74},${190-(v/max)*150}`).join(" "); return <div className="chart"><svg viewBox="0 0 590 220" role="img" aria-label="1月至8月业绩折线图"><g className="grid-lines">{[40,90,140,190].map((y)=><line key={y} x1="42" y1={y} x2="570" y2={y}/>)}</g><polyline points={points} fill="none" stroke="#2f6fed" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>{filled.map((v,i)=><circle key={i} cx={44+i*74} cy={190-(v/max)*150} r="5" fill="#fff" stroke="#2f6fed" strokeWidth="3"/>)}</svg><div className="chart-labels">{["1月","2月","3月","4月","5月","6月","7月","8月"].map((m)=><span key={m}>{m}</span>)}</div></div>; }
