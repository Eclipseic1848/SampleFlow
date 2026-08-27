import { FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { Activity, BarChart3, ChevronRight, ClipboardCheck, Database, FileClock, LogOut, Network, PauseCircle, PlayCircle, Plus, RefreshCw, ShieldCheck, Target, UsersRound } from "lucide-react";

type User = { id: string; username: string; displayName: string; mustChangePassword: boolean; roles: string[] };
type AuthState = { status: "loading" } | { status: "guest" } | { status: "authenticated"; user: User };
type Order = { id: string; orderNo: string; customerName: string; customerUnit: string; salespersonName: string; serviceType: string | null; sourceReceivedOn: string; originalAmount: string; currentRevenue: string; countedAmount: string; lifecycleState: "draft" | "active" | "paused" | "zero"; postedAt: string; departmentName:string; groupName:string; leaderName:string|null; supervisorName:string|null };
type DashboardData = { month: string; metrics: { total: string; eventCount: number; negativeTotal: string; pendingApprovals: number }; monthly: Array<{ month: string; total: string }>; groups: Array<{ name: string; total: string }>; recent: Array<{ orderNo: string; salespersonName: string; eventType: string; month: string; amount: string; groupName: string }> };
type Goal = { id: string; periodMonth: string; level: "sales_manager"|"department"|"group"|"personal"; ownerUsername: string; ownerName: string; parentGoalId: string|null; versionId: string; versionNo: string; amount: string; status: string; signatureText: string|null; signedAt: string|null; changeReason: string; allocatedAmount: string };
type AdminUser = { id:string; username:string; displayName:string; isActive:boolean; mustChangePassword:boolean; roles:string[] };
type OrgUnit = { id:string; name:string; unitType:"department"|"group"; parentId:string|null; parentName:string|null; isActive:boolean };
type Assignment = { id:string; username:string; displayName:string; departmentName:string|null; groupName:string|null; effectiveFrom:string; effectiveTo:string|null };
const roleNames: Record<string, string> = { system_admin: "系统管理员", sales_assistant: "销售助理", sales_assistant_leader: "销售助理组长", sales_manager: "销售经理", sales_supervisor: "业务主管", sales_leader: "业务员组长", salesperson: "业务员", hr: "人事部", general_manager: "总经理" };

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
  return <main className="password-shell"><section className="login-card"><div className="login-heading"><p>首次登录安全设置</p><h2>请修改初始密码</h2><span>6—128 位，并包含英文字母、数字和符号</span></div><form onSubmit={submit}><label htmlFor="current-password">当前密码</label><input id="current-password" type="password" value={currentPassword} onChange={(e)=>setCurrentPassword(e.target.value)} autoComplete="current-password"/><label htmlFor="new-password">新密码</label><input id="new-password" type="password" value={newPassword} onChange={(e)=>setNewPassword(e.target.value)} autoComplete="new-password"/><p className="password-strength" aria-live="polite">密码强度：{passwordStrength(newPassword)}</p><button type="submit">保存新密码</button>{message?<p className="form-error">{message}</p>:null}</form></section></main>;
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
    <section className="login-panel"><div className="login-card"><div className="login-heading"><p>销售到样业绩管理</p><h2>登录系统</h2><span>开发环境已预填销售助理演示账号</span></div><form onSubmit={submit}><label htmlFor="username">账号</label><input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /><label htmlFor="password">密码</label><input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" /><button type="submit" disabled={submitting}>{submitting ? "正在登录…" : "进入 SampleFlow"}<ChevronRight size={18} /></button>{message ? <p className="form-error" role="alert">{message}</p> : null}</form><div className="readiness readiness-ready"><span />前端、API 与数据库已连接</div></div></section>
  </main>;
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [active, setActive] = useState(0);
  async function logout() { await apiFetch("/api/auth/logout", { method: "POST" }); onLogout(); }
  const nav = [[BarChart3,"业绩总览"],[Target,"目标管理"],[ClipboardCheck,"订单业绩"],[Network,"组织架构"],[FileClock,"审批中心"],[UsersRound,"账号管理"]] as const;
  const canEditPerformance = user.roles.some((role) => role === "sales_assistant" || role === "sales_assistant_leader");
  const canExport = user.roles.some((role) => role === "hr" || role === "general_manager");
  const content = active === 2
    ? <OrdersPage canEdit={canEditPerformance} />
    : active === 1
      ? <GoalsPage user={user} pendingOnly={false} />
      : active === 4
        ? <GoalsPage user={user} pendingOnly />
      : active === 3
        ? <OrganizationPage user={user}/>
      : active === 5
        ? <AccountsPage user={user}/>
    : active === 0
      ? <Overview canEdit={canEditPerformance} canExport={canExport} onEnterOrders={() => setActive(2)} />
      : <Placeholder title={nav[active]![1]} />;
  return <div className="app-shell"><aside className="sidebar"><div className="sidebar-brand"><span>SF</span><strong>SampleFlow</strong></div><nav>{nav.map(([Icon,label],i) => <button className={i === active ? "active" : ""} key={label} onClick={() => setActive(i)}><Icon size={18}/><span>{label}</span></button>)}</nav><div className="sidebar-user"><div className="avatar">{user.displayName.slice(0,1)}</div><div><strong>{user.displayName}</strong><span>{user.roles.map((r) => roleNames[r] ?? r).join("、")}</span></div><button onClick={logout} aria-label="退出登录"><LogOut size={17}/></button></div></aside>{content}</div>;
}

