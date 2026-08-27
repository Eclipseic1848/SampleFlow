import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { withMigratedTestDatabase } from "../../api/src/test-support/test-database.js";

const apiRoot = fileURLToPath(new URL("../../api/", import.meta.url));
const { Client } = pg;
const apiPort=process.env.SAMPLEFLOW_E2E_API_PORT;
const webPort=process.env.SAMPLEFLOW_E2E_WEB_PORT;
if(!apiPort||!webPort)throw new Error("缺少隔离 E2E 端口");
const apiBaseUrl=`http://127.0.0.1:${apiPort}`;
const webBaseUrl=`http://127.0.0.1:${webPort}`;

async function waitForApi(url: string, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exited()) throw new Error("测试 API 在就绪前退出");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // API 尚未监听时继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待测试 API 就绪超时");
}

test("销售助理可通过真实 API 登录", async ({ page }) => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "e2e_sales_assistant",
      displayName: "E2E 销售助理",
      password: "E2ePass@123",
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        API_PORT: apiPort,
        APP_ORIGINS: webBaseUrl,
        DATABASE_URL: database.url,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      const guestResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/me"));
      await page.goto("/");
      expect((await guestResponse).status()).toBe(401);
      await expect(page.getByRole("heading", { name: "登录系统" })).toBeVisible();
      await page.getByLabel("账号").fill("e2e_sales_assistant");
      await page.getByLabel("密码").fill("E2ePass@123");

      const loginResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/auth/login") && response.request().method() === "POST"
      );
      const dashboardResponse = page.waitForResponse((response) =>
        response.url().includes("/api/performance/dashboard")
      );
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();
      expect((await loginResponse).status()).toBe(200);
      expect((await dashboardResponse).status()).toBe(200);
      await expect(page.getByRole("heading", { name: "业绩账本总览" })).toBeVisible();
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});

test("首次登录用户看到密码强度并完成改密", async ({ page }) => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "e2e_password_change",
      displayName: "E2E 首次改密用户",
      password: "Before@123",
      mustChangePassword: true,
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        API_PORT: apiPort,
        APP_ORIGINS: webBaseUrl,
        DATABASE_URL: database.url,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_password_change");
      await page.getByLabel("密码").fill("Before@123");
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();

      await expect(page.getByRole("heading", { name: "请修改初始密码" })).toBeVisible();
      await expect(page.getByText("6—128 位，并包含英文字母、数字和符号")).toBeVisible();
      await page.getByLabel("当前密码").fill("Before@123");
      await page.getByLabel("新密码").fill("Abc@12");
      await expect(page.getByText("密码强度：弱")).toBeVisible();
      const dashboardResponse = page.waitForResponse((response) =>
        response.url().includes("/api/performance/dashboard") && response.status() === 200
      );
      await page.getByRole("button", { name: "保存新密码" }).click();
      await dashboardResponse;
      await expect(page.getByRole("heading", { name: "业绩账本总览" })).toBeVisible();
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});

