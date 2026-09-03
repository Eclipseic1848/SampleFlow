import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { roleNames } from "./app-api";
import type { User } from "./app-types";
import { PAGE_ROUTES, type PageId } from "./page-routes";

type TourStep = Readonly<{
  target: string;
  title: string;
  description: string;
}>;

type Spotlight = Readonly<{ top: number; left: number; width: number; height: number }>;

const STORAGE_VERSION = "v3";
const STORAGE_PREFIX = "sampleflow:onboarding:";
const CURRENT_STORAGE_PREFIX = `${STORAGE_PREFIX}${STORAGE_VERSION}:`;
const memoryFlags = new Set<string>();
const sessionDismissedFlags = new Set<string>();
let legacyFlagsCleared = false;

function clearLegacyFlags(): void {
  if (legacyFlagsCleared) return;
  legacyFlagsCleared = true;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX) && !key.startsWith(CURRENT_STORAGE_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // 浏览器禁用存储时按未完成引导处理。
  }
}

function roleKey(user: User): string {
  return [...user.roles].sort().join(".");
}

function storageKey(user: User, page: PageId | "all"): string {
  return `${CURRENT_STORAGE_PREFIX}${encodeURIComponent(user.id)}:${roleKey(user)}:${page}`;
}

function hasFlag(key: string): boolean {
  clearLegacyFlags();
  if (memoryFlags.has(key)) return true;
  try {
    return window.localStorage.getItem(key) === "completed";
  } catch {
    return false;
  }
}

function saveFlag(key: string): void {
  clearLegacyFlags();
  memoryFlags.add(key);
  try {
    window.localStorage.setItem(key, "completed");
  } catch {
    // 浏览器禁用存储时仍在当前会话内避免重复打扰。
  }
}

function isDismissedForSession(key:string):boolean{if(sessionDismissedFlags.has(key))return true;try{return window.sessionStorage.getItem(key)==="dismissed";}catch{return false;}}
function dismissForSession(key:string):void{sessionDismissedFlags.add(key);try{window.sessionStorage.setItem(key,"dismissed");}catch{/* 当前运行期内仍避免重复打扰。 */}}
function clearSessionDismissal(key:string):void{sessionDismissedFlags.delete(key);try{window.sessionStorage.removeItem(key);}catch{/* 手动重播仍可继续。 */}}

function target(page: PageId, anchor: string): string {
  if (page === "goals" || page === "approvals") return {
    "page-header": ".goals-page > header",
    "page-actions": ".goals-page > header .header-actions",
    "primary-content": ".goals-page > .orders-card",
    "role-workspace": ".goals-page > .approval-tabs",
  }[anchor] ?? ".goals-page";
  if (page === "analysis") return anchor === "page-header" ? ".analysis-page .analysis-header" : ".analysis-page > .analysis-panel";
  if (page === "organization") return {
    "page-header": ".dashboard > header",
    "page-actions": ".dashboard > header .header-actions",
    "primary-content": ".dashboard > .org-grid",
  }[anchor] ?? ".dashboard";
  if (page === "audits") return {
    "page-header": ".dashboard > header",
    "scope-note": ".dashboard > .permission-note",
    "filters": ".dashboard > .orders-card .order-filters",
    "primary-content": ".dashboard > .orders-card",
  }[anchor] ?? ".dashboard";
  if (page === "accounts") return {
    "page-header": ".dashboard > header",
    "page-actions": ".dashboard > header > .primary-action",
    "filters": ".dashboard > .orders-card .account-search",
    "secondary-content": ".dashboard > .permission-matrix-card",
  }[anchor] ?? ".dashboard > .orders-card";
  return `[data-onboarding-page="${page}"] [data-onboarding="${anchor}"]`;
}

function roleSummary(user: User): string {
  return user.roles.map((role) => roleNames[role] ?? role).join("、");
}

function scopeDescription(user: User): string {
  if (user.roles.some((role) => ["sales_manager", "hr", "general_manager", "sales_assistant", "sales_assistant_leader"].includes(role))) return "这里展示当前角色获准查看的全公司或销售组织数据。";
  if (user.roles.includes("sales_supervisor")) return "这里包含你本人和所负责部门的授权数据。";
  if (user.roles.includes("sales_leader")) return "这里包含你本人和所负责小组的授权数据。";
  if (user.roles.includes("salesperson")) return "这里仅展示你本人的目标和业绩范围。";
  return "页面内容始终受当前角色权限和数据范围约束。";
}