function AccountsPage({user}:{user:User}){
  const [users,setUsers]=useState<AdminUser[]>([]);const [roles,setRoles]=useState<Array<{code:string;name:string}>>([]);const [message,setMessage]=useState("");const [showCreate,setShowCreate]=useState(false);const [temporaryCredential,setTemporaryCredential]=useState<{username:string;password:string;expiresAt:string}|null>(null);const isAdmin=user.roles.includes("system_admin");
  const load=useCallback(async()=>{if(!isAdmin)return;const response=await fetch("/api/admin/users");const data=await response.json() as {users?:AdminUser[];roles?:Array<{code:string;name:string}>;message?:string};if(!response.ok)throw new Error(data.message??"账号加载失败");setUsers(data.users??[]);setRoles(data.roles??[]);},[isAdmin]);useEffect(()=>{load().catch((error)=>setMessage(error instanceof Error?error.message:"账号加载失败"));},[load]);
  async function toggle(item:AdminUser){const response=await apiFetch(`/api/admin/users/${item.id}/status`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({isActive:!item.isActive})});const data=await response.json() as {message?:string};if(!response.ok){setMessage(data.message??"状态修改失败");return;}await load();}
  async function resetPassword(item:AdminUser){const response=await apiFetch(`/api/admin/users/${item.id}/reset-password`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const data=await response.json() as {message?:string;temporaryPassword?:string;temporaryPasswordExpiresAt?:string};if(!response.ok||!data.temporaryPassword||!data.temporaryPasswordExpiresAt){setMessage(data.message??"密码重置失败");return;}setTemporaryCredential({username:item.username,password:data.temporaryPassword,expiresAt:data.temporaryPasswordExpiresAt});await load();}
  return <main className="dashboard"><header><div><h1>账号管理</h1><p>系统管理权限与业务权限分离；业务角色必须显式分配</p></div>{isAdmin?<button className="primary-action" onClick={()=>setShowCreate(true)}><Plus size={16}/>创建账号</button>:null}</header>{!isAdmin?<div className="permission-note"><ShieldCheck size={18}/>仅独立系统管理员可以维护账号和角色。</div>:null}{message?<p className="page-message">{message}</p>:null}{isAdmin?<section className="orders-card"><div className="orders-toolbar"><div><h2>系统账号</h2><span>{users.length} 个账号</span></div></div><div className="orders-table-wrap"><table><thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{users.map((item)=><tr key={item.id}><td>{item.username}</td><td>{item.displayName}</td><td>{item.roles.map((role)=>roleNames[role]??role).join("、")}</td><td><span className={`status ${item.isActive?"status-active":"status-paused"}`}>{item.isActive?"启用":"停用"}</span></td><td><div className="table-actions"><button className="table-action" onClick={()=>resetPassword(item)}>重置密码</button><button className="table-action" onClick={()=>toggle(item)}>{item.isActive?"停用":"启用"}</button></div></td></tr>)}</tbody></table></div></section>:null}{showCreate?<CreateAccount roles={roles} onClose={()=>setShowCreate(false)} onSaved={async()=>{setShowCreate(false);await load();}}/>:null}{temporaryCredential?<Modal title="临时密码已生成" note="该密码只显示一次，24 小时后失效" onClose={()=>setTemporaryCredential(null)}><div className="temporary-password-result"><p>账号：{temporaryCredential.username}</p><strong>{temporaryCredential.password}</strong><span>失效时间：{new Date(temporaryCredential.expiresAt).toLocaleString("zh-CN")}</span><div className="modal-actions"><button type="button" onClick={()=>setTemporaryCredential(null)}>我已安全保存</button></div></div></Modal>:null}</main>;
}

