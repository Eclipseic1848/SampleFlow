import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Activity, ChevronRight, Database, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { apiFetch, readResponseJson } from "./app-api";
import type { AuthState, User } from "./app-types";
import { Dashboard } from "./dashboard";

function passwordStrength(password: string): "弱" | "中" | "强" {
  const categoryCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (password.length >= 12 && categoryCount === 4) return "强";
  if (password.length >= 8 && categoryCount >= 3) return "中";
  return "弱";
}

function PasswordInput({id,name,label,value,onChange,autoComplete,describedBy,invalid=false}:{id:string;name:string;label:string;value:string;onChange:(value:string)=>void;autoComplete:"current-password"|"new-password";describedBy?:string;invalid?:boolean}){
  const[visible,setVisible]=useState(false);
  const inputRef=useRef<HTMLInputElement>(null);
  function toggleVisibility(){if(inputRef.current&&inputRef.current.value!==value)onChange(inputRef.current.value);setVisible((current)=>!current);}
  return <><label htmlFor={id}>{label}</label><div className="password-input"><input ref={inputRef} id={id} name={name} type={visible?"text":"password"} defaultValue={value} onChange={(event)=>onChange(event.target.value)} autoComplete={autoComplete} aria-describedby={describedBy} aria-invalid={invalid||undefined}/><button type="button" className="password-input-toggle" aria-label={`${visible?"隐藏":"显示"}${label}`} aria-pressed={visible} onClick={toggleVisibility}>{visible?<EyeOff size={18} aria-hidden="true"/>:<Eye size={18} aria-hidden="true"/>}</button></div></>;
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
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const formData=new FormData(event.currentTarget);const submittedCurrentPassword=String(formData.get("currentPassword")??"");const submittedNewPassword=String(formData.get("newPassword")??"");const response=await apiFetch("/api/auth/change-password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({currentPassword:submittedCurrentPassword,newPassword:submittedNewPassword})});const data=await response.json() as {message?:string};if(!response.ok){setMessage(data.message??"密码修改失败");return;}await onChanged();}
  const currentPasswordError=message==="当前密码错误";
  return <main className="password-shell"><section className="login-card"><div className="login-heading"><p>首次登录安全设置</p><h2>请修改初始密码</h2><span>6—128 位，并包含英文字母、数字和符号</span></div><form noValidate onSubmit={submit}><PasswordInput id="current-password" name="currentPassword" label="当前密码" value={currentPassword} onChange={(value)=>{setCurrentPassword(value);if(message)setMessage("");}} autoComplete="current-password" describedBy={`current-password-hint${currentPasswordError?" current-password-error":""}`} invalid={currentPasswordError}/><p id="current-password-hint" className="password-hint">当前密码请填写刚才登录时使用的临时密码。</p><PasswordInput id="new-password" name="newPassword" label="新密码" value={newPassword} onChange={(value)=>{setNewPassword(value);if(message)setMessage("");}} autoComplete="new-password"/><p className="password-strength" aria-live="polite">密码强度：{passwordStrength(newPassword)}</p><button type="submit">保存新密码</button>{message?<p id={currentPasswordError?"current-password-error":undefined} className="form-error" role="alert">{message}</p>:null}</form></section></main>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState(import.meta.env.DEV ? "sales_assistant" : "");
  const [password, setPassword] = useState(import.meta.env.DEV ? "SampleFlow@2026" : "");
  const [message, setMessage] = useState("");
  useEffect(()=>{document.title="登录 — SampleFlow";},[]);
  const [submitting, setSubmitting] = useState(false);
  const [readiness, setReadiness] = useState<"checking" | "ready" | "unavailable">("checking");
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const checkReadiness = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/ready", { cache: "no-store", signal: controller.signal });
        if (active) setReadiness(response.ok ? "ready" : "unavailable");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (active) setReadiness("unavailable");
      }
    };
    void checkReadiness();
    const timer = window.setInterval(checkReadiness, 5_000);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setMessage("");
    try {
      const formData = new FormData(event.currentTarget);
      const submittedUsername = String(formData.get("username") ?? "");
      const submittedPassword = String(formData.get("password") ?? "");
      const response = await apiFetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username:submittedUsername, password:submittedPassword }) });
      const data = await readResponseJson<{ message?: string }>(response, "登录服务暂时不可用，请确认 API 已启动后重试");
      if (!response.ok) throw new Error(data.message ?? "登录失败");
      const user = await getCurrentUser();
      if (!user) throw new Error("登录会话创建失败");
      onLogin(user);
    } catch (error) { setMessage(error instanceof Error ? error.message : "登录失败"); }
    finally { setSubmitting(false); }
  }
  return <main className="login-shell">
    <section className="brand-panel"><img className="brand-logo" src="/brand-logo.png" alt="瑞源生物 Pronetbio"/><div className="brand-copy"><p className="product-name">SampleFlow</p><h1>每一笔业绩，都有清晰的来路与责任。</h1><p className="brand-summary">面向销售到样业务的目标、订单、组织归属与审批系统。历史不重写，调整有事件，结果可追溯。</p></div><div className="principles"><div><Activity size={20} /><span>实时业绩事件</span></div><div><ShieldCheck size={20} /><span>角色权限分离</span></div><div><Database size={20} /><span>集中数据与审计</span></div></div></section>
    <section className="login-panel"><div className="login-card"><div className="login-heading"><p>销售到样业绩管理</p><h2>登录系统</h2><span>{import.meta.env.DEV ? "开发环境已预填销售助理演示账号" : "请使用管理员分配的账号登录"}</span></div><form noValidate onSubmit={submit}><label htmlFor="username">账号</label><input id="username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /><PasswordInput id="password" name="password" label="密码" value={password} onChange={setPassword} autoComplete="current-password"/><button type="submit" disabled={submitting}>{submitting ? "正在登录…" : "进入 SampleFlow"}<ChevronRight size={18} /></button>{message ? <p className="form-error" role="alert">{message}</p> : null}</form><div className={`readiness readiness-${readiness}`} role="status" aria-live="polite"><span />{{checking:"正在检查 API 与数据库",ready:"前端、API 与数据库已连接",unavailable:"API 或数据库暂不可用"}[readiness]}</div></div></section>
  </main>;
}
