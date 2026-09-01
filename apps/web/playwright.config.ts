import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    browserName: "chromium",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  },
  projects: [
    {
      name: "desktop-1280",
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: "desktop-1024",
      grep: /业务员默认查看当前月个人目标并穿透正负业绩事件|订单组合筛选由 URL 恢复并区分空集、失败和无权限|业绩分析页显示事件快照地区、外贸、客户单位和待补齐对账|系统管理员搜索分页账号并审计固定角色组合变更|桌面关键页面无横向溢出且操作可达/,
      use: { viewport: { width: 1024, height: 800 } },
    },
  ],
});
