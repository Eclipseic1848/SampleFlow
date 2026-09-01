export const PAGE_ROUTES = {
  overview: { label: "业绩总览", capability: "viewPerformance" },
  goals: { label: "目标管理", capability: "viewGoals" },
  orders: { label: "订单业绩", capability: "viewPerformance" },
  analysis: { label: "业绩分析", capability: "viewPerformance" },
  organization: { label: "组织架构", capability: "viewOrganization" },
  approvals: { label: "审批中心", capability: "viewApprovals" },
  audits: { label: "审计查询", capability: "viewAudits" },
  accounts: { label: "账号管理", capability: "manageAccounts" },
} as const;

export type PageId = keyof typeof PAGE_ROUTES;
export const PAGE_ORDER = Object.keys(PAGE_ROUTES) as PageId[];

export function readPageId(search: string): PageId | null {
  const page = new URLSearchParams(search).get("page");
  return page && Object.hasOwn(PAGE_ROUTES, page) ? page as PageId : null;
}
