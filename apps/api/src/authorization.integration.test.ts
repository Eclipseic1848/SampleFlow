import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";
import { resolvePerformanceAccess } from "./modules/authorization.js";

const { Client } = pg;
const TEST_ORIGIN = "http://127.0.0.1:4174";

function moneyCents(value: string): bigint {
  const sign = value.startsWith("-") ? -1n : 1n;
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  return sign * (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2)));
}

async function loginCookie(app: Parameters<Parameters<typeof withTestApi>[1]>[0], username: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: TEST_ORIGIN },
    payload: { username, password: "Role@123" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers["set-cookie"]).split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

test("人工录入阻断仅大小写空格或全半角不同的订单编号", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const headers = await loginWriteHeaders(app, "scope_assistant");
      const payload = {
        customerName: "疑似重复客户", customerUnit: "测试单位", businessRegionCode: "CN-JS",
        salespersonPersonId: scenario.people[scenario.users.alice], sourceReceivedOn: "2026-08-10",
        amount: 100, reason: "人工录入",
      };
      const first = await app.inject({ method: "POST", url: "/api/performance/orders", headers, payload: { ...payload, orderNo: "Case １２３" } });
      assert.equal(first.statusCode, 201, first.body);
      const variant = await app.inject({ method: "POST", url: "/api/performance/orders", headers, payload: { ...payload, orderNo: "case123" } });
      assert.equal(variant.statusCode, 409, variant.body);
      assert.match(variant.json().message, /疑似重复|已存在/);
    });
  });
});

async function loginWriteHeaders(app: Parameters<Parameters<typeof withTestApi>[1]>[0], username: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: TEST_ORIGIN },
    payload: { username, password: "Role@123" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setCookies = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"].map(String)
    : [String(response.headers["set-cookie"])];
  const cookies = setCookies.map((value) => value.split(";", 1)[0] ?? "");
  const csrfCookie = cookies.find((value) => value.startsWith("sampleflow_csrf="));
  assert.ok(csrfCookie);
  return {
    cookie: cookies.join("; "),
    origin: TEST_ORIGIN,
    "x-csrf-token": decodeURIComponent(csrfCookie.slice("sampleflow_csrf=".length)),
  };
}

async function seedAuthorizationScenario(databaseUrl: string) {
  const users = {
    admin: await seedTestUser(databaseUrl, { username: "scope_admin", displayName: "纯系统管理员", password: "Role@123", roleCode: "system_admin", roleName: "系统管理员" }),
    alice: await seedTestUser(databaseUrl, { username: "scope_alice", displayName: "业务员甲", password: "Role@123", roleCode: "salesperson", roleName: "业务员" }),
    bob: await seedTestUser(databaseUrl, { username: "scope_bob", displayName: "业务员乙", password: "Role@123", roleCode: "salesperson", roleName: "业务员" }),
    carol: await seedTestUser(databaseUrl, { username: "scope_carol", displayName: "业务员丙", password: "Role@123", roleCode: "salesperson", roleName: "业务员" }),
    leader: await seedTestUser(databaseUrl, { username: "scope_leader", displayName: "甲组组长", password: "Role@123", roleCode: "sales_leader", roleName: "业务员组长" }),
    supervisor: await seedTestUser(databaseUrl, { username: "scope_supervisor", displayName: "甲部主管", password: "Role@123", roleCode: "sales_supervisor", roleName: "业务主管" }),
    assistant: await seedTestUser(databaseUrl, { username: "scope_assistant", displayName: "销售助理", password: "Role@123", roleCode: "sales_assistant", roleName: "销售助理" }),
    assistantLeader: await seedTestUser(databaseUrl, { username: "scope_assistant_leader", displayName: "销售助理组长", password: "Role@123", roleCode: "sales_assistant_leader", roleName: "销售助理组长" }),
    manager: await seedTestUser(databaseUrl, { username: "scope_manager", displayName: "销售经理", password: "Role@123", roleCode: "sales_manager", roleName: "销售经理" }),
    hr: await seedTestUser(databaseUrl, { username: "scope_hr", displayName: "人事", password: "Role@123", roleCode: "hr", roleName: "人事部" }),
    generalManager: await seedTestUser(databaseUrl, { username: "scope_general_manager", displayName: "总经理", password: "Role@123", roleCode: "general_manager", roleName: "总经理" }),
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const peopleResult = await client.query<{ user_id:string; person_id:string }>(
      "select user_id::text,p.id::text as person_id from people p where user_id=any($1::bigint[])",
      [Object.values(users)],
    );
    const people = Object.fromEntries(peopleResult.rows.map((row) => [row.user_id, row.person_id])) as Record<string,string>;
    const departmentA = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('甲部','department') returning id::text");
    const departmentB = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('乙部','department') returning id::text");
    const groupA = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('甲组','group',$1) returning id::text", [departmentA.rows[0]!.id]);
    const groupB = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('乙组','group',$1) returning id::text", [departmentB.rows[0]!.id]);
    await client.query(
      `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
       values($1,$2,'leader','2026-01-01'),($3,$4,'supervisor','2026-01-01'),
             ($5,$6,'leader','2026-01-01'),($5,$7,'supervisor','2026-01-01')`,
      [people[users.leader], groupA.rows[0]!.id, people[users.supervisor], departmentA.rows[0]!.id,
       people[users.carol], groupB.rows[0]!.id, departmentB.rows[0]!.id],
    );
    await client.query(
      `insert into org_memberships(person_id,department_id,group_id,effective_from)
       values($1,$2,$3,'2026-01-01'),($4,$2,$3,'2026-01-01'),($5,$6,$7,'2026-01-01')`,
      [people[users.alice], departmentA.rows[0]!.id, groupA.rows[0]!.id, people[users.bob], people[users.carol], departmentB.rows[0]!.id, groupB.rows[0]!.id],
    );
    const orderIds: string[] = [];
    for (const [index, row] of [
      ["业务员甲", people[users.alice], departmentA.rows[0]!.id, "甲部", groupA.rows[0]!.id, "甲组", people[users.leader], "甲组组长", people[users.supervisor], "甲部主管"],
      ["业务员乙", people[users.bob], departmentA.rows[0]!.id, "甲部", groupA.rows[0]!.id, "甲组", people[users.leader], "甲组组长", people[users.supervisor], "甲部主管"],
      ["业务员丙", people[users.carol], departmentB.rows[0]!.id, "乙部", groupB.rows[0]!.id, "乙组", people[users.carol], "业务员丙", people[users.carol], "业务员丙"],
    ].entries()) {
      const order = await client.query<{ id: string }>(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values($1,$2,'测试单位',$3,$2,'2026-08-01',100,100,100,'active',now()) returning id::text`,
        [`SCOPE-${index + 1}`, row[0], row[1]],
      );
      orderIds.push(order.rows[0]!.id);
      await client.query(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
          salesperson_person_id,salesperson_name,department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         values($1,'initial',100,100,100,'2026-08-01','2026-08-01','权限测试',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [order.rows[0]!.id, row[1], row[0], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9]],
      );
    }
    const goalIds: string[] = [];
    for (const [index, ownerId] of [users.alice, users.bob, users.carol].entries()) {
      const goal = await client.query<{ id: string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id) values('2026-08-01','personal',$1,$2) returning id::text`,
        [ownerId, people[ownerId]],
      );
      goalIds.push(goal.rows[0]!.id);
      await client.query(
        `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
         values($1,1,$2,'active',$3,$4,'权限测试')`,
        [goal.rows[0]!.id, (index + 1) * 1000, users.admin, people[users.admin]],
      );
      if (index === 2) {
        await client.query(
          `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
           values($1,2,3500,'pending_hr',$2,$3,'范围外待审批测试')`,
          [goal.rows[0]!.id, users.admin, people[users.admin]],
        );
      }
    }
    return { users, people, orderIds, goalIds };
  } finally {
    await client.end();
  }
}

