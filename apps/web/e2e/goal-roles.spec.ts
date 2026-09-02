import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

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
  await page.getByRole("button", { name: "目标管理", exact: true }).click();
  await page.getByRole("button", { name: "下达目标" }).click();

  await expect(page.getByLabel("目标层级").locator("option")).toHaveText([
    "销售经理总目标",
    "部门目标",
    "小组目标",
    "个人目标",
  ]);
});