function goalActionDescription(user: User): string {
  const descriptions = [];
  if (user.roles.includes("sales_manager")) descriptions.push("销售经理可录入总目标并向业务主管下达目标");
  if (user.roles.includes("sales_supervisor")) descriptions.push("业务主管可向业务员组长下达目标并确认部门目标");
  if (user.roles.includes("sales_leader")) descriptions.push("业务员组长可向业务员下达目标并确认小组目标");
  if (user.roles.includes("salesperson")) descriptions.push("业务员可确认个人目标并申请修改");
  if (user.roles.includes("hr")) descriptions.push("人事部只读查看并在审批中心终审");
  if (user.roles.includes("general_manager")) descriptions.push("总经理只读查看并在审批中心处理总目标");
  return `${descriptions.join("；")}。`;
}

function approvalDescription(user: User): string {
  const descriptions = [];
  if (user.roles.includes("hr")) descriptions.push("人事部处理目标终审和修改申请终审");
  if (user.roles.includes("general_manager")) descriptions.push("总经理处理销售经理总目标");
  if (user.roles.some((role) => ["sales_manager", "sales_supervisor", "sales_leader"].includes(role))) descriptions.push("负责人处理直属下级修改和本级目标联动");
  if (user.roles.includes("salesperson")) descriptions.push("业务员处理本人确认和可撤回的修改申请");
  return `${descriptions.join("；")}。操作前先核对版本、确认人和既有意见。`;
}