test("纯系统管理员没有业务读取或导出权限", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const cookie = await loginCookie(app, "scope_admin");
      for (const url of ["/api/performance/dashboard", "/api/performance/orders", "/api/exports/performance.csv"]) {
        const response = await app.inject({ method: "GET", url, headers: { cookie } });
        assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
      }
    });
  });
});

test("业绩写入只接受稳定人员标识并由服务端固化组织快照", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const headers = await loginWriteHeaders(app, "scope_assistant");
      const created = await app.inject({
        method: "POST",
        url: "/api/performance/orders",
        headers,
        payload: {
          orderNo: "STABLE-IDENTITY-1",
          customerName: "稳定身份客户",
          customerUnit: "测试单位",
          businessRegionCode: "CN-JS",
          salespersonPersonId: scenario.people[scenario.users.alice],
          sourceReceivedOn: "2026-08-10",
          amount: 500,
          reason: "稳定身份测试",
        },
      });
      assert.equal(created.statusCode, 201, created.body);

      const client = new Client({ connectionString: database.url });
      await client.connect();
      const snapshot = await client.query<{
        salesperson_person_id:string; department_name:string; group_name:string; leader_name:string; supervisor_name:string;
      }>(
        `select salesperson_person_id::text,department_name,group_name,leader_name,supervisor_name
         from performance_events where order_id=$1`,
        [created.json().id],
      );
      await client.end();
      assert.deepEqual(snapshot.rows[0], {
        salesperson_person_id: scenario.people[scenario.users.alice],
        department_name: "甲部",
        group_name: "甲组",
        leader_name: "甲组组长",
        supervisor_name: "甲部主管",
      });

      const forgedOrganization = await app.inject({
        method: "POST",
        url: "/api/performance/orders",
        headers,
        payload: {
          orderNo: "STABLE-IDENTITY-2",
          customerName: "伪造归属客户",
          customerUnit: "测试单位",
          businessRegionCode: "CN-JS",
          salespersonPersonId: scenario.people[scenario.users.alice],
          sourceReceivedOn: "2026-08-10",
          amount: 500,
          departmentName: "伪造部门",
        },
      });
      assert.equal(forgedOrganization.statusCode, 400, forgedOrganization.body);
    });
  });
});

test("同名人员不会跨稳定身份或组织范围泄漏业绩", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const twinUserId = await seedTestUser(database.url, {
      username:"scope_alice_twin",displayName:"业务员甲",password:"Role@123",roleCode:"salesperson",roleName:"业务员",
    });
    const client = new Client({ connectionString:database.url });
    await client.connect();
    try {
      const twin = await client.query<{id:string}>("select id::text from people where user_id=$1",[twinUserId]);
      const units = await client.query<{department_id:string;group_id:string}>(
        `select d.id::text as department_id,g.id::text as group_id from org_units d join org_units g on g.parent_id=d.id
         where d.name='乙部' and g.name='乙组'`,
      );
      await client.query(
        "insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",
        [twin.rows[0]!.id,units.rows[0]!.department_id,units.rows[0]!.group_id],
      );
      const order = await client.query<{id:string}>(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('SAME-NAME-OTHER','同名客户','测试单位',$1,'业务员甲','2026-08-01',900,900,900,'active',now()) returning id::text`,
        [twin.rows[0]!.id],
      );
      await client.query(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,department_unit_id,department_name,
           group_unit_id,group_name,leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         values($1,'initial',900,900,900,'2026-08-01','2026-08-01','同名隔离测试',$2,'业务员甲',$3,'乙部',$4,'乙组',$5,'业务员丙',$5,'业务员丙')`,
        [order.rows[0]!.id,twin.rows[0]!.id,units.rows[0]!.department_id,units.rows[0]!.group_id,scenario.people[scenario.users.carol]],
      );
    } finally {
      await client.end();
    }

    await withTestApi(database.url,async(app)=>{
      for (const [username,expected] of [["scope_alice",["SCOPE-1"]],["scope_leader",["SCOPE-1","SCOPE-2"]]] as const) {
        const cookie=await loginCookie(app,username);
        const response=await app.inject({method:"GET",url:"/api/performance/orders?limit=100",headers:{cookie}});
        assert.equal(response.statusCode,200,response.body);
        assert.deepEqual((response.json().orders as Array<{orderNo:string}>).map((order)=>order.orderNo).sort(),[...expected].sort());
      }
    });
  });
});