function CreateAccount({roles,onClose,onSaved}:{roles:Array<{code:string;name:string}>;onClose:()=>void;onSaved:()=>Promise<void>}){const[username,setUsername]=useState("");const[displayName,setDisplayName]=useState("");const[role,setRole]=useState(roles[0]?.code??"salesperson");const[error,setError]=useState("");const[created,setCreated]=useState<{temporaryPassword:string;temporaryPasswordExpiresAt:string}|null>(null);async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/admin/users",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,displayName,roles:[role]})});const data=await response.json() as {message?:string;temporaryPassword?:string;temporaryPasswordExpiresAt?:string};if(!response.ok||!data.temporaryPassword||!data.temporaryPasswordExpiresAt){setError(data.message??"创建失败");return;}setCreated({temporaryPassword:data.temporaryPassword,temporaryPasswordExpiresAt:data.temporaryPasswordExpiresAt});}return <Modal title="创建系统账号" note="临时密码只显示一次，24 小时内必须完成首次改密" onClose={onClose}>{created?<div className="temporary-password-result"><p>请立即安全保存临时密码，关闭后无法再次查看。</p><strong>{created.temporaryPassword}</strong><span>失效时间：{new Date(created.temporaryPasswordExpiresAt).toLocaleString("zh-CN")}</span><div className="modal-actions"><button type="button" onClick={async()=>{await onSaved();}}>我已安全保存</button></div></div>:<form className="business-form" onSubmit={submit}><div className="form-grid"><Field label="登录账号" value={username} onChange={setUsername}/><Field label="显示姓名" value={displayName} onChange={setDisplayName}/><label className="field"><span>角色</span><select value={role} onChange={(event)=>setRole(event.target.value)}>{roles.map((item)=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label></div>{error?<p className="form-error">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">创建账号</button></div></form>}</Modal>}

function OrganizationPage({user}:{user:User}){const[units,setUnits]=useState<OrgUnit[]>([]);const[assignments,setAssignments]=useState<Assignment[]>([]);const[message,setMessage]=useState("");const[dialog,setDialog]=useState<"unit"|"assignment"|null>(null);const isAdmin=user.roles.includes("system_admin");const load=useCallback(async()=>{const response=await fetch("/api/organization");const data=await response.json() as {units?:OrgUnit[];assignments?:Assignment[];message?:string};if(!response.ok)throw new Error(data.message??"组织架构加载失败");setUnits(data.units??[]);setAssignments(data.assignments??[]);},[]);useEffect(()=>{load().catch((error)=>setMessage(error instanceof Error?error.message:"组织架构加载失败"));},[load]);return <main className="dashboard"><header><div><h1>组织架构</h1><p>组织与人员任职按生效日期管理；业绩入账时固化组织快照</p></div>{isAdmin?<div className="header-actions"><button className="secondary-action" onClick={()=>setDialog("assignment")}>新增任职</button><button className="primary-action" onClick={()=>setDialog("unit")}><Plus size={16}/>新增组织</button></div>:null}</header>{message?<p className="page-message">{message}</p>:null}<section className="org-grid"><article className="orders-card"><div className="orders-toolbar"><div><h2>部门与小组</h2><span>{units.length} 个组织单元</span></div></div><div className="compact-list">{units.map((unit)=><div key={unit.id}><span>{unit.unitType==="department"?"部门":"小组"}</span><strong>{unit.name}</strong><small>{unit.parentName??"顶层"}</small></div>)}</div></article><article className="orders-card"><div className="orders-toolbar"><div><h2>人员任职</h2><span>{assignments.length} 条有效期记录</span></div></div><div className="compact-list">{assignments.length?assignments.map((item)=><div key={item.id}><span>{item.effectiveFrom}</span><strong>{item.displayName}</strong><small>{[item.departmentName,item.groupName].filter(Boolean).join(" / ")}</small></div>):<p className="empty-cell">暂无人员任职记录</p>}</div></article></section>{dialog==="unit"?<CreateOrgUnit units={units} onClose={()=>setDialog(null)} onSaved={async()=>{setDialog(null);await load();}}/>:null}{dialog==="assignment"?<CreateAssignment units={units} onClose={()=>setDialog(null)} onSaved={async()=>{setDialog(null);await load();}}/>:null}</main>}