function pageSteps(page: PageId, user: User, includeNavigation: boolean): TourStep[] {
  const steps: TourStep[] = includeNavigation ? [{
    target: '[data-onboarding="navigation"]',
    title: "从这里进入工作页面",
    description: `侧栏只显示“${roleSummary(user)}”当前有权访问的模块；隐藏入口不替代服务端权限校验。`,
  }] : [];

  if (page === "overview") steps.push(
    { target: target(page, "page-header"), title: "业绩总览", description: `${scopeDescription(user)} 先确认月份和数据口径，再看目标达成。` },
    { target: target(page, "primary-content"), title: "目标与账本指标", description: "目标未生效时不会计算正式达成率；可点击的业绩和差距数字支持继续穿透。" },
    { target: target(page, "secondary-content"), title: "最近业绩事件", description: "这里展示授权范围内最近入账的不可变事件；历史只能追加调整，不能覆盖或删除。" },
  );

  if (page === "orders") {
    steps.push(
      { target: target(page, "page-header"), title: "订单业绩", description: `${scopeDescription(user)} 搜索、详情和导出继续沿用同一服务端数据范围。` },
      { target: target(page, "filters"), title: "组合筛选", description: "订单号、月份、状态、人员、组织、区域和客户单位可以组合查询；提交后的条件会写入 URL。" },
      { target: target(page, "primary-content"), title: "不可变订单台账", description: "打开订单可查看完整事件链。已入账数据不直接编辑，只能按合法状态追加事件。" },
    );
    if (user.capabilities.editPerformance) steps.splice(1, 0, {
      target: target(page, "page-actions"),
      title: "录入与导入",
      description: "销售助理可逐笔确认入账或上传 Excel 预检；上传不会直接写入正式账本。",
    });
    else if (user.capabilities.exportPerformance) steps.splice(1, 0, {
      target: target(page, "page-actions"),
      title: "导出当前授权范围",
      description: "导出复用当前组合筛选和服务端权限，不会因为页面按钮可见而扩大数据范围。",
    });
    if (user.roles.includes("sales_assistant_leader") || user.roles.includes("hr")) {
      const duties = [];
      if (user.roles.includes("sales_assistant_leader")) duties.push("销售助理组长负责月度核对、更正申请、历史核对和执行已获批更正");
      if (user.roles.includes("hr")) duties.push("人事部负责关账以及更正、历史核对的批准或驳回");
      steps.push({
        target: target(page, "role-workspace"),
        title: "记账治理工作台",
        description: `${duties.join("；")}。${user.capabilities.editPerformance ? "当前组合角色另有订单录入与合法事件调整权限。" : "当前组合角色不能亲自修改业绩。"}`,
      });
    }
  }

  if (page === "goals") steps.push(
    { target: target(page, "page-header"), title: "目标管理", description: goalActionDescription(user) },
    { target: target(page, "page-actions"), title: "目标入口", description: "导出只包含授权目标；有下达权限时，责任人和直属关系仍由服务端校验。" },
    { target: target(page, "primary-content"), title: "目标责任台账", description: "每一行都显示具体版本、分配差额和状态。正式报表只对已生效目标开放。" },
  );

  if (page === "approvals") steps.push(
    { target: target(page, "page-header"), title: "审批中心", description: approvalDescription(user) },
    { target: target(page, "primary-content"), title: "待确认与待审批", description: "操作按钮只会出现在当前人员可处理的目标版本上；冲突后页面会重新读取权威状态。" },
    { target: target(page, "role-workspace"), title: "修改与联动", description: "通过页签切换目标审批、修改申请与联动选择；修改不会直接覆盖生效目标。" },
  );

  if (page === "analysis") steps.push(
    { target: target(page, "page-header"), title: "地区与客户分析", description: `${scopeDescription(user)} 先选择月份，再从省份进入客户和订单事件。` },
    { target: target(page, "primary-content"), title: "按事件快照逐级穿透", description: "地图、客户单位和后续明细都使用事件发生时的冻结维度；待补齐金额必须与总账一起对平。" },
  );

  if (page === "organization") {
    steps.push(
      { target: target(page, "page-header"), title: "组织架构", description: user.capabilities.manageOrganization ? "系统管理员在这里维护组织、任职和负责人有效期；这些权限不包含业务数据查看。" : "这里按你的业务权限只读展示部门、小组和人员任职。" },
      { target: target(page, "primary-content"), title: "生效日期决定归属", description: "组织变更只影响生效日后的新事件，既有历史业绩快照不会被重写。" },
    );
    if (user.capabilities.manageOrganization) steps.splice(1, 0, {
      target: target(page, "page-actions"),
      title: "组织维护操作",
      description: "新增、异动和负责人更换都要求明确生效日期；负责人交接不能留下空档。",
    });
  }

  if (page === "audits") steps.push(
    { target: target(page, "page-header"), title: "审计查询", description: "审计只读且不可删除；系统管理员只看系统域，业务角色继续按原数据范围查看。" },
    { target: target(page, "scope-note"), title: "权限和敏感信息边界", description: "密码、令牌等敏感值不会返回；审计页面不能用来绕过业务授权。" },
    { target: target(page, "filters"), title: "组合定位记录", description: "可以按人员、动作、实体和上海时区的时间范围查询，筛选与分页会保留在 URL。" },
    { target: target(page, "primary-content"), title: "不可变记录", description: "每条记录保留操作人、实体、变更前后内容和时间；本页没有修改或删除入口。" },
  );

  if (page === "accounts") steps.push(
    { target: target(page, "page-header"), title: "账号管理", description: "系统管理员维护账号、密码状态和固定角色，但不会因此获得业务查看或导出权限。" },
    { target: target(page, "page-actions"), title: "创建账号", description: "新账号可绑定已有人员身份；临时密码只显示一次，并要求首次登录改密。" },
    { target: target(page, "filters"), title: "搜索与账号操作", description: "可搜索账号或姓名，并执行角色修改、密码重置和启停；不确定结果时先核对状态。" },
    { target: target(page, "secondary-content"), title: "角色权限说明", description: "这里展示与服务端同源的固定角色矩阵；多角色取并集，不能逐项自定义权限。" },
  );

  return steps;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function bubblePosition(spotlight: Spotlight): { top: number; left: number } {
  const margin = 16;
  const gap = 16;
  const width = Math.min(360, window.innerWidth - margin * 2);
  const estimatedHeight = 270;
  if (window.innerWidth - spotlight.left - spotlight.width >= width + gap) {
    return { top: clamp(spotlight.top, margin, window.innerHeight - estimatedHeight - margin), left: spotlight.left + spotlight.width + gap };
  }
  if (spotlight.left >= width + gap) {
    return { top: clamp(spotlight.top, margin, window.innerHeight - estimatedHeight - margin), left: spotlight.left - width - gap };
  }
  const below = spotlight.top + spotlight.height + gap;
  return {
    top: below + estimatedHeight <= window.innerHeight ? below : Math.max(margin, spotlight.top - estimatedHeight - gap),
    left: clamp(spotlight.left, margin, window.innerWidth - width - margin),
  };
}

export function Onboarding({ user, page, canOpen, includeNavigation }: { user: User; page: PageId; canOpen: boolean; includeNavigation: boolean }) {
  const replayRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const focusDialog = useCallback((dialog: HTMLElement | null) => {
    dialogRef.current = dialog;
    dialog?.focus();
  }, []);
  const autoAttempted = useRef(new Set<string>());
  const configuredSteps = useMemo(() => pageSteps(page, user, includeNavigation), [includeNavigation, page, user]);
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [spotlight, setSpotlight] = useState<Spotlight | null>(null);
  const [open, setOpen] = useState(false);
  const currentStep = steps[stepIndex] ?? null;
  const pageFlag = storageKey(user, page);
  const allFlag = storageKey(user, "all");

  const start = useCallback(() => {
    if (!canOpen || document.querySelector(".modal-backdrop")) return false;
    const available = configuredSteps.filter((step) => document.querySelector(step.target));
    if (!available.length) return false;
    setSteps(available);
    setStepIndex(0);
    setOpen(true);
    clearSessionDismissal(pageFlag);
    return true;
  }, [canOpen, configuredSteps, pageFlag]);

  useEffect(() => {
    if (!canOpen || hasFlag(pageFlag) || hasFlag(allFlag) || isDismissedForSession(pageFlag) || autoAttempted.current.has(pageFlag)) return;
    const tryStart = () => {
      if (page === "overview" && !document.querySelector('[data-onboarding-page="overview"][data-onboarding-ready="true"]')) return false;
      if (!start()) return false;
      autoAttempted.current.add(pageFlag);
      return true;
    };
    if (tryStart()) return;
    const root = document.getElementById("root");
    if (!root) return;
    const observer = new MutationObserver(() => { if (tryStart()) observer.disconnect(); });
    observer.observe(root, { attributes:true,childList: true, subtree: true,attributeFilter:["data-onboarding-ready"] });
    return () => observer.disconnect();
  }, [allFlag, canOpen, pageFlag, start]);

  useLayoutEffect(() => {
    if (!open || !currentStep) return;
    const element = document.querySelector<HTMLElement>(currentStep.target);
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    const update = () => {
      const rect = element.getBoundingClientRect();
      const padding = 8;
      const top = Math.max(8, rect.top - padding);
      const left = Math.max(8, rect.left - padding);
      setSpotlight({
        top,
        left,
        width: Math.min(window.innerWidth - left - 8, rect.width + padding * 2),
        height: Math.min(window.innerHeight - top - 8, rect.height + padding * 2),
      });
    };
    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [currentStep, open]);

  useEffect(() => {
    if (!open) return;
    const root = document.getElementById("root");
    const hadInert = root?.hasAttribute("inert") ?? false;
    const previousHidden = root?.getAttribute("aria-hidden");
    const previousOverflow = document.body.style.overflow;
    root?.setAttribute("inert", "");
    root?.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "hidden";
    return () => {
      if (!hadInert) root?.removeAttribute("inert");
      if (previousHidden == null) root?.removeAttribute("aria-hidden");
      else root?.setAttribute("aria-hidden", previousHidden);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => replayRef.current?.focus());
    };
  }, [open]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open, stepIndex]);

  const close = useCallback(() => setOpen(false), []);
  const previous = useCallback(() => setStepIndex((index) => Math.max(0, index - 1)), []);
  const next = useCallback(() => setStepIndex((index) => Math.min(steps.length - 1, index + 1)), [steps.length]);
  const completePage = useCallback(() => { saveFlag(pageFlag); close(); }, [close, pageFlag]);
  const skipAll = useCallback(() => { saveFlag(allFlag); close(); }, [allFlag, close]);
  const dismiss = useCallback(() => { dismissForSession(pageFlag); close(); }, [close, pageFlag]);

  useEffect(() => {
    if (!open) return;
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); previous(); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); stepIndex === steps.length - 1 ? completePage() : next(); return; }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')];
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (document.activeElement === dialog) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [completePage, dismiss, next, open, previous, stepIndex, steps.length]);

  const position = spotlight ? bubblePosition(spotlight) : null;
  return <>
    {canOpen ? <button ref={replayRef} type="button" className="onboarding-replay" onClick={start} aria-label="重播当前页面新手引导"><CircleHelp size={18} aria-hidden="true"/><span>新手教程</span></button> : null}
    {open && currentStep && spotlight && position ? createPortal(
      <div className="onboarding-layer" aria-live="polite">
        <div className="onboarding-spotlight" style={spotlight} aria-hidden="true"/>
        <section ref={focusDialog} tabIndex={-1} className="onboarding-bubble" style={position} role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description">
          <div className="onboarding-progress">第 {stepIndex + 1} / {steps.length} 步 · {PAGE_ROUTES[page].label}</div>
          <h2 id="onboarding-title">{currentStep.title}</h2>
          <p id="onboarding-description">{currentStep.description}</p>
          <div className="onboarding-secondary-actions">
            <button type="button" onClick={completePage}>跳过本页</button>
            <button type="button" onClick={skipAll}>跳过全部引导</button>
          </div>
          <div className="onboarding-primary-actions">
            <button type="button" onClick={previous} disabled={stepIndex === 0}>上一步</button>
            <button type="button" className="primary-action" onClick={stepIndex === steps.length - 1 ? completePage : next}>{stepIndex === steps.length - 1 ? "完成" : "下一步"}</button>
          </div>
          <small>← → 切换步骤，Esc 稍后再看（本次会话不再自动提示）</small>
        </section>
      </div>,
      document.body,
    ) : null}
  </>;
}