test("业务日期固定使用 Asia/Shanghai，不受数据库会话时区影响", async () => {
  await withMigratedTestDatabase(async (database) => {
    const userId = await seedTestUser(database.url,{ username:"timezone_leader",displayName:"时区组长",password:"Role@123",roleCode:"sales_leader",roleName:"业务员组长" });
    const pool = new pg.Pool({ connectionString:database.url,max:1 });
    try {
      const dates = await pool.query<{shanghai:string;minus12:string;plus14:string}>(
        `select (now() at time zone 'Asia/Shanghai')::date::text as shanghai,
                (now() at time zone 'Etc/GMT+12')::date::text as minus12,
                (now() at time zone 'Pacific/Kiritimati')::date::text as plus14`,
      );
      const row=dates.rows[0]!;
      const timezone=row.minus12!==row.shanghai?"Etc/GMT+12":"Pacific/Kiritimati";
      assert.notEqual(timezone==="Etc/GMT+12"?row.minus12:row.plus14,row.shanghai);
      await pool.query(`set time zone '${timezone}'`);
      const person=await pool.query<{id:string}>("select id::text from people where user_id=$1",[userId]);
      const department=await pool.query<{id:string}>("insert into org_units(name,unit_type) values('时区部','department') returning id::text");
      const group=await pool.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('时区组','group',$1) returning id::text",[department.rows[0]!.id]);
      await pool.query(
        "insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from,effective_to) values($1,$2,'leader',$3,$3)",
        [person.rows[0]!.id,group.rows[0]!.id,row.shanghai],
      );
      const access=await resolvePerformanceAccess(pool,{ id:userId,personId:person.rows[0]!.id,username:"timezone_leader",displayName:"时区组长",mustChangePassword:false,roles:["sales_leader"] });
      assert.deepEqual(access.groupIds,[group.rows[0]!.id]);
    } finally {
      await pool.end();
    }
  });
});

