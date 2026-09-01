import { useCallback, useEffect, useState } from "react";
import { Activity, BarChart3, ClipboardCheck, FileClock, LogOut, Network, Search, ShieldCheck, Target, UsersRound } from "lucide-react";
import { apiFetch, roleNames } from "./app-api";
import type { User } from "./app-types";
import { PAGE_ORDER, PAGE_ROUTES, readPageId, type PageId } from "./page-routes";
import { AccountsPage } from "./pages/accounts-page";
import { AnalysisPage } from "./pages/analysis-page";
import { ApprovalsPage } from "./pages/approvals-page";
import { AuditPage } from "./pages/audit-page";
import { GoalsPage } from "./pages/goals-page";
import { OrdersPage } from "./pages/orders-page";
import { OrganizationPage } from "./pages/organization-page";
import { Overview } from "./pages/overview-page";

export function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const pageIcons = {overview:BarChart3,goals:Target,orders:ClipboardCheck,analysis:Activity,organization:Network,approvals:FileClock,audits:Search,accounts:UsersRound};
  const canOpen=(page:PageId)=>user.capabilities[PAGE_ROUTES[page].capability];
  const pages=PAGE_ORDER.filter(canOpen).map((id)=>({id,Icon:pageIcons[id],label:PAGE_ROUTES[id].label}));
  const defaultPage:PageId=user.capabilities.manageAccounts?"accounts":pages[0]?.id??"overview";
  const [active,setActive]=useState<PageId>(()=>readPageId(window.location.search)??defaultPage);
  const navigate=useCallback((page:PageId,mode:"push"|"replace"="push")=>{if(mode==="push"&&readPageId(window.location.search)===page)return;const params=new URLSearchParams(window.location.search);params.set("page",page);window.history[`${mode}State`]({},"",`${window.location.pathname}?${params.toString()}${window.location.hash}`);setActive(page);},[]);
  useEffect(()=>{if(!readPageId(window.location.search))navigate(defaultPage,"replace");const restore=()=>{const page=readPageId(window.location.search);if(page)setActive(page);else navigate(defaultPage,"replace");};window.addEventListener("popstate",restore);return()=>window.removeEventListener("popstate",restore);},[defaultPage,navigate]);
  useEffect(()=>{document.title=`${PAGE_ROUTES[active].label} — SampleFlow`;},[active]);
  async function logout() { await apiFetch("/api/auth/logout", { method: "POST" }); onLogout(); }
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
  return <div className="app-shell"><aside className="sidebar"><div className="sidebar-brand"><img src="/brand-logo.png" alt="瑞源生物 Pronetbio"/></div><nav>{pages.map(({Icon,label,id}) => <button className={id === active ? "active" : ""} key={id} onClick={() => navigate(id)} aria-label={label} aria-current={id===active?"page":undefined}><Icon size={18}/><span>{label}</span></button>)}</nav><div className="sidebar-user"><div className="avatar">{user.displayName.slice(0,1)}</div><div><strong>{user.displayName}</strong><span>{user.roles.map((r) => roleNames[r] ?? r).join("、")}</span></div><button onClick={logout} aria-label="退出登录"><LogOut size={17}/></button></div></aside>{content}</div>;
}