function CreateOrgUnit({units,onClose,onSaved}:{units:OrgUnit[];onClose:()=>void;onSaved:()=>Promise<void>}){const[name,setName]=useState("");const[unitType,setUnitType]=useState<"department"|"group">("department");const[parentId,setParentId]=useState("");const[error,setError]=useState("");async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/admin/organization/units",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,unitType,parentId:parentId?Number(parentId):null})});const data=await response.json() as {message?:string};if(!response.ok){setError(data.message??"新增组织失败");return;}await onSaved();}return <Modal title="新增组织单元" note="小组必须归属于一个部门" onClose={onClose}><form className="business-form" onSubmit={submit}><Field label="名称" value={name} onChange={setName}/><label className="field"><span>类型</span><select value={unitType} onChange={(e)=>setUnitType(e.target.value as "department"|"group")}><option value="department">部门</option><option value="group">小组</option></select></label>{unitType==="group"?<label className="field"><span>所属部门</span><select required value={parentId} onChange={(e)=>setParentId(e.target.value)}><option value="">请选择</option>{units.filter((u)=>u.unitType==="department").map((u)=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>:null}{error?<p className="form-error">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">保存组织</button></div></form></Modal>}

function CreateAssignment({units,onClose,onSaved}:{units:OrgUnit[];onClose:()=>void;onSaved:()=>Promise<void>}){const[username,setUsername]=useState("");const[departmentId,setDepartmentId]=useState("");const[groupId,setGroupId]=useState("");const[leaderUsername,setLeaderUsername]=useState("");const[supervisorUsername,setSupervisorUsername]=useState("");const[effectiveFrom,setEffectiveFrom]=useState("2026-09-01");const[error,setError]=useState("");async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/admin/organization/assignments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,departmentId:departmentId?Number(departmentId):null,groupId:groupId?Number(groupId):null,leaderUsername,supervisorUsername,effectiveFrom,effectiveTo:null})});const data=await response.json() as {message?:string};if(!response.ok){setError(data.message??"任职保存失败");return;}await onSaved();}return <Modal title="新增人员任职" note="新任职只影响生效日以后产生的业绩事件" onClose={onClose}><form className="business-form" onSubmit={submit}><div className="form-grid"><Field label="人员账号" value={username} onChange={setUsername}/><Field label="生效日期" value={effectiveFrom} type="date" onChange={setEffectiveFrom}/><label className="field"><span>部门</span><select value={departmentId} onChange={(e)=>setDepartmentId(e.target.value)}><option value="">请选择</option>{units.filter((u)=>u.unitType==="department").map((u)=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><label className="field"><span>小组</span><select value={groupId} onChange={(e)=>setGroupId(e.target.value)}><option value="">请选择</option>{units.filter((u)=>u.unitType==="group").map((u)=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><Field label="组长账号（可空）" value={leaderUsername} onChange={setLeaderUsername}/><Field label="主管账号（可空）" value={supervisorUsername} onChange={setSupervisorUsername}/></div>{error?<p className="form-error">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">保存任职</button></div></form></Modal>}

function GoalsPage({ user, pendingOnly }: { user: User; pendingOnly: boolean }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState("");
  const canCreate = user.roles.some((role) => ["sales_manager","sales_supervisor","sales_leader"].includes(role));
  const load = useCallback(async () => { const response=await fetch("/api/goals"); const data=await response.json() as {goals?:Goal[];message?:string}; if(!response.ok) throw new Error(data.message??"目标加载失败"); setGoals(data.goals??[]); },[]);
  useEffect(()=>{load().catch((error)=>setMessage(error instanceof Error?error.message:"目标加载失败"));},[load]);
  const visible = pendingOnly ? goals.filter((goal)=>["pending_signature","pending_gm","pending_hr"].includes(goal.status)) : goals;
  async function action(goal: Goal, kind: "sign"|"approve"|"reject"|"request") {
    setMessage("");
    let url=`/api/goals/${goal.id}/decision`; let body: Record<string,unknown>={decision:kind==="reject"?"rejected":"approved",comment:"网页确认"};
    if(kind==="sign"){const signature=window.prompt("请输入签名姓名",user.displayName);if(!signature)return;url=`/api/goals/${goal.id}/sign`;body={signatureText:signature};}
    if(kind==="request"){const reason=window.prompt("请输入目标修改原因");if(!reason)return;url=`/api/goals/${goal.id}/change-requests`;body={reason};}
    const response=await apiFetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const data=await response.json() as {message?:string};if(!response.ok){setMessage(data.message??"操作失败");return;}await load();
  }
  const canExport=user.roles.some((role)=>role==="hr"||role==="general_manager");
  return <main className="dashboard goals-page"><header><div><h1>{pendingOnly?"审批中心":"目标管理"}</h1><p>上级下达、责任人签名，最终由人事部审批后生效</p></div><div className="header-actions">{canExport?<button className="secondary-action" onClick={()=>{window.location.href="/api/exports/goals.csv"}}>导出目标</button>:null}{canCreate&&!pendingOnly?<button className="primary-action" onClick={()=>setShowCreate(true)}><Plus size={16}/>下达目标</button>:null}</div></header>{message?<p className="page-message">{message}</p>:null}<section className="orders-card"><div className="orders-toolbar"><div><h2>{pendingOnly?"待办目标":"目标责任台账"}</h2><span>{visible.length} 条记录</span></div></div><div className="orders-table-wrap"><table><thead><tr><th>月份</th><th>层级</th><th>责任人</th><th>目标</th><th>已下放</th><th>差额</th><th>状态</th><th>操作</th></tr></thead><tbody>{visible.length===0?<tr><td colSpan={8} className="empty-cell">暂无目标记录</td></tr>:visible.map((goal)=><tr key={goal.id}><td>{goal.periodMonth}</td><td>{goalLevelName(goal.level)}</td><td>{goal.ownerName}</td><td>{formatMoney(goal.amount)}</td><td>{formatMoney(goal.allocatedAmount)}</td><td className={Number(goal.allocatedAmount)>Number(goal.amount)?"warning":""}>{formatMoney(Number(goal.amount)-Number(goal.allocatedAmount))}</td><td><span className={`status goal-${goal.status}`}>{goalStatusName(goal.status)}</span></td><td><div className="row-actions">{goal.ownerUsername===user.username&&goal.status==="pending_signature"?<button onClick={()=>action(goal,"sign")}>确认签名</button>:null}{goal.ownerUsername===user.username&&goal.status!=="pending_signature"?<button onClick={()=>action(goal,"request")}>申请修改</button>:null}{goal.status==="pending_gm"&&user.roles.includes("general_manager")?<><button onClick={()=>action(goal,"approve")}>批准</button><button onClick={()=>action(goal,"reject")}>拒绝</button></>:null}{goal.status==="pending_hr"&&user.roles.includes("hr")?<><button onClick={()=>action(goal,"approve")}>批准</button><button onClick={()=>action(goal,"reject")}>拒绝</button></>:null}</div></td></tr>)}</tbody></table></div></section>{showCreate?<CreateGoal user={user} onClose={()=>setShowCreate(false)} onSaved={async()=>{setShowCreate(false);await load();}}/>:null}</main>;
}

function CreateGoal({ user, onClose, onSaved }: { user: User; onClose:()=>void; onSaved:()=>Promise<void> }) {
  const available = user.roles.includes("sales_manager")?["sales_manager","department"]:user.roles.includes("sales_supervisor")?["group","personal"]:["personal"];
  const [periodMonth,setPeriodMonth]=useState("2026-09"); const [level,setLevel]=useState(available[0]!); const [ownerUsername,setOwnerUsername]=useState(level==="sales_manager"?user.username:""); const [amount,setAmount]=useState(""); const [parentGoalId,setParentGoalId]=useState(""); const [changeReason,setChangeReason]=useState("目标下达"); const [error,setError]=useState("");
  async function submit(event:FormEvent){event.preventDefault();const response=await apiFetch("/api/goals",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({periodMonth,level,ownerUsername,parentGoalId:parentGoalId?Number(parentGoalId):null,amount:Number(amount),changeReason})});const data=await response.json() as {message?:string};if(!response.ok){setError(data.message??"目标下达失败");return;}await onSaved();}
  return <Modal title="下达目标" note="责任人签名后进入对应审批节点" onClose={onClose}><form className="business-form" onSubmit={submit}><div className="form-grid"><Field label="目标月份" value={periodMonth} type="month" onChange={setPeriodMonth}/><label className="field"><span>目标层级</span><select value={level} onChange={(event)=>{setLevel(event.target.value);if(event.target.value==="sales_manager")setOwnerUsername(user.username);}}>{available.map((item)=><option key={item} value={item}>{goalLevelName(item)}</option>)}</select></label><Field label="责任人账号" value={ownerUsername} onChange={setOwnerUsername}/><Field label="目标金额" value={amount} type="number" onChange={setAmount}/><Field label="上级目标 ID（顶层可空）" value={parentGoalId} type="number" onChange={setParentGoalId}/><Field label="下达 / 调整原因" value={changeReason} onChange={setChangeReason}/></div>{error?<p className="form-error">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">提交待确认</button></div></form></Modal>;
}

function Overview({ canEdit, canExport, onEnterOrders }: { canEdit: boolean; canExport: boolean; onEnterOrders: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  useEffect(() => { fetch("/api/performance/dashboard").then(async (response) => { if (!response.ok) throw new Error("总览加载失败"); setData(await response.json() as DashboardData); }).catch(() => setData(null)); }, []);
  const maxGroup = Math.max(1, ...(data?.groups.map((group) => Number(group.total)) ?? [1]));
  return <main className="dashboard"><header><div><h1>业绩总览</h1><p>{data ? `${data.month.replace("-", " 年 ")} 月 · 来源为已入账不可变事件` : "正在加载真实业绩数据…"}</p></div><div className="header-actions">{canExport?<button className="secondary-action" onClick={()=>{window.location.href="/api/exports/performance.csv"}}>导出业绩</button>:null}{canEdit?<button className="primary-action" onClick={onEnterOrders}>录入订单业绩</button>:null}</div></header><section className="metric-band"><Metric label="当月入账" value={data ? formatMoney(data.metrics.total) : "—"} note={`${data?.metrics.eventCount ?? 0} 条业绩事件`}/><Metric label="目标口径" value="待目标审批" note="生效后显示达成率"/><Metric label="待处理审批" value={String(data?.metrics.pendingApprovals ?? 0)} note="目标确认与变更" warning/><Metric label="负向调整" value={data ? formatMoney(data.metrics.negativeTotal) : "—"} note="暂停与金额变更" negative/></section>
      <section className="dashboard-grid"><article className="trend-panel"><PanelTitle title="月度业绩趋势" note="2026 年 1—8 月正式入账金额"/><TrendChart values={data?.monthly.map((item) => Number(item.total)) ?? []}/></article><article className="ranking-panel"><PanelTitle title="小组业绩" note="按事件发生时组织归属"/>{data?.groups.map((group,i) => <div className="rank-row" key={group.name}><span>{i+1}</span><div><strong>{group.name}</strong><span><i style={{width:`${Math.max(0, Number(group.total)) / maxGroup * 100}%`}}/></span></div><b>{(Number(group.total)/10000).toFixed(1)}万</b></div>)}</article></section>
      <section className="events-panel"><div className="panel-title"><div><h2>最近业绩事件</h2><p>入账后不可覆盖或删除</p></div><button onClick={onEnterOrders}>查看全部</button></div><table><thead><tr><th>订单编号</th><th>业务员</th><th>事件类型</th><th>记账月</th><th>金额</th><th>组织归属</th><th>状态</th></tr></thead><tbody>{data?.recent.map((event) => <tr key={`${event.orderNo}-${event.month}-${event.amount}`}><td>{event.orderNo}</td><td>{event.salespersonName}</td><td>{eventTypeName(event.eventType)}</td><td>{event.month}</td><td className={Number(event.amount)<0?"negative":""}>{formatMoney(event.amount)}</td><td>{event.groupName}</td><td>已入账</td></tr>)}</tbody></table></section>
    </main>;
}

function OrdersPage({ canEdit }: { canEdit: boolean }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/performance/orders?limit=100");
    const data = await response.json() as { orders?: Order[]; message?: string };
    if (!response.ok) throw new Error(data.message ?? "订单加载失败");
    setOrders(data.orders ?? []);
  }, []);
  useEffect(() => { load().catch((error) => setMessage(error instanceof Error ? error.message : "订单加载失败")); }, [load]);
  async function refresh() { setMessage(""); await load(); }
  return <main className="dashboard orders-page"><header><div><h1>订单业绩</h1><p>按订单编号维护不可变业绩事件；已入账记录不能覆盖或删除</p></div>{canEdit ? <button className="primary-action" onClick={() => setShowCreate(true)}><Plus size={16}/>录入新订单</button> : null}</header>
    {message ? <p className="page-message" role="status">{message}</p> : null}
    {!canEdit ? <div className="permission-note"><ShieldCheck size={18}/>当前角色仅可查看。只有销售助理及销售助理组长可以录入或调整业绩。</div> : null}
    <section className="orders-card"><div className="orders-toolbar"><div><h2>订单台账</h2><span>{orders.length} 笔订单</span></div><button className="icon-action" onClick={() => refresh()} aria-label="刷新"><RefreshCw size={17}/></button></div>
      <div className="orders-table-wrap"><table><thead><tr><th>订单编号</th><th>客户</th><th>业务员</th><th>当前营业额</th><th>计入业绩</th><th>状态</th><th>操作</th></tr></thead><tbody>{orders.length === 0 ? <tr><td colSpan={7} className="empty-cell">暂无订单，请录入第一笔业绩</td></tr> : orders.map((order) => <tr key={order.id}><td>{order.orderNo}</td><td>{order.customerName}</td><td>{order.salespersonName}</td><td>{formatMoney(order.currentRevenue)}</td><td>{formatMoney(order.countedAmount)}</td><td><Status state={order.lifecycleState}/></td><td><button className="table-action" onClick={() => setSelected(order)}>查看 / 调整</button></td></tr>)}</tbody></table></div>
    </section>
    {showCreate ? <CreateOrder onClose={() => setShowCreate(false)} onSaved={async () => { setShowCreate(false); await refresh(); }} /> : null}
    {selected ? <AdjustOrder order={selected} canEdit={canEdit} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await refresh(); }} /> : null}
  </main>;
}

const initialOrder = { orderNo: "", customerName: "", customerUnit: "", salespersonName: "", serviceType: "", sourceReceivedOn: "2026-08-27", amount: "", departmentName: "", groupName: "", leaderName: "", supervisorName: "", reason: "首次录入" };

function CreateOrder({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(initialOrder);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  function set(name: keyof typeof form, value: string) { setForm((current) => ({ ...current, [name]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await apiFetch("/api/performance/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, amount: Number(form.amount) }) });
      const data = await response.json() as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "订单入账失败");
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "订单入账失败"); }
    finally { setSaving(false); }
  }
  return <Modal title="录入订单业绩" note="确认入账后立即参与业绩计算，后续只能追加更正事件" onClose={onClose}><form className="business-form" onSubmit={submit}><div className="form-grid"><Field label="订单编号" value={form.orderNo} onChange={(v) => set("orderNo",v)}/><Field label="收到日期" value={form.sourceReceivedOn} type="date" onChange={(v) => set("sourceReceivedOn",v)}/><Field label="客户名称" value={form.customerName} onChange={(v) => set("customerName",v)}/><Field label="客户单位" value={form.customerUnit} onChange={(v) => set("customerUnit",v)}/><Field label="业务员" value={form.salespersonName} onChange={(v) => set("salespersonName",v)}/><Field label="服务类型" value={form.serviceType} onChange={(v) => set("serviceType",v)}/><Field label="营业额" value={form.amount} type="number" onChange={(v) => set("amount",v)}/><Field label="部门" value={form.departmentName} onChange={(v) => set("departmentName",v)}/><Field label="小组" value={form.groupName} onChange={(v) => set("groupName",v)}/><Field label="组长" value={form.leaderName} onChange={(v) => set("leaderName",v)}/><Field label="主管" value={form.supervisorName} onChange={(v) => set("supervisorName",v)}/><Field label="入账原因" value={form.reason} onChange={(v) => set("reason",v)}/></div>{error ? <p className="form-error">{error}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit" disabled={saving}>{saving ? "正在入账…" : "确认入账"}</button></div></form></Modal>;
}

function AdjustOrder({ order, canEdit, onClose, onSaved }: { order: Order; canEdit: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const allowed = order.lifecycleState === "active" ? ["revenue_change","pause"] : order.lifecycleState === "paused" ? ["restart"] : order.lifecycleState === "zero" ? ["first_include"] : [];
  const [type, setType] = useState(allowed[0] ?? "");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState("2026-08-27");
  const [reason, setReason] = useState("");
  const [departmentName,setDepartmentName]=useState(order.departmentName); const [groupName,setGroupName]=useState(order.groupName); const [leaderName,setLeaderName]=useState(order.leaderName??""); const [supervisorName,setSupervisorName]=useState(order.supervisorName??"");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    const payload = { type, occurredOn, reason, departmentName, groupName, leaderName, supervisorName, ...(type === "revenue_change" ? { newAmount: Number(amount) } : {}), ...(type === "first_include" ? { amount: Number(amount) } : {}) };
    const response = await apiFetch(`/api/performance/orders/${order.id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json() as { message?: string };
    if (!response.ok) { setError(data.message ?? "调整入账失败"); return; }
    await onSaved();
  }
  return <Modal title={order.orderNo} note={`${order.customerName} · 当前营业额 ${formatMoney(order.currentRevenue)} · 计入 ${formatMoney(order.countedAmount)}`} onClose={onClose}>{canEdit && allowed.length ? <form className="business-form" onSubmit={submit}><div className="event-options">{allowed.includes("revenue_change") ? <button type="button" className={type==="revenue_change"?"selected":""} onClick={() => setType("revenue_change")}><RefreshCw size={17}/>修改营业额</button> : null}{allowed.includes("pause") ? <button type="button" className={type==="pause"?"selected":""} onClick={() => setType("pause")}><PauseCircle size={17}/>整单暂停</button> : null}{allowed.includes("restart") ? <button type="button" className={type==="restart"?"selected":""} onClick={() => setType("restart")}><PlayCircle size={17}/>订单重启</button> : null}{allowed.includes("first_include") ? <button type="button" className={type==="first_include"?"selected":""} onClick={() => setType("first_include")}><Plus size={17}/>首次计入</button> : null}</div><div className="form-grid">{type === "revenue_change" || type === "first_include" ? <Field label={type === "revenue_change" ? "调整后营业额" : "首次计入金额"} value={amount} type="number" onChange={setAmount}/> : null}<Field label="事件发生日期" value={occurredOn} type="date" onChange={setOccurredOn}/><Field label="本次归属部门" value={departmentName} onChange={setDepartmentName}/><Field label="本次归属小组" value={groupName} onChange={setGroupName}/><Field label="本次组长" value={leaderName} onChange={setLeaderName}/><Field label="本次主管" value={supervisorName} onChange={setSupervisorName}/><Field label="原因（必填）" value={reason} onChange={setReason}/></div>{error ? <p className="form-error">{error}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">确认追加事件</button></div></form> : <div className="permission-note">当前订单状态没有可执行操作，或当前角色仅可查看。</div>}</Modal>;
}

function Field({ label, value, onChange, type="text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) { return <label className="field"><span>{label}</span><input required value={value} type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.01" : undefined} onChange={(event) => onChange(event.target.value)}/></label>; }
function Modal({ title, note, onClose, children }: { title: string; note: string; onClose: () => void; children: ReactNode }) { return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true"><header><div><h2>{title}</h2><p>{note}</p></div><button onClick={onClose} aria-label="关闭">×</button></header>{children}</section></div>; }
function Status({ state }: { state: Order["lifecycleState"] }) { const names = { draft:"草稿", active:"正向计入", paused:"已暂停", zero:"零金额" }; return <span className={`status status-${state}`}>{names[state]}</span>; }
function formatMoney(value: string | number) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(Number(value)); }
function eventTypeName(type: string) { return ({ initial:"首次录入", revenue_change:"营业额修改", pause:"整单暂停", restart:"订单重启", first_include:"首次计入", legacy_adjustment:"历史迁移" } as Record<string,string>)[type] ?? type; }
function goalLevelName(level: string) { return ({ sales_manager:"销售经理总目标", department:"部门目标", group:"小组目标", personal:"个人目标" } as Record<string,string>)[level] ?? level; }
function goalStatusName(status: string) { return ({ draft:"草稿", pending_signature:"待责任人签名", pending_gm:"待总经理审批", pending_hr:"待人事审批", active:"已生效", rejected:"已拒绝", superseded:"已替代" } as Record<string,string>)[status] ?? status; }
function Placeholder({ title }: { title: string }) { return <main className="dashboard"><header><div><h1>{title}</h1><p>该模块将在 1.0 后续闭环中接入真实业务流程</p></div></header><div className="placeholder"><FileClock size={32}/><h2>正在建设</h2><p>当前优先完成订单业绩的不可变事件流水。</p></div></main>; }

function PanelTitle({ title, note }: { title: string; note: string }) { return <div className="panel-title"><div><h2>{title}</h2><p>{note}</p></div></div>; }
function Metric({label,value,note,warning,negative}:{label:string;value:string;note:string;warning?:boolean;negative?:boolean}) { return <div className="metric"><span>{label}</span><strong className={negative?"negative":""}>{value}</strong><small className={warning?"warning":""}>{note}</small></div>; }
function TrendChart({ values = [0,0,0,0,0,0,0,0] }: { values?: number[] }) { const filled=Array.from({length:8},(_,i)=>values[i]??0); const max=Math.max(1,...filled); const points=filled.map((v,i)=>`${44+i*74},${190-(v/max)*150}`).join(" "); return <div className="chart"><svg viewBox="0 0 590 220" role="img" aria-label="1月至8月业绩折线图"><g className="grid-lines">{[40,90,140,190].map((y)=><line key={y} x1="42" y1={y} x2="570" y2={y}/>)}</g><polyline points={points} fill="none" stroke="#2f6fed" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>{filled.map((v,i)=><circle key={i} cx={44+i*74} cy={190-(v/max)*150} r="5" fill="#fff" stroke="#2f6fed" strokeWidth="3"/>)}</svg><div className="chart-labels">{["1月","2月","3月","4月","5月","6月","7月","8月"].map((m)=><span key={m}>{m}</span>)}</div></div>; }
