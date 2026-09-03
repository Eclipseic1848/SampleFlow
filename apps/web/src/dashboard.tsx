import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, BarChart3, ClipboardCheck, FileClock, KeyRound, LogOut, Network, Search, ShieldCheck, Target, UsersRound } from "lucide-react";
import { logoutCurrentSession, roleNames } from "./app-api";
import type { User } from "./app-types";
import { Onboarding } from "./onboarding";
import { PAGE_ORDER, PAGE_ROUTES, readPageId, type PageId } from "./page-routes";
import { AccountsPage } from "./pages/accounts-page";
import { AnalysisPage } from "./pages/analysis-page";
import { ApprovalsPage } from "./pages/approvals-page";
import { AuditPage } from "./pages/audit-page";
import { GoalsPage } from "./pages/goals-page";
import { OrdersPage } from "./pages/orders-page";
import { OrganizationPage } from "./pages/organization-page";
import { Overview } from "./pages/overview-page";

export function Dashboard({ user, onLogout, onChangePassword }: { user: User; onLogout: () => void; onChangePassword:()=>void }) {
  const pageIcons = {overview:BarChart3,goals:Target,orders:ClipboardCheck,analysis:Activity,organization:Network,approvals:FileClock,audits:Search,accounts:UsersRound};
  const canOpen=(page:PageId)=>user.capabilities[PAGE_ROUTES[page].capability];
  const pages=PAGE_ORDER.filter(canOpen).map((id)=>({id,Icon:pageIcons[id],label:PAGE_ROUTES[id].label}));
  const defaultPage:PageId=user.capabilities.manageAccounts?"accounts":pages[0]?.id??"overview";
  const [active,setActive]=useState<PageId>(()=>readPageId(window.location.search)??defaultPage);
  const [logoutError,setLogoutError]=useState("");
  const [loggingOut,setLoggingOut]=useState(false);
  const focusPageHeading=useRef(false);
  const navigate=useCallback((page:PageId,mode:"push"|"replace"="push")=>{if(mode==="push"&&readPageId(window.location.search)===page)return;const params=new URLSearchParams(window.location.search);params.set("page",page);window.history[`${mode}State`]({},"",`${window.location.pathname}?${params.toString()}${window.location.hash}`);focusPageHeading.current=mode==="push";setActive(page);},[]);
  useEffect(()=>{if(!readPageId(window.location.search))navigate(defaultPage,"replace");const restore=()=>{const page=readPageId(window.location.search);if(page){focusPageHeading.current=true;setActive(page);}else navigate(defaultPage,"replace");};window.addEventListener("popstate",restore);return()=>window.removeEventListener("popstate",restore);},[defaultPage,navigate]);
  useEffect(()=>{document.title=`${PAGE_ROUTES[active].label} — SampleFlow`;if(!focusPageHeading.current)return;focusPageHeading.current=false;const frame=window.requestAnimationFrame(()=>{const heading=document.querySelector<HTMLElement>("#main-content h1");heading?.setAttribute("tabindex","-1");heading?.focus();});return()=>window.cancelAnimationFrame(frame);},[active]);
  async function logout() {
    if(loggingOut)return;
    setLoggingOut(true);setLogoutError("");
    const result=await logoutCurrentSession();
    if(result==="logged-out")onLogout();
    else setLogoutError(result==="active"?"退出登录失败，会话仍然有效，请重试。":"无法确认退出结果，会话仍保留，请检查网络后重试。");
    setLoggingOut(false);
  }
  const content = !canOpen(active)
    ? <main className="dashboard"><header><div><h1>无法访问{PAGE_ROUTES[active].label}</h1><p>该页面不在当前账号的角色权限范围内</p></div></header><div className="permission-note"><ShieldCheck size={18}/>403 · 当前账号没有{PAGE_ROUTES[active].label}权限。</div></main>
    : active === "orders"
    ? <OrdersPage user={user} />
    : active === "goals"
      ? <GoalsPage user={user} />
      : active === "approvals"
        ? <ApprovalsPage user={user} />
      : active === "organization"
        ? <OrganizationPage user={user}/>
      : active === "analysis"
        ? <AnalysisPage/>
      : active === "audits"
        ? <AuditPage/>
      : active === "accounts"
        ? <AccountsPage user={user}/>
      : <Overview canEdit={user.capabilities.editPerformance} canExport={user.capabilities.exportPerformance} onEnterOrders={() => navigate("orders")} />;
  return <div className="app-shell"><a className="skip-link" href="#main-content">跳到主要内容</a><aside className="sidebar"><div className="sidebar-brand"><img src="/brand-logo.png" alt="瑞源生物 Pronetbio"/></div><nav data-onboarding="navigation">{pages.map(({Icon,label,id}) => {const params=new URLSearchParams(window.location.search);params.set("page",id);const href=`${window.location.pathname}?${params.toString()}${window.location.hash}`;return <a className={id===active?"active":""} key={id} href={href} onClick={(event)=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(id);}} aria-label={label} aria-current={id===active?"page":undefined}><Icon size={18}/><span>{label}</span></a>;})}</nav><Onboarding key={`${user.id}:${[...user.roles].sort().join(".")}:${active}`} user={user} page={active} canOpen={canOpen(active)} includeNavigation={active===defaultPage}/><button type="button" className="sidebar-account-action" onClick={onChangePassword}><KeyRound size={16}/><span>修改密码</span></button><div className="sidebar-user"><div className="avatar">{user.displayName.slice(0,1)}</div><div><strong>{user.displayName}</strong><span>{user.roles.map((r) => roleNames[r] ?? r).join("、")}</span></div><button onClick={logout} disabled={loggingOut} aria-label="退出登录"><LogOut size={17}/></button></div>{logoutError?<p className="form-error" role="alert">{logoutError}</p>:null}</aside><div id="main-content" className="main-content" tabIndex={-1}>{content}</div></div>;
}