test("个人目标首页使用上海当前月并让汇总与正负事件按分对平", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,
           leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         select source.order_id,added.event_type,added.delta_amount,added.current_amount,added.current_amount,
                added.accounting_month::date,added.occurred_on::date,added.reason,
                source.salesperson_person_id,source.salesperson_name,
                source.department_unit_id,source.department_name,source.group_unit_id,source.group_name,
                source.leader_person_id,source.leader_name,source.supervisor_person_id,source.supervisor_name
         from performance_events source
         cross join (values
           ('revenue_change',-25::numeric,75::numeric,'2026-08-01','2026-08-15','负向调整'),
           ('revenue_change',999::numeric,1074::numeric,'2026-09-01','2026-09-01','未来月事件')
         ) added(event_type,delta_amount,current_amount,accounting_month,occurred_on,reason)
         where source.order_id=$1 and source.order_sequence=1`,
        [scenario.orderIds[0]],
      );
      for (const [periodMonth, amount, status] of [
        ["2026-07-01", 800, "active"],
        ["2026-06-01", 700, "pending_hr"],
        ["2026-05-01", 0, "active"],
        ["2026-09-01", 2000, "active"],
      ] as const) {
        const goal = await client.query<{ id: string }>(
          `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
           values($1,'personal',$2,$3) returning id::text`,
          [periodMonth, scenario.users.alice, scenario.people[scenario.users.alice]],
        );
        await client.query(
          `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
           values($1,1,$2,$3,$4,$5,'个人首页测试')`,
          [goal.rows[0]!.id, amount, status, scenario.users.admin, scenario.people[scenario.users.admin]],
        );
      }
    } finally {
      await client.end();
    }

    await withTestApi(database.url, async (app) => {
      const cookie = await loginCookie(app, "scope_alice");
      const sessionClient = new Client({ connectionString: database.url });
      await sessionClient.connect();
      try {
        await sessionClient.query("update sessions set expires_at=now()+interval '1 day',last_seen_at=now()");
      } finally {
        await sessionClient.end();
      }
      const current = await app.inject({ method: "GET", url: "/api/performance/dashboard", headers: { cookie } });
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.json().month, "2026-08");
      assert.deepEqual(
        current.json().personalAchievement,
        {
          goalId: scenario.goalIds[0],
          periodMonth: "2026-08",
          targetAmount: "1000.00",
          actualAmount: "75.00",
          gapAmount: "925.00",
          achievementRate: "7.50",
          timeProgressRate: "48.39",
          progressVariance: "-40.89",
          calculationReason: null,
          eventCount: 2,
        },
      );
      const drilldown = await app.inject({
        method: "GET",
        url: "/api/performance/personal-achievement/events?month=2026-08",
        headers: { cookie },
      });
      assert.equal(drilldown.statusCode, 200, drilldown.body);
      assert.equal(drilldown.json().actualAmount, current.json().personalAchievement.actualAmount);
      const { events: drilldownEvents, ...drilldownSummary } = drilldown.json();
      assert.deepEqual(drilldownSummary, current.json().personalAchievement);
      const events = drilldownEvents as Array<{ deltaAmount: string; accountingMonth: string }>;
      assert.deepEqual(events.map((event) => event.deltaAmount).sort(), ["-25.00", "100.00"]);
      assert.equal(events.reduce((sum, event) => sum + moneyCents(event.deltaAmount), 0n), moneyCents(drilldown.json().actualAmount));

      const history = await app.inject({ method: "GET", url: "/api/performance/dashboard?month=2026-07", headers: { cookie } });
      assert.equal(history.statusCode, 200, history.body);
      assert.deepEqual(
        {
          timeProgressRate: history.json().personalAchievement.timeProgressRate,
          achievementRate: history.json().personalAchievement.achievementRate,
          progressVariance: history.json().personalAchievement.progressVariance,
          calculationReason: history.json().personalAchievement.calculationReason,
        },
        { timeProgressRate: "100.00", achievementRate: "0.00", progressVariance: "-100.00", calculationReason: null },
      );

      for (const [month, reason] of [
        ["2026-09", "PERIOD_IN_FUTURE"],
        ["2026-06", "TARGET_NOT_ACTIVE"],
        ["2026-05", "TARGET_AMOUNT_NOT_POSITIVE"],
      ] as const) {
        const response = await app.inject({ method: "GET", url: `/api/performance/dashboard?month=${month}`, headers: { cookie } });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().personalAchievement.calculationReason, reason);
        assert.equal(response.json().personalAchievement.achievementRate, null);
        assert.equal(response.json().personalAchievement.gapAmount, null);
        assert.equal(response.json().personalAchievement.timeProgressRate, null);
        assert.equal(response.json().personalAchievement.progressVariance, null);
      }
      const future = await app.inject({ method: "GET", url: "/api/performance/dashboard?month=2026-09", headers: { cookie } });
      assert.equal(future.json().personalAchievement.timeProgressRate, null);
      assert.equal(future.json().personalAchievement.actualAmount, "999.00");

      const invalid = await app.inject({ method: "GET", url: "/api/performance/dashboard?month=2026-13", headers: { cookie } });
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal(invalid.json().code, "MONTH_INVALID");
    }, { clock: () => new Date("2026-08-14T16:30:00.000Z") });
  });
});

test("组长个人与小组业绩分离且成员订单事件逐级按分对平", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const units = await client.query<{ department_id: string; group_a_id: string; group_b_id: string }>(
      `select (select id::text from org_units where name='甲部' and unit_type='department') as department_id,
              (select id::text from org_units where name='甲组' and unit_type='group') as group_a_id,
              (select id::text from org_units where name='乙组' and unit_type='group') as group_b_id`,
    );
    const { department_id: departmentId, group_a_id: groupAId, group_b_id: groupBId } = units.rows[0]!;
    try {
      const leaderOrder = await client.query<{ id: string }>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('TEAM-LEADER-1','组长本人客户','测试单位',$1,'甲组组长','2026-08-10',40,40,40,'active',now())
         returning id::text`,
        [scenario.people[scenario.users.leader]],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,
           leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         values($1,'initial',40,40,40,'2026-08-01','2026-08-10','组长本人业绩',$2,'甲组组长',
                $3,'甲部',$4,'甲组',$2,'甲组组长',$5,'甲部主管')`,
        [leaderOrder.rows[0]!.id, scenario.people[scenario.users.leader], departmentId, groupAId, scenario.people[scenario.users.supervisor]],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,
           leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         select source.order_id,'revenue_change',-25,75,75,'2026-08-01','2026-08-15','小组负向调整',
                source.salesperson_person_id,source.salesperson_name,source.department_unit_id,source.department_name,
                source.group_unit_id,source.group_name,source.leader_person_id,source.leader_name,
                source.supervisor_person_id,source.supervisor_name
         from performance_events source where source.order_id=$1 and source.order_sequence=1`,
        [scenario.orderIds[0]],
      );
      const groupGoal = await client.query<{ id: string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,org_unit_id)
         values('2026-08-01','group',$1,$2,$3) returning id::text`,
        [scenario.users.leader, scenario.people[scenario.users.leader], groupAId],
      );
      const personalGoal = await client.query<{ id: string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         values('2026-08-01','personal',$1,$2) returning id::text`,
        [scenario.users.leader, scenario.people[scenario.users.leader]],
      );
      for (const [goalId, amount] of [[groupGoal.rows[0]!.id, 1000], [personalGoal.rows[0]!.id, 500]] as const) {
        await client.query(
          `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
           values($1,1,$2,'active',$3,$4,'小组首页测试')`,
          [goalId, amount, scenario.users.manager, scenario.people[scenario.users.manager]],
        );
      }
    } finally {
      await client.end();
    }

    await withTestApi(database.url, async (app) => {
      const leaderCookie = await loginCookie(app, "scope_leader");
      const aliceCookie = await loginCookie(app, "scope_alice");
      const sessionClient = new Client({ connectionString: database.url });
      await sessionClient.connect();
      try {
        await sessionClient.query("update sessions set expires_at=now()+interval '1 day',last_seen_at=now()");
      } finally {
        await sessionClient.end();
      }
      const dashboard = await app.inject({ method: "GET", url: "/api/performance/dashboard?month=2026-08", headers: { cookie: leaderCookie } });
      assert.equal(dashboard.statusCode, 200, dashboard.body);
      assert.equal(dashboard.json().personalAchievement.actualAmount, "40.00");
      assert.equal(dashboard.json().personalAchievement.targetAmount, "500.00");
      assert.equal(dashboard.json().personalAchievement.eventCount, 1);
      assert.deepEqual(dashboard.json().groupAchievements, [{
        groupId: groupAId,
        groupName: "甲组",
        memberCount: 3,
        goalId: dashboard.json().groupAchievements[0].goalId,
        periodMonth: "2026-08",
        targetAmount: "1000.00",
        actualAmount: "215.00",
        gapAmount: "785.00",
        achievementRate: "21.50",
        timeProgressRate: "48.39",
        progressVariance: "-26.89",
        calculationReason: null,
        eventCount: 4,
      }]);

      const details = await app.inject({
        method: "GET",
        url: `/api/performance/group-achievement/events?month=2026-08&groupId=${groupAId}`,
        headers: { cookie: leaderCookie },
      });
      assert.equal(details.statusCode, 200, details.body);
      const { members, ...detailSummary } = details.json();
      assert.deepEqual(detailSummary, dashboard.json().groupAchievements[0]);
      const memberRows = members as Array<{ actualAmount: string; orders: Array<{ actualAmount: string; events: Array<{ deltaAmount: string }> }> }>;
      const memberCents = memberRows.reduce((sum, member) => sum + moneyCents(member.actualAmount), 0n);
      const orderCents = memberRows.flatMap((member) => member.orders).reduce((sum, order) => sum + moneyCents(order.actualAmount), 0n);
      const eventRows = memberRows.flatMap((member) => member.orders.flatMap((order) => order.events));
      const eventCents = eventRows.reduce((sum, event) => sum + moneyCents(event.deltaAmount), 0n);
      assert.equal(memberCents, moneyCents(detailSummary.actualAmount));
      assert.equal(orderCents, memberCents);
      assert.equal(eventCents, memberCents);
      assert.deepEqual(memberRows.map((member) => member.actualAmount).sort(), ["100.00", "40.00", "75.00"]);
      assert.deepEqual(eventRows.map((event) => event.deltaAmount).sort(), ["-25.00", "100.00", "100.00", "40.00"]);
      assert.doesNotMatch(details.body, /业务员丙|SCOPE-3/);

      const deniedGroup = await app.inject({
        method: "GET",
        url: `/api/performance/group-achievement/events?month=2026-08&groupId=${groupBId}`,
        headers: { cookie: leaderCookie },
      });
      assert.equal(deniedGroup.statusCode, 403, deniedGroup.body);
      assert.equal(deniedGroup.json().code, "GROUP_SCOPE_FORBIDDEN");
      const deniedRole = await app.inject({
        method: "GET",
        url: `/api/performance/group-achievement/events?month=2026-08&groupId=${groupAId}`,
        headers: { cookie: aliceCookie },
      });
      assert.equal(deniedRole.statusCode, 403, deniedRole.body);
    }, { clock: () => new Date("2026-08-14T16:30:00.000Z") });
  });
});

