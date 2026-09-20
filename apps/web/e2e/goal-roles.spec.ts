import pg from "pg";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

test("纯总经理可下达目标，销售经理确认后人事终审，桌面和手机入口均可用", async ({ database, page }) => {
  await seedTestUser(database.url,{username:"gm_issuer",displayName:"下达总经理",password:"Goals@123",roleCode:"general_manager",roleName:"总经理"});
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const login=async(username:string)=>{await page.goto("/");await page.getByLabel("账号",{exact:true}).fill(username);await page.getByLabel("密码",{exact:true}).fill("Goals@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();await page.getByRole("link",{name:"目标管理",exact:true}).click();};
  const logout=async()=>{await page.getByRole("button",{name:"退出登录"}).click();await expect(page.getByRole("heading",{name:"登录系统"})).toBeVisible();};
  await login("gm_issuer");await page.getByRole("button",{name:"下达目标",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByText("暂无可选销售经理，请联系管理员启用账号并配置销售经理角色。",{exact:true})).toBeVisible();
  await expect(dialog.getByRole("button",{name:"提交待确认"})).toBeDisabled();
  await dialog.getByRole("button",{name:"取消",exact:true}).click();
  await seedTestUser(database.url,{username:"gm_target_owner",displayName:"责任销售经理",password:"Goals@123",roleCode:"sales_manager",roleName:"销售经理"});
  await seedTestUser(database.url,{username:"gm_target_hr",displayName:"终审人事",password:"Goals@123",roleCode:"hr",roleName:"人事部"});
  await page.getByRole("button",{name:"下达目标",exact:true}).click();
  await expect(page.getByLabel("目标层级").locator("option")).toHaveText(["销售经理总目标"]);
  await expect(page.getByLabel("目标责任人")).toBeEnabled();
  await expect(dialog).toContainText("总经理下达 → 销售经理确认 → 人事审核后生效");
  await page.getByLabel("目标月份").fill("2026-09");await page.getByLabel("目标金额").fill("1300000");
  await expect(page.getByLabel("目标责任人").locator("option:checked")).toHaveText("责任销售经理");
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    await expect(dialog.getByRole("button",{name:"提交待确认"})).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({path:join(tmpdir(),`sampleflow-gm-goal-${width}.png`)});
  }
  await page.setViewportSize({width:1280,height:900});
  await dialog.getByRole("button",{name:"提交待确认"}).click();await expect(dialog).toHaveCount(0);
  await expect(page.getByText("总经理下达 · 确认后交人事审核",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"批准",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"确认目标",exact:true})).toHaveCount(0);
  await logout();await login("gm_target_owner");
  await page.getByRole("button",{name:"确认目标",exact:true}).click();
  await expect(dialog).toContainText("确认后提交人事审核，审核通过后才生效");
  await dialog.getByRole("button",{name:"确认目标",exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button",{name:"批准",exact:true})).toHaveCount(0);
  await logout();await login("gm_target_hr");
  await page.getByRole("link",{name:"审批中心",exact:true}).click();
  await page.getByRole("button",{name:"批准",exact:true}).click();
  await expect(dialog).toContainText("下达人：下达总经理");
  await expect(dialog).toContainText("无需总经理重复审批");
  await page.getByLabel("审批意见").fill("已核对下达金额与责任人确认，同意生效");
  await dialog.getByRole("button",{name:"确认批准",exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(page.getByText("当前没有待确认或待审批目标。",{exact:true})).toBeVisible();
  await page.getByRole("link",{name:"目标管理",exact:true}).click();
  await expect(page.getByRole("button",{name:"查看正式报表",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"查看正式报表",exact:true}).click();
  await expect(dialog).toContainText("¥1,300,000.00");
  expect(errors).toEqual([]);
});

test("多角色账号可选择全部合法目标下达层级", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_multi_role_goals",
    displayName: "E2E 多角色目标负责人",
    password: "Goals@123",
    roleCode: "sales_manager",
    roleName: "销售经理",
  });
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    await client.query(
      `insert into roles(code,name) values('sales_supervisor','业务主管'),('sales_leader','业务员组长')
       on conflict(code) do update set name=excluded.name`,
    );
    await client.query(
      "insert into user_roles(user_id,role_code) values($1,'sales_supervisor'),($1,'sales_leader')",
      [userId],
    );
  } finally {
    await client.end();
  }

  await page.route("**/api/goals/options?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: '{"parentGoals":[],"owners":[]}',
  }));
  await page.goto("/");
  await page.getByLabel("账号").fill("e2e_multi_role_goals");
  await page.getByLabel("密码", { exact: true }).fill("Goals@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
  await page.getByRole("link", { name: "目标管理", exact: true }).click();
  await page.getByRole("button", { name: "下达目标" }).click();

  await expect(page.getByLabel("目标层级").locator("option")).toHaveText([
    "销售经理总目标",
    "部门目标",
    "小组目标",
    "个人目标",
  ]);
});
