import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function shiftMonth(periodMonth: string, offset: number): string {
  const [year, month] = periodMonth.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

test("业务员默认查看当前月个人目标并穿透正负业绩事件", async ({ database, page }) => {
  const today = shanghaiToday();
  const periodMonth = today.slice(0, 7);
  const seeded = new Map<string, { target: number; actual: number; rate: string }>();
  const userId = await seedTestUser(database.url, {
    username: "e2e_personal_dashboard",
    displayName: "E2E 个人看板业务员",
    password: "Dashboard@123",
    roleCode: "salesperson",
    roleName: "业务员",
  });
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    const person = await client.query<{ id: string }>("select id::text from people where user_id=$1", [userId]);
    const personId = person.rows[0]!.id;
    for (const [offset, month] of [-1, 0, 1].map((offset) => [offset, shiftMonth(periodMonth, offset)] as const)) {
      const target = 1000 + offset * 100;
      const actual = target - 250;
      seeded.set(month, { target, actual, rate: (actual * 100 / target).toFixed(2) });
      const goal = await client.query<{ id: string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         values($1,'personal',$2,$3) returning id::text`,
        [`${month}-01`, userId, personId],
      );
      await client.query(
        `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
         values($1,1,$2,'active',$3,$4,'E2E 个人目标')`,
        [goal.rows[0]!.id, target, userId, personId],
      );
      const order = await client.query<{ id: string }>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values($1,'E2E 看板客户','E2E 看板单位',$2,'E2E 个人看板业务员',
                $3,$4,$5,$5,'active',now()) returning id::text`,
        [`P1-PERSONAL-${month}`, personId, `${month}-01`, target, actual],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_name,group_name,leader_name,supervisor_name)
         values($1,'initial',$5,$5,$5,$2,$3,'首次计入',$4,'E2E 个人看板业务员',
                'E2E 看板部','E2E 看板组','E2E 看板组长','E2E 看板主管'),
               ($1,'revenue_change',-250,$6,$6,$2,$3,'金额调减',$4,'E2E 个人看板业务员',
                'E2E 看板部','E2E 看板组','E2E 看板组长','E2E 看板主管')`,
        [order.rows[0]!.id, `${month}-01`, `${month}-01`, personId, target, actual],
      );
    }
  } finally {
    await client.end();
  }

  await page.goto("/");
  await page.getByLabel("账号").fill("e2e_personal_dashboard");
  await page.getByLabel("密码", { exact: true }).fill("Dashboard@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();

  await expect(page.getByRole("heading", { name: "业绩账本总览" })).toBeVisible();
  const subtitle = page.locator(".dashboard > header p");
  await expect(subtitle).toContainText("个人目标与不可变业绩事件");
  const selected = (await subtitle.textContent())?.match(/(\d{4}) 年 (\d{2}) 月/)?.slice(1).join("-");
  expect(selected).toBeTruthy();
  expect([periodMonth, shanghaiToday().slice(0, 7)]).toContain(selected);
  const expected = seeded.get(selected!);
  expect(expected).toBeTruthy();
  const personal = page.getByRole("region", { name: "个人目标达成" });
  await expect(personal.getByText(`¥${expected!.target.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, { exact: true })).toBeVisible();
  await expect(personal.getByText("¥250.00", { exact: true })).toBeVisible();
  await expect(personal.getByText(`${expected!.rate}%`, { exact: true })).toBeVisible();
  const currentDate = shanghaiToday();
  const currentMonth = currentDate.slice(0, 7);
  const progress = selected! < currentMonth ? 100 : Number((Number(currentDate.slice(8, 10)) / new Date(Number(currentDate.slice(0, 4)), Number(currentDate.slice(5, 7)), 0).getDate() * 100).toFixed(2));
  await expect(personal.locator(".metric").filter({ hasText: "自然日进度" }).getByText(`${progress.toFixed(2)}%`, { exact: true })).toBeVisible();
  await expect(personal.locator(".metric").filter({ hasText: "进度偏差" }).getByText(`${(Number(expected!.rate)-progress).toFixed(2)}%`, { exact: true })).toBeVisible();
  const actual = personal.getByRole("button", { name: "查看个人业绩构成" });
  await expect(actual).toHaveText(`¥${expected!.actual.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  await actual.click();

  const details = page.getByRole("dialog", { name: "个人业绩构成" });
  await expect(details.getByText(`2 条事件 · 净额 ¥${expected!.actual.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, { exact: true })).toBeVisible();
  await expect(details.getByText(`P1-PERSONAL-${selected}`, { exact: true })).toHaveCount(2);
  await expect(details.getByText(`正向 ¥${expected!.target.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, { exact: true })).toBeVisible();
  await expect(details.getByText("负向 ¥250.00", { exact: true })).toBeVisible();
  await expect(details.getByText("分析维度待补齐", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "关闭" }).click();
  await personal.getByRole("button", { name: "查看个人差距构成" }).click();
  const gap = page.getByRole("dialog", { name: "个人差距构成" });
  await expect(gap.getByText(`目标 ¥${expected!.target.toLocaleString("en-US", { minimumFractionDigits: 2 })} − 事件净额 ¥${expected!.actual.toLocaleString("en-US", { minimumFractionDigits: 2 })} = 差距 ¥250.00`, { exact: true })).toBeVisible();
});

test("纯组长同时查看本人和小组并穿透组员订单事件", async ({ database, page }) => {
  const periodMonth = shanghaiToday().slice(0, 7);
  const users = {
    leader: await seedTestUser(database.url, { username: "e2e_team_leader", displayName: "E2E 甲组长", password: "Dashboard@123", roleCode: "sales_leader", roleName: "业务员组长" }),
    memberA: await seedTestUser(database.url, { username: "e2e_team_member_a", displayName: "E2E 组员甲", password: "Dashboard@123", roleCode: "salesperson", roleName: "业务员" }),
    memberB: await seedTestUser(database.url, { username: "e2e_team_member_b", displayName: "E2E 组员乙", password: "Dashboard@123", roleCode: "salesperson", roleName: "业务员" }),
    outsider: await seedTestUser(database.url, { username: "e2e_team_outsider", displayName: "E2E 外组人员", password: "Dashboard@123", roleCode: "salesperson", roleName: "业务员" }),
  };
  const expectedByMonth = new Map<string, { groupTarget: number; personalTarget: number; personalActual: number; groupActual: number; groupRate: string }>();
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    const people = await client.query<{ user_id: string; person_id: string }>("select user_id::text,id::text as person_id from people where user_id=any($1::bigint[])", [Object.values(users)]);
    const person = Object.fromEntries(people.rows.map((row) => [row.user_id, row.person_id])) as Record<string, string>;
    const departmentA = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('E2E 甲部','department') returning id::text");
    const departmentB = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('E2E 乙部','department') returning id::text");
    const groupA = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('E2E 甲组','group',$1) returning id::text", [departmentA.rows[0]!.id]);
    const groupB = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('E2E 乙组','group',$1) returning id::text", [departmentB.rows[0]!.id]);
    const groupC = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('E2E 兼管组','group',$1) returning id::text", [departmentA.rows[0]!.id]);
    await client.query(
      `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
        values($1,$2,'leader','2026-01-01'),($3,$4,'leader','2026-01-01'),
              ($1,$5,'supervisor','2026-01-01'),($3,$6,'supervisor','2026-01-01'),
              ($1,$7,'leader','2026-01-01')`,
      [person[users.leader], groupA.rows[0]!.id, person[users.outsider], groupB.rows[0]!.id, departmentA.rows[0]!.id, departmentB.rows[0]!.id, groupC.rows[0]!.id],
    );
    await client.query(
      `insert into org_memberships(person_id,department_id,group_id,effective_from)
       values($1,$3,$4,'2026-01-01'),($2,$3,$4,'2026-01-01'),($5,$6,$7,'2026-01-01')`,
      [person[users.memberA], person[users.memberB], departmentA.rows[0]!.id, groupA.rows[0]!.id, person[users.outsider], departmentB.rows[0]!.id, groupB.rows[0]!.id],
    );

    for (const [offset, month] of [0, 1].map((offset) => [offset, shiftMonth(periodMonth, offset)] as const)) {
      const groupTarget = 1000 + offset * 100;
      const personalTarget = 500 + offset * 100;
      const leaderAmount = 40 + offset * 10;
      const memberAAmount = 100 + offset * 10;
      const memberBAmount = 80 + offset * 10;
      const groupActual = leaderAmount + memberAAmount - 25 + memberBAmount;
      expectedByMonth.set(month, { groupTarget, personalTarget, personalActual: leaderAmount, groupActual, groupRate: (groupActual * 100 / groupTarget).toFixed(2) });
      const groupGoal = await client.query<{ id: string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,org_unit_id)
         values($1,'group',$2,$3,$4) returning id::text`,
        [`${month}-01`, users.leader, person[users.leader], groupA.rows[0]!.id],
      );
      const secondaryGroupGoal = await client.query<{ id: string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,org_unit_id)
         values($1,'group',$2,$3,$4) returning id::text`,
        [`${month}-01`, users.leader, person[users.leader], groupC.rows[0]!.id],
      );
      const personalGoal = await client.query<{ id: string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         values($1,'personal',$2,$3) returning id::text`,
        [`${month}-01`, users.leader, person[users.leader]],
      );
      for (const [goalId, amount] of [[groupGoal.rows[0]!.id, groupTarget], [secondaryGroupGoal.rows[0]!.id, 300 + offset * 10], [personalGoal.rows[0]!.id, personalTarget]] as const) {
        await client.query(
          `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
           values($1,1,$2,'active',$3,$4,'E2E 小组首页')`,
          [goalId, amount, users.leader, person[users.leader]],
        );
      }

      for (const order of [
        { suffix: "LEADER", customer: "组长客户", userId: users.leader, name: "E2E 甲组长", amount: leaderAmount, departmentId: departmentA.rows[0]!.id, departmentName: "E2E 甲部", groupId: groupA.rows[0]!.id, groupName: "E2E 甲组", leaderId: person[users.leader], leaderName: "E2E 甲组长", adjustment: 0 },
        { suffix: "A", customer: "组员甲客户", userId: users.memberA, name: "E2E 组员甲", amount: memberAAmount, departmentId: departmentA.rows[0]!.id, departmentName: "E2E 甲部", groupId: groupA.rows[0]!.id, groupName: "E2E 甲组", leaderId: person[users.leader], leaderName: "E2E 甲组长", adjustment: -25 },
        { suffix: "B", customer: "组员乙客户", userId: users.memberB, name: "E2E 组员乙", amount: memberBAmount, departmentId: departmentA.rows[0]!.id, departmentName: "E2E 甲部", groupId: groupA.rows[0]!.id, groupName: "E2E 甲组", leaderId: person[users.leader], leaderName: "E2E 甲组长", adjustment: 0 },
        { suffix: "OUTSIDE", customer: "外组客户", userId: users.outsider, name: "E2E 外组人员", amount: 999, departmentId: departmentB.rows[0]!.id, departmentName: "E2E 乙部", groupId: groupB.rows[0]!.id, groupName: "E2E 乙组", leaderId: person[users.outsider], leaderName: "E2E 外组人员", adjustment: 0 },
      ]) {
        const finalAmount = order.amount + order.adjustment;
        const inserted = await client.query<{ id: string }>(
          `insert into performance_orders
            (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
             source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
           values($1,$2,'E2E 测试单位',$3,$4,$5,$6,$7,$7,'active',now()) returning id::text`,
          [`TEAM-${month}-${order.suffix}`, order.customer, person[order.userId], order.name, `${month}-01`, order.amount, finalAmount],
        );
        await client.query(
          `insert into performance_events
            (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
             accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
             department_unit_id,department_name,group_unit_id,group_name,
             leader_person_id,leader_name,supervisor_person_id,supervisor_name)
           values($1,'initial',$2,$2,$2,$3,$3,'首次计入',$4,$5,$6,$7,$8,$9,$10,$11,$10,$11)`,
          [inserted.rows[0]!.id, order.amount, `${month}-01`, person[order.userId], order.name, order.departmentId, order.departmentName, order.groupId, order.groupName, order.leaderId, order.leaderName],
        );
        if (order.adjustment < 0) {
          await client.query(
            `insert into performance_events
              (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
               accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
               department_unit_id,department_name,group_unit_id,group_name,
               leader_person_id,leader_name,supervisor_person_id,supervisor_name)
             values($1,'revenue_change',$2,$3,$3,$4,$4,'金额调减',$5,$6,$7,$8,$9,$10,$11,$12,$11,$12)`,
            [inserted.rows[0]!.id, order.adjustment, finalAmount, `${month}-01`, person[order.userId], order.name, order.departmentId, order.departmentName, order.groupId, order.groupName, order.leaderId, order.leaderName],
          );
        }
      }
    }
  } finally {
    await client.end();
  }

  await page.goto("/");
  await page.getByLabel("账号").fill("e2e_team_leader");
  await page.getByLabel("密码", { exact: true }).fill("Dashboard@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
  const subtitle = page.locator(".dashboard > header p");
  await expect(subtitle).toContainText("个人目标与不可变业绩事件");
  const selected = (await subtitle.textContent())?.match(/(\d{4}) 年 (\d{2}) 月/)?.slice(1).join("-");
  expect([periodMonth, shanghaiToday().slice(0, 7)]).toContain(selected);
  const expected = expectedByMonth.get(selected!);
  expect(expected).toBeTruthy();
  const money = (value: number) => `¥${value.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  const personal = page.getByRole("region", { name: "个人目标达成" });
  await expect(personal.getByText(money(expected!.personalTarget), { exact: true })).toBeVisible();
  await expect(personal.getByRole("button", { name: "查看个人业绩构成" })).toHaveText(money(expected!.personalActual));
  await personal.getByRole("button", { name: "查看个人业绩构成" }).click();
  await expect(page.getByRole("dialog", { name: "个人业绩构成" }).getByText(`1 条事件 · 净额 ${money(expected!.personalActual)}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  const team = page.getByRole("article", { name: "E2E 甲组目标达成" });
  await expect(team.getByText(money(expected!.groupTarget), { exact: true })).toBeVisible();
  await expect(team.getByText(money(expected!.groupTarget - expected!.groupActual), { exact: true })).toBeVisible();
  await expect(team.getByText(`${expected!.groupRate}%`, { exact: true })).toBeVisible();
  const teamActual = team.getByRole("button", { name: "查看E2E 甲组业绩构成" });
  await expect(teamActual).toHaveText(money(expected!.groupActual));
  await teamActual.click();
  const details = page.getByRole("dialog", { name: "E2E 甲组 · 小组业绩构成" });
  await expect(details.getByText(`3 位事件责任人 · 4 条事件 · 净额 ${money(expected!.groupActual)}`, { exact: true })).toBeVisible();
  await expect(details.getByRole("heading", { name: "E2E 甲组长", exact: true })).toBeVisible();
  await expect(details.getByRole("heading", { name: "E2E 组员甲", exact: true })).toBeVisible();
  await expect(details.getByRole("heading", { name: "E2E 组员乙", exact: true })).toBeVisible();
  await expect(details.getByText(`TEAM-${selected}-A`, { exact: false })).toBeVisible();
  await expect(details.getByText("负向 ¥25.00", { exact: true })).toBeVisible();
  await expect(details.getByText("E2E 外组人员", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭" }).click();
  await team.getByRole("button", { name: "查看E2E 甲组差距构成" }).click();
  const gap = page.getByRole("dialog", { name: "E2E 甲组 · 小组差距构成" });
  await expect(gap.getByText(`目标 ${money(expected!.groupTarget)} − 事件净额 ${money(expected!.groupActual)} = 差距 ${money(expected!.groupTarget - expected!.groupActual)}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  let releaseFirstRequest=()=>{};
  let firstRequestStarted=()=>{};
  let firstRequestUrl="";
  let blockFirst=true;
  const firstStarted=new Promise<void>((resolve)=>{firstRequestStarted=resolve;});
  const firstRelease=new Promise<void>((resolve)=>{releaseFirstRequest=resolve;});
  await page.route("**/api/performance/group-achievement/events?*",async(route)=>{
    if(blockFirst){blockFirst=false;firstRequestUrl=route.request().url();firstRequestStarted();await firstRelease;}
    await route.continue();
  });
  await teamActual.click();
  await page.locator('article[aria-label="E2E 兼管组目标达成"] button[aria-label="查看E2E 兼管组业绩构成"]').evaluate((button:HTMLButtonElement)=>button.click());
  await firstStarted;
  const staleResponse=page.waitForResponse(firstRequestUrl);
  const secondaryDetails=page.getByRole("dialog", { name: "E2E 兼管组 · 小组业绩构成" });
  await expect(secondaryDetails.getByText("0 位事件责任人 · 0 条事件 · 净额 ¥0.00", { exact: true })).toBeVisible();
  releaseFirstRequest();
  await staleResponse;
  await expect(secondaryDetails).toBeVisible();
  await expect(secondaryDetails.getByRole("heading", { name: "E2E 组员甲", exact: true })).toHaveCount(0);
});

test("主管和销售经理从部门及销售组织逐级穿透到正负事件", async ({ database, page }) => {
  const periodMonth = shanghaiToday().slice(0, 7);
  const users = {
    supervisor: await seedTestUser(database.url, { username:"e2e_department_supervisor",displayName:"E2E 看板主管",password:"Dashboard@123",roleCode:"sales_supervisor",roleName:"业务主管" }),
    leader: await seedTestUser(database.url, { username:"e2e_department_leader",displayName:"E2E 看板组长",password:"Dashboard@123",roleCode:"sales_leader",roleName:"业务员组长" }),
    memberA: await seedTestUser(database.url, { username:"e2e_department_member_a",displayName:"E2E 部门成员甲",password:"Dashboard@123",roleCode:"salesperson",roleName:"业务员" }),
    memberB: await seedTestUser(database.url, { username:"e2e_department_member_b",displayName:"E2E 部门成员乙",password:"Dashboard@123",roleCode:"salesperson",roleName:"业务员" }),
    outsider: await seedTestUser(database.url, { username:"e2e_department_outsider",displayName:"E2E 外部门人员",password:"Dashboard@123",roleCode:"salesperson",roleName:"业务员" }),
    manager: await seedTestUser(database.url, { username:"e2e_sales_manager",displayName:"E2E 销售经理",password:"Dashboard@123",roleCode:"sales_manager",roleName:"销售经理" }),
  };
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    const peopleResult = await client.query<{user_id:string;person_id:string}>("select user_id::text,id::text as person_id from people where user_id=any($1::bigint[])",[Object.values(users)]);
    const people = Object.fromEntries(peopleResult.rows.map((row)=>[row.user_id,row.person_id])) as Record<string,string>;
    const departmentA = await client.query<{id:string}>("insert into org_units(name,unit_type) values('E2E 看板甲部','department') returning id::text");
    const departmentB = await client.query<{id:string}>("insert into org_units(name,unit_type) values('E2E 看板乙部','department') returning id::text");
    const groupA = await client.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('E2E 看板甲组','group',$1) returning id::text",[departmentA.rows[0]!.id]);
    const groupB = await client.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('E2E 看板乙组','group',$1) returning id::text",[departmentB.rows[0]!.id]);
    await client.query(
      `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
       values($1,$2,'leader','2026-01-01'),($3,$4,'supervisor','2026-01-01'),
             ($5,$6,'leader','2026-01-01'),($5,$7,'supervisor','2026-01-01')`,
      [people[users.leader],groupA.rows[0]!.id,people[users.supervisor],departmentA.rows[0]!.id,
       people[users.outsider],groupB.rows[0]!.id,departmentB.rows[0]!.id],
    );
    await client.query(
      `insert into org_memberships(person_id,department_id,group_id,effective_from)
       values($1,$3,$4,'2026-01-01'),($2,$3,$4,'2026-01-01'),($5,$6,$7,'2026-01-01')`,
      [people[users.memberA],people[users.memberB],departmentA.rows[0]!.id,groupA.rows[0]!.id,
       people[users.outsider],departmentB.rows[0]!.id,groupB.rows[0]!.id],
    );
    const addOrder = async ({orderNo,customerName,personId,personName,departmentId,departmentName,groupId,groupName,leaderId,leaderName,supervisorId,supervisorName,amount,adjustment=0}:{orderNo:string;customerName:string;personId:string;personName:string;departmentId:string;departmentName:string;groupId:string;groupName:string;leaderId:string;leaderName:string;supervisorId:string;supervisorName:string;amount:number;adjustment?:number}) => {
      const finalAmount=amount+adjustment;
      const order=await client.query<{id:string}>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values($1,$2,'E2E 看板单位',$3,$4,$5,$6,$7,$7,'active',now()) returning id::text`,
        [orderNo,customerName,personId,personName,`${periodMonth}-01`,amount,finalAmount],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,
           leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         values($1,'initial',$2,$2,$2,$3,$3,'首次计入',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [order.rows[0]!.id,amount,`${periodMonth}-01`,personId,personName,departmentId,departmentName,groupId,groupName,leaderId,leaderName,supervisorId,supervisorName],
      );
      if(adjustment!==0){await client.query(
        `insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,
           leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         values($1,'revenue_change',$2,$3,$3,$4,$5,'金额调减',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [order.rows[0]!.id,adjustment,finalAmount,`${periodMonth}-01`,`${periodMonth}-02`,personId,personName,departmentId,departmentName,groupId,groupName,leaderId,leaderName,supervisorId,supervisorName],
      );}
    };
    await addOrder({orderNo:"DEPARTMENT-A",customerName:"部门客户甲",personId:people[users.memberA]!,personName:"E2E 部门成员甲",departmentId:departmentA.rows[0]!.id,departmentName:"E2E 看板甲部",groupId:groupA.rows[0]!.id,groupName:"E2E 看板甲组",leaderId:people[users.leader]!,leaderName:"E2E 看板组长",supervisorId:people[users.supervisor]!,supervisorName:"E2E 看板主管",amount:100,adjustment:-25});
    await addOrder({orderNo:"DEPARTMENT-B",customerName:"部门客户乙",personId:people[users.memberB]!,personName:"E2E 部门成员乙",departmentId:departmentA.rows[0]!.id,departmentName:"E2E 看板甲部",groupId:groupA.rows[0]!.id,groupName:"E2E 看板甲组",leaderId:people[users.leader]!,leaderName:"E2E 看板组长",supervisorId:people[users.supervisor]!,supervisorName:"E2E 看板主管",amount:100});
    await addOrder({orderNo:"DEPARTMENT-SUPERVISOR",customerName:"主管本人客户",personId:people[users.supervisor]!,personName:"E2E 看板主管",departmentId:departmentA.rows[0]!.id,departmentName:"E2E 看板甲部",groupId:groupA.rows[0]!.id,groupName:"E2E 看板甲组",leaderId:people[users.leader]!,leaderName:"E2E 看板组长",supervisorId:people[users.supervisor]!,supervisorName:"E2E 看板主管",amount:40});
    await addOrder({orderNo:"DEPARTMENT-OUTSIDE",customerName:"外部门客户",personId:people[users.outsider]!,personName:"E2E 外部门人员",departmentId:departmentB.rows[0]!.id,departmentName:"E2E 看板乙部",groupId:groupB.rows[0]!.id,groupName:"E2E 看板乙组",leaderId:people[users.outsider]!,leaderName:"E2E 外部门人员",supervisorId:people[users.outsider]!,supervisorName:"E2E 外部门人员",amount:100});
    const root=await client.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id) values($1,'sales_manager',$2,$3) returning id::text",[`${periodMonth}-01`,users.manager,people[users.manager]]);
    const goalDepartmentA=await client.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id) values($1,'department',$2,$3,$4,$5) returning id::text",[`${periodMonth}-01`,users.supervisor,people[users.supervisor],root.rows[0]!.id,departmentA.rows[0]!.id]);
    const goalDepartmentB=await client.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id) values($1,'department',$2,$3,$4,$5) returning id::text",[`${periodMonth}-01`,users.outsider,people[users.outsider],root.rows[0]!.id,departmentB.rows[0]!.id]);
    const goalGroupA=await client.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id) values($1,'group',$2,$3,$4,$5) returning id::text",[`${periodMonth}-01`,users.leader,people[users.leader],goalDepartmentA.rows[0]!.id,groupA.rows[0]!.id]);
    const personal=await client.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id) values($1,'personal',$2,$3) returning id::text",[`${periodMonth}-01`,users.supervisor,people[users.supervisor]]);
    for(const[goalId,amount,status]of[[root.rows[0]!.id,500,"active"],[goalDepartmentA.rows[0]!.id,250,"active"],[goalDepartmentB.rows[0]!.id,200,"pending_hr"],[goalGroupA.rows[0]!.id,200,"active"],[personal.rows[0]!.id,500,"active"]]as const){await client.query("insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason) values($1,1,$2,$3,$4,$5,'E2E 部门看板')",[goalId,amount,status,users.manager,people[users.manager]]);}
  } finally { await client.end(); }

  const login=async(username:string)=>{await page.goto("/");await page.getByLabel("账号").fill(username);await page.getByLabel("密码",{exact:true}).fill("Dashboard@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();};
  const money=(value:number)=>`¥${value.toLocaleString("en-US",{minimumFractionDigits:2})}`;
  await login("e2e_department_supervisor");
  await expect(page.locator(".dashboard > header p")).toContainText("个人、部门目标与不可变业绩事件");
  const personal=page.getByRole("region",{name:"个人目标达成"});
  await expect(personal.getByRole("button",{name:"查看个人业绩构成"})).toHaveText(money(40));
  const department=page.getByRole("article",{name:"部门目标达成 · E2E 看板甲部"});
  await expect(department.getByText(money(250),{exact:true})).toBeVisible();
  await expect(department.getByText("86.00%",{exact:true})).toBeVisible();
  await department.getByRole("button",{name:"查看部门业绩构成"}).click();
  const departmentDialog=page.getByRole("dialog",{name:"E2E 看板甲部 · 部门业绩构成"});
  await expect(departmentDialog.getByText(`4 条事件 · 净额 ${money(215)}`,{exact:true})).toBeVisible();
  await expect(departmentDialog.getByRole("heading",{name:"E2E 看板甲组",exact:true})).toBeVisible();
  await expect(departmentDialog.getByRole("heading",{name:"E2E 部门成员甲",exact:true})).toBeVisible();
  await expect(departmentDialog.getByText("DEPARTMENT-A · 部门客户甲",{exact:false})).toBeVisible();
  await expect(departmentDialog.getByText("负向 ¥25.00",{exact:true})).toBeVisible();
  await expect(departmentDialog.getByText("E2E 外部门人员",{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"关闭"}).click();
  await page.getByRole("button",{name:"退出登录"}).click();

  await login("e2e_sales_manager");
  const sales=page.getByRole("article",{name:"销售组织目标达成"});
  await expect(sales.getByText(money(500),{exact:true})).toBeVisible();
  await expect(sales.getByRole("button",{name:"查看销售组织业绩构成"})).toHaveText(money(315));
  const inactiveDepartment=page.getByRole("article",{name:"部门目标达成 · E2E 看板乙部"});
  await expect(inactiveDepartment.getByText("部门目标尚未生效",{exact:true}).first()).toBeVisible();
  await expect(inactiveDepartment.getByText("不计算",{exact:true})).toHaveCount(4);
  await sales.getByRole("button",{name:"查看销售组织业绩构成"}).click();
  const salesDialog=page.getByRole("dialog",{name:"销售组织 · 业绩构成"});
  await expect(salesDialog.getByText(`5 条事件 · 净额 ${money(315)}`,{exact:true})).toBeVisible();
  await expect(salesDialog.getByRole("heading",{name:"E2E 看板甲部",exact:true})).toBeVisible();
  await expect(salesDialog.getByRole("heading",{name:"E2E 看板乙部",exact:true})).toBeVisible();
  await expect(salesDialog.getByText("E2E 外部门人员",{exact:true})).toBeVisible();
});