test("多角色账号按稳定组织责任范围取并集且不扩大到无关组织", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario=await seedAuthorizationScenario(database.url);
    const client=new Client({connectionString:database.url});
    await client.connect();
    await client.query("insert into user_roles(user_id,role_code) values($1,'sales_leader')",[scenario.users.supervisor]);
    await client.query(
      `update org_responsibilities set person_id=$1
       where responsibility_type='leader' and org_unit_id=(select id from org_units where unit_type='group' and name='乙组')`,
      [scenario.people[scenario.users.supervisor]],
    );
    await client.end();
    await withTestApi(database.url,async(app)=>{
      const cookie=await loginCookie(app,"scope_supervisor");
      const orders=await app.inject({method:"GET",url:"/api/performance/orders?limit=100",headers:{cookie}});
      assert.equal(orders.statusCode,200,orders.body);
      assert.deepEqual((orders.json().orders as Array<{orderNo:string}>).map((order)=>order.orderNo).sort(),["SCOPE-1","SCOPE-2","SCOPE-3"]);
      const goals=await app.inject({method:"GET",url:"/api/goals",headers:{cookie}});
      assert.equal(goals.statusCode,200,goals.body);
      assert.deepEqual((goals.json().goals as Array<{ownerUsername:string}>).map((goal)=>goal.ownerUsername).sort(),["scope_alice","scope_bob","scope_carol"]);
    });
  });
});

test("人员跨组后对旧订单暂停，正负事件分别归属发生时组织", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "update org_memberships set effective_to='2026-08-31' where person_id=$1",
      [scenario.people[scenario.users.alice]],
    );
    await client.query(
      `insert into org_memberships(person_id,department_id,group_id,effective_from)
       select $1,d.id,g.id,'2026-09-01'
       from org_units d join org_units g on g.parent_id=d.id
       where d.name='乙部' and g.name='乙组'`,
      [scenario.people[scenario.users.alice]],
    );
    await client.end();

    await withTestApi(database.url, async (app) => {
      const headers = await loginWriteHeaders(app, "scope_assistant");
      const created = await app.inject({
        method:"POST", url:"/api/performance/orders", headers,
        payload:{
          orderNo:"TRANSFER-1", customerName:"跨组客户", customerUnit:"测试单位", businessRegionCode:"CN-JS",
          salespersonPersonId:scenario.people[scenario.users.alice], sourceReceivedOn:"2026-08-31",
          amount:100, reason:"转组前入账",
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const paused = await app.inject({
        method:"POST", url:`/api/performance/orders/${created.json().id}/events`, headers,
        payload:{ type:"pause", reason:"转组后暂停",idempotencyKey:"transfer-pause" },
      });
      assert.equal(paused.statusCode, 201, paused.body);

      const verification = new Client({ connectionString: database.url });
      await verification.connect();
      const totals = await verification.query<{ group_name:string; total:string }>(
        `select group_name,sum(delta_amount)::text as total from performance_events
         where order_id=$1 group by group_name order by group_name`,
        [created.json().id],
      );
      await verification.end();
      assert.deepEqual(totals.rows, [
        { group_name:"乙组", total:"-100.00" },
        { group_name:"甲组", total:"100.00" },
      ]);
    },{clock:()=>new Date("2026-09-01T01:00:00.000Z")});
  });
});