test("系统管理员在账号管理页查看只读角色权限说明", async ({ page }) => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "e2e_system_admin",
      displayName: "E2E 系统管理员",
      password: "Admin@123",
      roleCode: "system_admin",
      roleName: "系统管理员",
    });

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        API_PORT: apiPort,
        APP_ORIGINS: webBaseUrl,
        DATABASE_URL: database.url,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_system_admin");
      await page.getByLabel("密码").fill("Admin@123");
      const accountsResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/users"));
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();

      expect((await accountsResponse).status()).toBe(200);
      await expect(page.getByRole("button", { name: "账号管理" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("button", { name: "业绩总览" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "订单业绩" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "目标管理" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "角色权限说明" })).toBeVisible();
      await expect(page.getByText("多角色账号取各角色权限并集；系统管理员角色本身不增加业务权限")).toBeVisible();

      const administratorRow = page.getByRole("row").filter({ hasText: "系统管理员" }).last();
      await expect(administratorRow).toContainText("无业务范围");
      await expect(administratorRow).toContainText("业务查看与导出");
      const salespersonRow = page.getByRole("row").filter({ hasText: "业务员" }).last();
      await expect(salespersonRow).toContainText("仅本人");

      const matrixScroller = page.locator(".permission-matrix-card .orders-table-wrap");
      expect(await matrixScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});

test("目标未生效时页面不提供正式报表，生效后才可查看", async ({ page }) => {
  await withMigratedTestDatabase(async (database) => {
    const userId = await seedTestUser(database.url, {
      username: "e2e_salesperson_report",
      displayName: "E2E 业务员",
      password: "Report@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `with owner as (
         select id as person_id from people where user_id=$1
       ), active_goal as (
         insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         select '2026-08-01','personal',$1,person_id from owner returning id
       ), pending_goal as (
         insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         select '2026-09-01','personal',$1,person_id from owner returning id
       )
       insert into goal_versions(goal_id,version_no,amount,status,created_by,change_reason)
       select id,1,1000,'active',$1,'浏览器门禁测试' from active_goal
       union all
       select id,1,2000,'pending_hr',$1,'浏览器门禁测试' from pending_goal`,
      [userId],
    );
    await client.end();

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: { ...process.env, API_PORT: apiPort, APP_ORIGINS:webBaseUrl, DATABASE_URL: database.url, NODE_ENV: "test" },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_salesperson_report");
      await page.getByLabel("密码").fill("Report@123");
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();
      await page.getByRole("button", { name: "目标管理" }).click();

      const pendingRow = page.getByRole("row").filter({ hasText: "2026-09" });
      await expect(pendingRow).toContainText("待人事审批");
      await expect(pendingRow.getByRole("button", { name: "查看正式报表" })).toHaveCount(0);

      const activeRow = page.getByRole("row").filter({ hasText: "2026-08" });
      const reportResponse = page.waitForResponse((response) => response.url().includes("/api/performance/formal-reports/") && response.status() === 200);
      await activeRow.getByRole("button", { name: "查看正式报表" }).click();
      await reportResponse;
      await expect(page.getByRole("heading", { name: "正式业绩报表" })).toBeVisible();
      await expect(page.getByText("目标已生效，达成率按该层级目标独立计算")).toBeVisible();
      await expect(page.getByRole("dialog").getByText("¥1,000.00", { exact: true })).toBeVisible();
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});

test("订单搜索与不可变事件链在浏览器和数据库中保持一致", async ({ page },testInfo) => {
  test.slow();
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "e2e_ledger_assistant",
      displayName: "E2E 账本销售助理",
      password: "Ledger@123",
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });
    await seedTestUser(database.url, {
      username: "e2e_accounting_leader",
      displayName: "E2E 销售助理组长",
      password: "Ledger@123",
      roleCode: "sales_assistant_leader",
      roleName: "销售助理组长",
    });
    await seedTestUser(database.url, {
      username: "e2e_accounting_hr",
      displayName: "E2E 人事",
      password: "Ledger@123",
      roleCode: "hr",
      roleName: "人事部",
    });
    const memberUserId=await seedTestUser(database.url, {
      username: "e2e_ledger_member",
      displayName: "E2E 账本业务员",
      password: "Ledger@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const leaderUserId=await seedTestUser(database.url, {
      username: "e2e_ledger_leader",
      displayName: "E2E 账本组长",
      password: "Ledger@123",
      roleCode: "sales_leader",
      roleName: "业务员组长",
    });
    const supervisorUserId=await seedTestUser(database.url, {
      username: "e2e_ledger_supervisor",
      displayName: "E2E 账本主管",
      password: "Ledger@123",
      roleCode: "sales_supervisor",
      roleName: "业务主管",
    });
    const setup=new Client({connectionString:database.url});await setup.connect();
    try{
      const people=await setup.query<{user_id:string;id:string}>("select user_id::text,p.id::text from people p where user_id=any($1::bigint[])",[[memberUserId,leaderUserId,supervisorUserId]]);
      const personId=(userId:string)=>people.rows.find((row)=>row.user_id===userId)!.id;
      const department=await setup.query<{id:string}>("insert into org_units(name,unit_type) values('E2E 账本部门','department') returning id::text");
      const group=await setup.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('E2E 账本小组','group',$1) returning id::text",[department.rows[0]!.id]);
      await setup.query(`insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$3,'leader','2026-01-01'),($2,$4,'supervisor','2026-01-01')`,[personId(leaderUserId),personId(supervisorUserId),group.rows[0]!.id,department.rows[0]!.id]);
      await setup.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[personId(memberUserId),department.rows[0]!.id,group.rows[0]!.id]);
      await setup.query("update org_units set is_active=true where id=any($1::bigint[])",[[department.rows[0]!.id,group.rows[0]!.id]]);
    }finally{await setup.end();}

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: { ...process.env, API_PORT: apiPort, APP_ORIGINS:webBaseUrl, DATABASE_URL: database.url, NODE_ENV: "test" },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_ledger_assistant");
      await page.getByLabel("密码").fill("Ledger@123");
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();
      await page.getByRole("button", { name: "订单业绩", exact:true }).click();

      await page.getByRole("button", { name: "录入新订单" }).click();
      await page.getByLabel("订单编号").fill("CHAIN-E2E-110");
      await page.getByLabel("客户名称").fill("事件链客户");
      await page.getByLabel("客户单位").fill("事件链测试单位");
      await page.getByLabel("业务员").selectOption({label:"E2E 账本业务员"});
      await page.getByLabel("服务类型").fill("浏览器验收");
      await page.getByLabel("营业额").fill("110");
      await page.getByRole("button", { name: "确认入账" }).click();
      const orderRow=page.getByRole("row").filter({hasText:"CHAIN-E2E-110"});
      await expect(orderRow).toBeVisible();

      await page.getByLabel("定位订单").fill("CHAIN-E2E-110");
      await expect(page).toHaveURL(/orderSearch=CHAIN-E2E-110/);
      await expect(orderRow).toBeVisible();
      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await expect(page.getByRole("heading",{name:"不可变事件链"})).toBeVisible();
      await expect(page.getByLabel("事件发生日期")).toHaveCount(0);
      await expect(page.locator(".event-summary b")).toHaveText(["+¥110.00"]);
      await page.getByLabel("调整后营业额").fill("100");
      await page.getByLabel("原因（必填）").fill("浏览器改单为 100");
      await page.getByRole("button",{name:"确认追加事件"}).click();

      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await page.getByRole("button",{name:"整单暂停"}).click();
      await page.getByLabel("原因（必填）").fill("浏览器整单暂停");
      await page.getByRole("button",{name:"确认追加事件"}).click();

      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await expect(page.getByRole("button",{name:"整单暂停"})).toHaveCount(0);
      await page.getByLabel("原因（必填）").fill("浏览器订单重启");
      await page.getByRole("button",{name:"确认追加事件"}).click();

      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await expect(page.locator(".event-summary b")).toHaveText(["+¥110.00","-¥10.00","-¥100.00","+¥100.00"]);
      await expect(page.getByText(/组长 E2E 账本组长 · 主管 E2E 账本主管/).first()).toBeVisible();
      await page.screenshot({path:testInfo.outputPath("event-chain.png"),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      const dialog=page.getByRole("dialog");
      const dialogBox=await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.x+dialogBox!.width).toBeLessThanOrEqual(390);
      await page.screenshot({path:testInfo.outputPath("event-chain-narrow.png"),fullPage:true});
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(orderRow.getByRole("button",{name:"查看 / 调整"})).toBeFocused();

      await page.setViewportSize({width:1280,height:900});
      await page.getByRole("button",{name:"退出登录"}).click();
      await page.getByLabel("账号").fill("e2e_accounting_leader");
      await page.getByLabel("密码").fill("Ledger@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      await expect(page.getByRole("heading",{name:"记账治理工作台"})).toBeVisible();
      await page.getByLabel("记账月份").fill("2026-07");
      await page.getByLabel("核对说明").fill("七月数据浏览器核对完成");
      await page.getByRole("button",{name:"提交核对确认"}).click();
      await expect(page.getByText("操作已记录并刷新。")).toBeVisible();

      await page.getByRole("button",{name:"退出登录"}).click();
      await page.getByLabel("账号").fill("e2e_accounting_hr");
      await page.getByLabel("密码").fill("Ledger@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      await page.getByLabel("记账月份").fill("2026-07");
      await page.getByLabel("关账说明").fill("七月浏览器关账");
      await page.getByRole("button",{name:"关闭记账期间"}).click();
      await expect(page.getByText(/已关闭 · 版本 1/)).toBeVisible();

      await page.getByRole("button",{name:"退出登录"}).click();
      await page.getByLabel("账号").fill("e2e_accounting_leader");
      await page.getByLabel("密码").fill("Ledger@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      const correctionForm=page.getByRole("heading",{name:"申请关闭月更正"}).locator("..");
      await correctionForm.locator("select").first().selectOption({label:"CHAIN-E2E-110 · 事件链客户"});
      await correctionForm.getByLabel("原业务日期").fill("2026-07-15");
      await correctionForm.getByLabel("申请原因").fill("浏览器更正申请");
      await correctionForm.getByRole("button",{name:"提交更正申请"}).click();
      await expect(page.getByText(/CHAIN-E2E-110 · 营业额修改/)).toBeVisible();

      await page.getByRole("button",{name:"退出登录"}).click();
      await page.getByLabel("账号").fill("e2e_accounting_hr");
      await page.getByLabel("密码").fill("Ledger@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      await page.getByLabel("审批意见").fill("同意浏览器更正");
      await page.getByRole("button",{name:"批准",exact:true}).click();
      await expect(page.getByText(/approved/)).toBeVisible();

      const evidence=new Client({connectionString:database.url});await evidence.connect();
      try{
        const result=await evidence.query<{delta_amount:string;order_sequence:number}>(`select e.delta_amount::text,e.order_sequence from performance_events e join performance_orders o on o.id=e.order_id where o.qingflow_order_no='CHAIN-E2E-110' order by e.order_sequence`);
        expect(result.rows.map((row)=>Number(row.delta_amount))).toEqual([110,-10,-100,100]);
        expect(result.rows.map((row)=>row.order_sequence)).toEqual([1,2,3,4]);
      }finally{await evidence.end();}
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});