test("业务员、组长和主管只能读取本人、本组和本部门业绩", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const expectations = [
        ["scope_alice", ["业务员甲"]],
        ["scope_leader", ["业务员甲", "业务员乙"]],
        ["scope_supervisor", ["业务员甲", "业务员乙"]],
      ] as const;
      for (const [username, expectedNames] of expectations) {
        const cookie = await loginCookie(app, username);
        const response = await app.inject({ method: "GET", url: "/api/performance/orders?limit=100", headers: { cookie } });
        assert.equal(response.statusCode, 200, response.body);
        const names = (response.json().orders as Array<{ salespersonName: string }>).map((order) => order.salespersonName).sort();
        assert.deepEqual(names, [...expectedNames].sort());
        const dashboard = await app.inject({ method: "GET", url: "/api/performance/dashboard?month=2026-08", headers: { cookie } });
        assert.equal(dashboard.statusCode, 200, dashboard.body);
        assert.equal(Number(dashboard.json().metrics.total), expectedNames.length * 100);
        assert.equal(dashboard.json().metrics.pendingApprovals, 0);
      }

      const aliceCookie = await loginCookie(app, "scope_alice");
      const otherEvents = await app.inject({ method: "GET", url: `/api/performance/orders/${scenario.orderIds[1]}/events`, headers: { cookie: aliceCookie } });
      assert.equal(otherEvents.statusCode, 404);
      const aliceExport = await app.inject({ method: "GET", url: "/api/exports/performance.csv", headers: { cookie: aliceCookie } });
      assert.equal(aliceExport.statusCode, 200, aliceExport.body);
      assert.match(aliceExport.body, /业务员甲/);
      assert.doesNotMatch(aliceExport.body, /业务员乙|业务员丙/);
    });
  });
});

test("目标列表和导出按责任人的本人、小组、部门与全域范围过滤", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const expectations = [
        ["scope_admin", 403, []],
        ["scope_assistant", 403, []],
        ["scope_assistant_leader", 403, []],
        ["scope_alice", 200, ["业务员甲"]],
        ["scope_leader", 200, ["业务员甲", "业务员乙"]],
        ["scope_supervisor", 200, ["业务员甲", "业务员乙"]],
        ["scope_manager", 200, ["业务员甲", "业务员乙", "业务员丙"]],
        ["scope_hr", 200, ["业务员甲", "业务员乙", "业务员丙"]],
        ["scope_general_manager", 200, ["业务员甲", "业务员乙", "业务员丙"]],
      ] as const;
      for (const [username, status, expectedOwners] of expectations) {
        const cookie = await loginCookie(app, username);
        const goals = await app.inject({ method: "GET", url: "/api/goals", headers: { cookie } });
        assert.equal(goals.statusCode, status, `${username}: ${goals.body}`);
        if (status === 200) {
          const owners = (goals.json().goals as Array<{ ownerName: string }>).map((goal) => goal.ownerName).sort();
          assert.deepEqual(owners, [...expectedOwners].sort());
          const exported = await app.inject({ method: "GET", url: "/api/exports/goals.csv", headers: { cookie } });
          assert.equal(exported.statusCode, 200, exported.body);
          for (const owner of expectedOwners) assert.match(exported.body, new RegExp(owner));
          for (const owner of ["业务员甲", "业务员乙", "业务员丙"].filter((name) => !expectedOwners.includes(name as never))) {
            assert.doesNotMatch(exported.body, new RegExp(owner));
          }
        }
      }
    });
  });
});

test("全域业务角色可读取全公司业绩，人事可导出", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      for (const username of ["scope_assistant", "scope_assistant_leader", "scope_manager", "scope_hr", "scope_general_manager"]) {
        const cookie = await loginCookie(app, username);
        const orders = await app.inject({ method: "GET", url: "/api/performance/orders?limit=100", headers: { cookie } });
        assert.equal(orders.statusCode, 200, orders.body);
        assert.equal(orders.json().orders.length, 3);
        const dashboard = await app.inject({ method: "GET", url: "/api/performance/dashboard", headers: { cookie } });
        assert.equal(dashboard.statusCode, 200, dashboard.body);
        const expectedPending = username === "scope_hr" ? 1 : 0;
        assert.equal(dashboard.json().metrics.pendingApprovals, expectedPending, username);
      }
      const hrCookie = await loginCookie(app, "scope_hr");
      const exported = await app.inject({ method: "GET", url: "/api/exports/performance.csv", headers: { cookie: hrCookie } });
      assert.equal(exported.statusCode, 200, exported.body);
      assert.match(exported.body, /业务员甲/);
      assert.match(exported.body, /业务员丙/);
    });
  });
});

test("组织架构按责任范围过滤，系统管理员保留组织维护视图", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const expectations = [
        ["scope_admin", 3],
        ["scope_alice", 1],
        ["scope_leader", 2],
        ["scope_supervisor", 2],
        ["scope_assistant", 3],
        ["scope_manager", 3],
        ["scope_hr", 3],
        ["scope_general_manager", 3],
      ] as const;
      for (const [username, expectedAssignments] of expectations) {
        const cookie = await loginCookie(app, username);
        const response = await app.inject({ method: "GET", url: "/api/organization", headers: { cookie } });
        assert.equal(response.statusCode, 200, `${username}: ${response.body}`);
        assert.equal(response.json().assignments.length, expectedAssignments, username);
      }
    });
  });
});

test("现任负责人查看组织时不会获得成员调组前的历史范围",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedAuthorizationScenario(database.url);
    const leaderBUserId=await seedTestUser(database.url,{username:"scope_leader_b",displayName:"乙组组长",password:"Role@123",roleCode:"sales_leader",roleName:"业务员组长"});
    const client=new Client({connectionString:database.url});await client.connect();
    const current=await client.query<{today:string;yesterday:string}>("select (now() at time zone 'Asia/Shanghai')::date::text as today,((now() at time zone 'Asia/Shanghai')::date-1)::text as yesterday");
    const leaderB=await client.query<{id:string}>("select id::text from people where user_id=$1",[leaderBUserId]);
    const units=await client.query<{department_id:string;group_id:string}>("select d.id::text as department_id,g.id::text as group_id from org_units d join org_units g on g.parent_id=d.id where d.name='乙部' and g.name='乙组'");
    await client.query("update org_memberships set effective_to=$2 where person_id=$1",[scenario.people[scenario.users.alice],current.rows[0]!.yesterday]);
    await client.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,$4)",[scenario.people[scenario.users.alice],units.rows[0]!.department_id,units.rows[0]!.group_id,current.rows[0]!.today]);
    await client.query("update org_responsibilities set person_id=$1 where org_unit_id=$2 and responsibility_type='leader'",[leaderB.rows[0]!.id,units.rows[0]!.group_id]);
    await client.end();
    await withTestApi(database.url,async(app)=>{
      const cookie=await loginCookie(app,"scope_leader_b");
      const response=await app.inject({method:"GET",url:"/api/organization",headers:{cookie}});
      assert.equal(response.statusCode,200,response.body);
      const aliceAssignments=(response.json().assignments as Array<{displayName:string;departmentName:string;groupName:string}>).filter((item)=>item.displayName==="业务员甲");
      assert.equal(aliceAssignments.length,1);
      assert.equal(aliceAssignments[0]!.departmentName,"乙部");
      assert.equal(aliceAssignments[0]!.groupName,"乙组");
      assert.doesNotMatch(response.body,/甲部/);
    });
  });
});

test("账号管理接口返回与服务端授权同源的只读角色权限矩阵", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const cookie = await loginCookie(app, "scope_admin");
      const response = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } });
      assert.equal(response.statusCode, 200, response.body);
      const matrix = response.json().permissionMatrix as Array<{ code: string; businessScope: string; businessOperations:string[]; forbidden: string[] }>;
      assert.equal(matrix.find((role) => role.code === "system_admin")?.businessScope, "none");
      assert.ok(matrix.find((role) => role.code === "system_admin")?.forbidden.includes("业务查看与导出"));
      assert.equal(matrix.find((role) => role.code === "salesperson")?.businessScope, "self");
      assert.equal(matrix.find((role) => role.code === "sales_leader")?.businessScope, "group");
      assert.equal(matrix.find((role) => role.code === "sales_supervisor")?.businessScope, "department");
      assert.ok(matrix.find((role) => role.code === "sales_assistant_leader")?.businessOperations.includes("月度核对与关闭月更正"));
      assert.ok(matrix.find((role) => role.code === "hr")?.businessOperations.includes("记账期间关闭与更正审批"));
    });
  });
});

test("组织创建与任职写入保持未配置单元停用并记录审计",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedAuthorizationScenario(database.url);
    await withTestApi(database.url,async(app)=>{
      const headers=await loginWriteHeaders(app,"scope_admin");
      const department=await app.inject({method:"POST",url:"/api/admin/organization/units",headers,payload:{name:"审计部门",unitType:"department",parentId:null}});
      assert.equal(department.statusCode,201,department.body);
      const group=await app.inject({method:"POST",url:"/api/admin/organization/units",headers,payload:{name:"审计小组",unitType:"group",parentId:Number(department.json().id)}});
      assert.equal(group.statusCode,201,group.body);
      const before=new Client({connectionString:database.url});await before.connect();
      const inactive=await before.query<{active:string}>("select count(*) filter(where is_active)::text as active from org_units where id=any($1::bigint[])",[[department.json().id,group.json().id]]);
      await before.end();assert.equal(inactive.rows[0]!.active,"0");
      const assignment=await app.inject({
        method:"POST",url:"/api/admin/organization/assignments",headers,
        payload:{personId:scenario.people[scenario.users.assistant],departmentId:Number(department.json().id),groupId:Number(group.json().id),leaderPersonId:scenario.people[scenario.users.leader],supervisorPersonId:scenario.people[scenario.users.supervisor],effectiveFrom:"2026-09-01",effectiveTo:null},
      });
      assert.equal(assignment.statusCode,201,assignment.body);
      const verification=new Client({connectionString:database.url});await verification.connect();
      const evidence=await verification.query<{active:string;unit_created:string;responsibility_created:string;unit_activated:string;assignment_created:string}>(
        `select (select count(*) from org_units where id=any($1::bigint[]) and is_active)::text as active,
                (select count(*) from audit_logs where action='organization.unit_created')::text as unit_created,
                (select count(*) from audit_logs where action='organization.responsibility_created')::text as responsibility_created,
                (select count(*) from audit_logs where action='organization.unit_activated')::text as unit_activated,
                (select count(*) from audit_logs where action='organization.assignment_created')::text as assignment_created`,
        [[department.json().id,group.json().id]],
      );
      const activationAudits=await verification.query<{before_data:{isActive:boolean};after_data:{isActive:boolean}}>(
        `select before_data,after_data from audit_logs
         where action='organization.unit_activated' and entity_id=any($1::text[])
         order by entity_id`,
        [[String(department.json().id),String(group.json().id)]],
      );
      await verification.end();
      assert.deepEqual(evidence.rows[0],{active:"2",unit_created:"2",responsibility_created:"2",unit_activated:"2",assignment_created:"1"});
      assert.deepEqual(activationAudits.rows,[
        {before_data:{isActive:false},after_data:{isActive:true}},
        {before_data:{isActive:false},after_data:{isActive:true}},
      ]);
    });
  });
});

test("正式报表与导出仅使用已生效目标，且不阻断原始业绩账本", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const pendingGroupGoal = await client.query<{ id: string }>(
      `insert into goals(period_month,goal_level,owner_user_id,owner_person_id) values('2026-08-01','group',$1,$2) returning id::text`,
      [scenario.users.leader, scenario.people[scenario.users.leader]],
    );
    await client.query(
      `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
       values($1,1,2000,'pending_hr',$2,$3,'尚未生效的组目标')`,
      [pendingGroupGoal.rows[0]!.id, scenario.users.manager, scenario.people[scenario.users.manager]],
    );
    await client.end();
    const pendingGroupGoalId = pendingGroupGoal.rows[0]!.id;
    await withTestApi(database.url, async (app) => {
      const leaderCookie = await loginCookie(app, "scope_leader");
      const rawLedger = await app.inject({ method: "GET", url: "/api/performance/dashboard", headers: { cookie: leaderCookie } });
      assert.equal(rawLedger.statusCode, 200, rawLedger.body);

      for (const url of [
        `/api/performance/formal-reports/${pendingGroupGoalId}`,
        `/api/exports/formal-reports/${pendingGroupGoalId}.csv`,
      ]) {
        const blocked = await app.inject({ method: "GET", url, headers: { cookie: leaderCookie } });
        assert.equal(blocked.statusCode, 409, `${url}: ${blocked.body}`);
        assert.equal(blocked.json().code, "TARGET_NOT_ACTIVE");
      }

      const aliceCookie = await loginCookie(app, "scope_alice");
      const activeReport = await app.inject({
        method: "GET",
        url: `/api/performance/formal-reports/${scenario.goalIds[0]}`,
        headers: { cookie: aliceCookie },
      });
      assert.equal(activeReport.statusCode, 200, activeReport.body);
      assert.deepEqual(activeReport.json(), {
        goalId: scenario.goalIds[0],
        periodMonth: "2026-08",
        level: "personal",
        ownerName: "业务员甲",
        targetAmount: "1000.00",
        actualAmount: "100.00",
        achievementRate: "10.00",
      });

      const activeExport = await app.inject({
        method: "GET",
        url: `/api/exports/formal-reports/${scenario.goalIds[0]}.csv`,
        headers: { cookie: aliceCookie },
      });
      assert.equal(activeExport.statusCode, 200, activeExport.body);
      assert.match(activeExport.body, /正式业绩报表/);
      assert.match(activeExport.body, /10\.00%/);

      const adminCookie = await loginCookie(app, "scope_admin");
      const adminDenied = await app.inject({
        method: "GET",
        url: `/api/performance/formal-reports/${scenario.goalIds[0]}`,
        headers: { cookie: adminCookie },
      });
      assert.equal(adminDenied.statusCode, 403, adminDenied.body);

      const hrCookie = await loginCookie(app, "scope_hr");
      const hrReport = await app.inject({
        method: "GET",
        url: `/api/performance/formal-reports/${scenario.goalIds[0]}`,
        headers: { cookie: hrCookie },
      });
      assert.equal(hrReport.statusCode, 200, hrReport.body);
    });
  });
});

test("兼管多个小组的责任人未绑定目标组织时不得合并生成正式报表", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario=await seedAuthorizationScenario(database.url);
    const client=new Client({connectionString:database.url});
    await client.connect();
    const goal=await client.query<{id:string}>(
      `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
       values('2026-08-01','group',$1,$2) returning id::text`,
      [scenario.users.leader,scenario.people[scenario.users.leader]],
    );
    await client.query(
      `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
       values($1,1,2000,'active',$2,$3,'多范围阻断测试')`,
      [goal.rows[0]!.id,scenario.users.manager,scenario.people[scenario.users.manager]],
    );
    await client.query(
      `update org_responsibilities set person_id=$1
       where responsibility_type='leader' and org_unit_id=(select id from org_units where unit_type='group' and name='乙组')`,
      [scenario.people[scenario.users.leader]],
    );
    await client.end();
    await withTestApi(database.url,async(app)=>{
      const cookie=await loginCookie(app,"scope_leader");
      const response=await app.inject({method:"GET",url:`/api/performance/formal-reports/${goal.rows[0]!.id}`,headers:{cookie}});
      assert.equal(response.statusCode,409,response.body);
      assert.equal(response.json().code,"REPORT_SCOPE_UNRESOLVED");
    });
  });
});

test("组长目标范围不包含上级主管", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const supervisorGoal = await client.query<{ id: string }>(
      `insert into goals(period_month,goal_level,owner_user_id,owner_person_id) values('2026-08-01','department',$1,$2) returning id::text`,
      [scenario.users.supervisor, scenario.people[scenario.users.supervisor]],
    );
    await client.query(
      `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
       values($1,1,5000,'active',$2,$3,'主管目标范围测试')`,
      [supervisorGoal.rows[0]!.id, scenario.users.manager, scenario.people[scenario.users.manager]],
    );
    await client.end();

    await withTestApi(database.url, async (app) => {
      const leaderCookie = await loginCookie(app, "scope_leader");
      const goals = await app.inject({ method: "GET", url: "/api/goals", headers: { cookie: leaderCookie } });
      assert.equal(goals.statusCode, 200, goals.body);
      assert.doesNotMatch(goals.body, /甲部主管/);
      const report = await app.inject({
        method: "GET",
        url: `/api/performance/formal-reports/${supervisorGoal.rows[0]!.id}`,
        headers: { cookie: leaderCookie },
      });
      assert.equal(report.statusCode, 404, report.body);
    });
  });
});

test("审批待办仅返回当前用户可执行的节点", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedAuthorizationScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const expectations = [
        ["scope_manager", 200, 0],
        ["scope_general_manager", 200, 0],
        ["scope_hr", 200, 1],
        ["scope_alice", 200, 0],
        ["scope_assistant", 403, 0],
      ] as const;
      for (const [username, status, count] of expectations) {
        const cookie = await loginCookie(app, username);
        const response = await app.inject({ method: "GET", url: "/api/goals?pendingOnly=true", headers: { cookie } });
        assert.equal(response.statusCode, status, `${username}: ${response.body}`);
        if (status === 200) assert.equal(response.json().goals.length, count, username);
      }
    });
  });
});
