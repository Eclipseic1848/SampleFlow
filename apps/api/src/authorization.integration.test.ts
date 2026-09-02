import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { buildApp } from "./app.js";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";
import { resolvePerformanceAccess } from "./modules/authorization.js";
import { ORGANIZATION_ACHIEVEMENT_SQL } from "./modules/performance.js";
import { businessDate } from "./domain/business-time.js";

const { Client, Pool } = pg;
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
        customerName: "疑似重复客户", customerUnit: "测试单位", businessRegionSourceText:"江苏原文", businessRegionCode: "CN-JS",
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
          businessRegionSourceText: "江苏原文",
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
          businessRegionSourceText: "江苏原文",
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
    const successorUser = await seedTestUser(database.url, { username: "scope_successor", displayName: "甲组新组长", password: "Role@123", roleCode: "sales_leader", roleName: "业务员组长" });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const successor = await client.query<{ person_id: string }>("select id::text as person_id from people where user_id=$1", [successorUser]);
    const successorPersonId = successor.rows[0]!.person_id;
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
          select source.order_id,'revenue_change',-25,75,75,'2026-08-01','2026-08-15','跨业务员负向调整',
                 $2,'业务员乙',source.department_unit_id,source.department_name,
                 source.group_unit_id,source.group_name,source.leader_person_id,source.leader_name,
                 source.supervisor_person_id,source.supervisor_name
          from performance_events source where source.order_id=$1 and source.order_sequence=1`,
        [scenario.orderIds[0], scenario.people[scenario.users.bob]],
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

      const successorCookie = await loginCookie(app, "scope_successor");
      const transferClient = new Client({ connectionString: database.url });
      await transferClient.connect();
      try {
        await transferClient.query(
          "update org_responsibilities set person_id=$1 where org_unit_id=$2 and responsibility_type='leader'",
          [successorPersonId, groupAId],
        );
        await transferClient.query("update sessions set expires_at=now()+interval '1 day',last_seen_at=now()");
      } finally {
        await transferClient.end();
      }
      const transferredDashboard = await app.inject({ method: "GET", url: "/api/performance/dashboard?month=2026-08", headers: { cookie: successorCookie } });
      assert.equal(transferredDashboard.statusCode, 200, transferredDashboard.body);
      assert.equal(transferredDashboard.json().groupAchievements[0].targetAmount, "1000.00");
      assert.equal(transferredDashboard.json().groupAchievements[0].actualAmount, "215.00");
      const transferredDetails = await app.inject({
        method: "GET",
        url: `/api/performance/group-achievement/events?month=2026-08&groupId=${groupAId}`,
        headers: { cookie: successorCookie },
      });
      assert.equal(transferredDetails.statusCode, 200, transferredDetails.body);
      assert.equal(transferredDetails.json().targetAmount, "1000.00");
    }, { clock: () => new Date("2026-08-14T16:30:00.000Z") });
  });
});

test("主管与全域角色按部门和销售组织逐级穿透且每层按分对平", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const units = await client.query<{ department_a_id:string;department_b_id:string;group_a_id:string;group_b_id:string }>(
      `select (select id::text from org_units where name='甲部' and unit_type='department') as department_a_id,
              (select id::text from org_units where name='乙部' and unit_type='department') as department_b_id,
              (select id::text from org_units where name='甲组' and unit_type='group') as group_a_id,
              (select id::text from org_units where name='乙组' and unit_type='group') as group_b_id`,
    );
    const { department_a_id: departmentAId, department_b_id: departmentBId, group_a_id: groupAId } = units.rows[0]!;
    try {
      const supervisorOrder = await client.query<{ id:string }>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('DEPARTMENT-SUPERVISOR-1','主管本人客户','测试单位',$1,'甲部主管',
                '2026-08-10',40,40,40,'active',now()) returning id::text`,
        [scenario.people[scenario.users.supervisor]],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,
           leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         values($1,'initial',40,40,40,'2026-08-01','2026-08-10','主管本人业绩',$2,'甲部主管',
                $3,'甲部',$4,'甲组',$5,'甲组组长',$2,'甲部主管')`,
        [supervisorOrder.rows[0]!.id, scenario.people[scenario.users.supervisor], departmentAId, groupAId, scenario.people[scenario.users.leader]],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,
           leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         select source.order_id,'revenue_change',-25,75,75,'2026-08-01','2026-08-15','部门负向调整',
                source.salesperson_person_id,source.salesperson_name,source.department_unit_id,source.department_name,
                source.group_unit_id,source.group_name,source.leader_person_id,source.leader_name,
                source.supervisor_person_id,source.supervisor_name
         from performance_events source where source.order_id=$1 and source.order_sequence=1`,
        [scenario.orderIds[0]],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,
           leader_person_id,leader_name,supervisor_person_id,supervisor_name)
         select source.order_id,'revenue_change',5,80,80,'2026-08-01','2026-08-18','组织改名前事件快照',
                source.salesperson_person_id,source.salesperson_name,source.department_unit_id,'甲部历史新名',
                source.group_unit_id,'甲组历史新名',source.leader_person_id,source.leader_name,
                source.supervisor_person_id,source.supervisor_name
         from performance_events source where source.order_id=$1 and source.order_sequence=1`,
        [scenario.orderIds[0]],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_name,group_name,leader_name,supervisor_name)
         values($1,'legacy_adjustment',10,110,110,'2026-08-01','2026-08-20','遗留组织待补齐',
                $2,'业务员丙','遗留部门','遗留小组','遗留组长','遗留主管')`,
        [scenario.orderIds[2], scenario.people[scenario.users.carol]],
      );
      const legacyOrders = await client.query<{ id:string; salesperson_name:string }>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,salesperson_name,source_received_on,
           original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('LEGACY-NULL-1','遗留客户甲','测试单位','遗留人员甲','2026-08-21',3,3,3,'active',now()),
               ('LEGACY-NULL-2','遗留客户乙','测试单位','遗留人员乙','2026-08-22',4,4,4,'active',now()),
               ('LEGACY-NULL-3','遗留客户丙','测试单位','遗留人员丙','2026-08-23',6,6,6,'active',now())
         returning id::text,salesperson_name`,
      );
      for (const [index, order] of legacyOrders.rows.entries()) {
        await client.query(
          `insert into performance_events
            (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
             accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,leader_name,supervisor_name)
           values($1,'legacy_adjustment',$2,$2,$2,'2026-08-01',$3::date,'遗留身份待补齐',$4,$5,$6,'遗留组长','遗留主管')`,
          [
            order.id,
            index === 0 ? 3 : index === 1 ? 4 : 6,
            `2026-08-${String(21 + index).padStart(2, "0")}`,
            order.salesperson_name,
            index < 2 ? "遗留部门" : "另一遗留部门",
            index < 2 ? "遗留小组" : "另一遗留小组",
          ],
        );
      }
      const root = await client.query<{ id:string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         values('2026-08-01','sales_manager',$1,$2) returning id::text`,
        [scenario.users.manager, scenario.people[scenario.users.manager]],
      );
      const departmentA = await client.query<{ id:string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id)
         values('2026-08-01','department',$1,$2,$3,$4) returning id::text`,
        [scenario.users.supervisor, scenario.people[scenario.users.supervisor], root.rows[0]!.id, departmentAId],
      );
      const departmentB = await client.query<{ id:string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id)
         values('2026-08-01','department',$1,$2,$3,$4) returning id::text`,
        [scenario.users.carol, scenario.people[scenario.users.carol], root.rows[0]!.id, departmentBId],
      );
      const groupA = await client.query<{ id:string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id)
         values('2026-08-01','group',$1,$2,$3,$4) returning id::text`,
        [scenario.users.leader, scenario.people[scenario.users.leader], departmentA.rows[0]!.id, groupAId],
      );
      const personal = await client.query<{ id:string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         values('2026-08-01','personal',$1,$2) returning id::text`,
        [scenario.users.supervisor, scenario.people[scenario.users.supervisor]],
      );
      for (const [goalId, amount, status] of [
        [root.rows[0]!.id, 500, "active"],
        [departmentA.rows[0]!.id, 250, "active"],
        [departmentB.rows[0]!.id, 200, "pending_hr"],
        [groupA.rows[0]!.id, 200, "active"],
        [personal.rows[0]!.id, 500, "active"],
      ] as const) {
        await client.query(
          `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
           values($1,1,$2,$3,$4,$5,'部门看板测试')`,
          [goalId, amount, status, scenario.users.manager, scenario.people[scenario.users.manager]],
        );
      }
      await client.query("insert into user_roles(user_id,role_code) values($1,'system_admin')", [scenario.users.manager]);
      await client.query("insert into user_roles(user_id,role_code) values($1,'sales_leader')", [scenario.users.supervisor]);
      await client.query(
        "update org_responsibilities set person_id=$1 where org_unit_id=$2 and responsibility_type='leader'",
        [scenario.people[scenario.users.supervisor], groupAId],
      );
      await client.query("update org_units set name='甲部当前档案' where id=$1", [departmentAId]);
      await client.query("update org_units set name='甲组当前档案',parent_id=$2 where id=$1", [groupAId, departmentBId]);
    } finally {
      await client.end();
    }

    await withTestApi(database.url, async (app) => {
      const login = async (username:string) => {
        const cookie = await loginCookie(app, username);
        const sessionClient = new Client({ connectionString: database.url });
        await sessionClient.connect();
        try { await sessionClient.query("update sessions set expires_at=now()+interval '1 day',last_seen_at=now()"); }
        finally { await sessionClient.end(); }
        return cookie;
      };
      const supervisorCookie = await login("scope_supervisor");
      const supervisorDashboard = await app.inject({ method:"GET",url:"/api/performance/dashboard?month=2026-08",headers:{cookie:supervisorCookie} });
      assert.equal(supervisorDashboard.statusCode, 200, supervisorDashboard.body);
      assert.equal(supervisorDashboard.json().personalAchievement.actualAmount, "40.00");
      assert.equal(supervisorDashboard.json().personalAchievement.targetAmount, "500.00");
      assert.equal(supervisorDashboard.json().salesAchievement, null);
      assert.equal(supervisorDashboard.json().groupAchievements[0].groupName, "甲组历史新名");
      assert.equal(supervisorDashboard.json().groupAchievements[0].actualAmount, "220.00");
      assert.equal(supervisorDashboard.json().departmentAchievements.length, 1);
      assert.deepEqual(
        {
          name: supervisorDashboard.json().departmentAchievements[0].departmentName,
          actual: supervisorDashboard.json().departmentAchievements[0].actualAmount,
          target: supervisorDashboard.json().departmentAchievements[0].targetAmount,
          gap: supervisorDashboard.json().departmentAchievements[0].gapAmount,
          rate: supervisorDashboard.json().departmentAchievements[0].achievementRate,
        },
        { name:"甲部历史新名",actual:"220.00",target:"250.00",gap:"30.00",rate:"88.00" },
      );
      assert.doesNotMatch(JSON.stringify(supervisorDashboard.json().departmentAchievements), /乙部/);

      const departmentDetails = await app.inject({
        method:"GET",
        url:`/api/performance/department-achievement/events?month=2026-08&departmentId=${departmentAId}`,
        headers:{cookie:supervisorCookie},
      });
      assert.equal(departmentDetails.statusCode, 200, departmentDetails.body);
      assert.equal(departmentDetails.json().departmentName, "甲部历史新名");
      assert.equal(departmentDetails.json().actualAmount, "220.00");
      assert.equal(departmentDetails.json().groups.length, 1);
      type EventRow={deltaAmount:string};
      type OrderRow={actualAmount:string;events:EventRow[]};
      type MemberRow={personId:string|null;personKey:string;name:string;actualAmount:string;orders:OrderRow[]};
      type GroupRow={groupId:string|null;groupKey:string;actualAmount:string;members:MemberRow[]};
      type DepartmentRow={departmentId:string|null;departmentKey:string;departmentName:string;actualAmount:string;groups:GroupRow[]};
      const department = departmentDetails.json() as DepartmentRow;
      const groups = department.groups;
      const members = groups.flatMap((group) => group.members);
      const orders = members.flatMap((member) => member.orders);
      const events = orders.flatMap((order) => order.events);
      assert.equal(groups.reduce((sum, group) => sum + moneyCents(group.actualAmount), 0n), moneyCents(department.actualAmount));
      assert.equal(members.reduce((sum, member) => sum + moneyCents(member.actualAmount), 0n), moneyCents(department.actualAmount));
      assert.equal(orders.reduce((sum, order) => sum + moneyCents(order.actualAmount), 0n), moneyCents(department.actualAmount));
      assert.equal(events.reduce((sum, event) => sum + moneyCents(event.deltaAmount), 0n), moneyCents(department.actualAmount));
      assert.deepEqual(events.map((event) => event.deltaAmount).sort(), ["-25.00", "100.00", "100.00", "40.00", "5.00"]);
      assert.doesNotMatch(departmentDetails.body, /甲部当前档案|甲组当前档案/);
      assert.doesNotMatch(departmentDetails.body, /业务员丙|SCOPE-3|乙部|乙组/);

      const deniedDepartment = await app.inject({
        method:"GET",
        url:`/api/performance/department-achievement/events?month=2026-08&departmentId=${departmentBId}`,
        headers:{cookie:supervisorCookie},
      });
      assert.equal(deniedDepartment.statusCode, 403, deniedDepartment.body);
      assert.equal(deniedDepartment.json().code, "DEPARTMENT_SCOPE_FORBIDDEN");

      const assistantCookie = await login("scope_assistant");
      const assistantDashboard = await app.inject({ method:"GET",url:"/api/performance/dashboard?month=2026-08",headers:{cookie:assistantCookie} });
      assert.equal(assistantDashboard.statusCode, 200, assistantDashboard.body);
      assert.deepEqual(assistantDashboard.json().departmentAchievements, []);
      assert.equal(assistantDashboard.json().salesAchievement, null);

      for (const username of ["scope_manager", "scope_hr", "scope_general_manager"]) {
        const cookie = await login(username);
        const dashboard = await app.inject({ method:"GET",url:"/api/performance/dashboard?month=2026-08",headers:{cookie} });
        assert.equal(dashboard.statusCode, 200, `${username}: ${dashboard.body}`);
        assert.equal(dashboard.json().salesAchievement.actualAmount, "343.00", username);
        assert.equal(dashboard.json().salesAchievement.targetAmount, "500.00", username);
        assert.deepEqual(dashboard.json().departmentAchievements.map((item:{departmentName:string})=>item.departmentName).sort(), ["乙部", "甲部历史新名", "遗留部门（待补齐组织归属）", "另一遗留部门（待补齐组织归属）"].sort());
        const inactive = dashboard.json().departmentAchievements.find((item:{departmentName:string})=>item.departmentName==="乙部");
        assert.equal(inactive.actualAmount, "100.00");
        assert.equal(inactive.targetAmount, null);
        assert.equal(inactive.achievementRate, null);
        assert.equal(inactive.calculationReason, "TARGET_NOT_ACTIVE");
        const unassigned = dashboard.json().departmentAchievements.find((item:{departmentName:string})=>item.departmentName==="遗留部门（待补齐组织归属）");
        assert.equal(unassigned.actualAmount, "17.00");
        assert.equal(unassigned.calculationReason, "TARGET_NOT_ACTIVE");
      }

      const managerCookie = await login("scope_manager");
      const salesDetails = await app.inject({ method:"GET",url:"/api/performance/sales-achievement/events?month=2026-08",headers:{cookie:managerCookie} });
      assert.equal(salesDetails.statusCode, 200, salesDetails.body);
      const salesDepartments = salesDetails.json().departments as DepartmentRow[];
      assert.equal(salesDepartments.reduce((sum, item) => sum + moneyCents(item.actualAmount), 0n), moneyCents(salesDetails.json().actualAmount));
      const salesEvents = salesDepartments.flatMap((item) => item.groups.flatMap((group) => group.members.flatMap((member) => member.orders.flatMap((order) => order.events))));
      assert.equal(salesEvents.reduce((sum, event) => sum + moneyCents(event.deltaAmount), 0n), moneyCents(salesDetails.json().actualAmount));
      const legacyDepartment = salesDepartments.find((item) => item.departmentName === "遗留部门（待补齐组织归属）")!;
      assert.deepEqual(legacyDepartment.groups.flatMap((group) => group.members.map((member) => member.name)).sort(), ["业务员丙", "遗留人员乙", "遗留人员甲"].sort());
      assert.equal(new Set(salesDepartments.filter((item) => item.departmentId === null).map((item) => item.departmentKey)).size, 2);
      const departmentB = salesDepartments.find((item) => item.departmentId === departmentBId)!;
      assert.ok(!departmentB.groups.some((group) => group.groupId === groupAId));

      const adminCookie = await login("scope_admin");
      for (const url of [
        `/api/performance/department-achievement/events?month=2026-08&departmentId=${departmentAId}`,
        "/api/performance/sales-achievement/events?month=2026-08",
      ]) {
        const denied = await app.inject({ method:"GET",url,headers:{cookie:adminCookie} });
        assert.equal(denied.statusCode, 403, `${url}: ${denied.body}`);
      }
    }, { clock: () => new Date("2026-08-14T16:30:00.000Z") });
  });
});

test("多个销售经理根目标不会被任意选为全公司正式目标", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const secondManagerId = await seedTestUser(database.url, {
      username:"scope_manager_second",displayName:"销售经理乙",password:"Role@123",roleCode:"sales_manager",roleName:"销售经理",
    });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const rootGoalIds: string[] = [];
    try {
      const secondManager = await client.query<{person_id:string}>("select id::text as person_id from people where user_id=$1", [secondManagerId]);
      for (const [ownerUserId, ownerPersonId, amount] of [
        [scenario.users.manager, scenario.people[scenario.users.manager], 500],
        [secondManagerId, secondManager.rows[0]!.person_id, 800],
      ] as const) {
        const goal = await client.query<{id:string}>(
          "insert into goals(period_month,goal_level,owner_user_id,owner_person_id) values('2026-08-01','sales_manager',$1,$2) returning id::text",
          [ownerUserId, ownerPersonId],
        );
        rootGoalIds.push(goal.rows[0]!.id);
        await client.query(
          `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
           values($1,1,$2,'active',$3,$4,'多根目标歧义回归')`,
          [goal.rows[0]!.id, amount, ownerUserId, ownerPersonId],
        );
      }
    } finally {
      await client.end();
    }
    await withTestApi(database.url, async (app) => {
      for (const username of ["scope_manager", "scope_manager_second", "scope_hr"]) {
        const cookie = await loginCookie(app, username);
        const dashboard = await app.inject({ method:"GET",url:"/api/performance/dashboard?month=2026-08",headers:{cookie} });
        assert.equal(dashboard.statusCode, 200, `${username}: ${dashboard.body}`);
        assert.equal(dashboard.json().salesAchievement.actualAmount, "300.00", username);
        assert.equal(dashboard.json().salesAchievement.targetAmount, null, username);
        assert.equal(dashboard.json().salesAchievement.achievementRate, null, username);
        assert.equal(dashboard.json().salesAchievement.calculationReason, "TARGET_SCOPE_AMBIGUOUS", username);
        for (const url of [
          `/api/performance/formal-reports/${rootGoalIds[0]}`,
          `/api/exports/formal-reports/${rootGoalIds[0]}.csv`,
        ]) {
          const report = await app.inject({ method:"GET",url,headers:{cookie} });
          assert.equal(report.statusCode, 409, `${username}: ${url}: ${report.body}`);
          assert.equal(report.json().code, "TARGET_SCOPE_AMBIGUOUS");
        }
      }
    });
  });
});

test("组织业绩查询在小基线和 2850 订单 4701 事件基线保持单次读取且无逐行 SubPlan", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      type PlanNode = { "Parent Relationship"?:string;"Actual Loops"?:number;Plans?:PlanNode[] };
      const explain = async () => {
        const result = await client.query<{ "QUERY PLAN":Array<{Plan:PlanNode}> }>(
          `explain (analyze,format json) ${ORGANIZATION_ACHIEVEMENT_SQL}`,
          ["2026-08-01", [], true],
        );
        const repeatedSubplans: PlanNode[] = [];
        const visit = (node:PlanNode) => {
          if (node["Parent Relationship"] === "SubPlan" && (node["Actual Loops"] ?? 0) > 1) repeatedSubplans.push(node);
          node.Plans?.forEach(visit);
        };
        visit(result.rows[0]!["QUERY PLAN"][0]!.Plan);
        return repeatedSubplans;
      };

      assert.deepEqual(await explain(), []);
      const organization = await client.query<{ department_id:string;group_id:string }>(
        `select (select id::text from org_units where unit_type='department' and name='甲部') as department_id,
                (select id::text from org_units where unit_type='group' and name='甲组') as group_id`,
      );
      const { department_id:departmentId, group_id:groupId } = organization.rows[0]!;
      await client.query(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         select 'PLAN-'||lpad(series::text,4,'0'),'计划客户'||series,'测试单位',$1,'业务员甲',
                '2026-08-01',1,1,1,'active',now()
         from generate_series(4,2850) series`,
        [scenario.people[scenario.users.alice]],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,leader_name,supervisor_name,order_sequence)
         select id,'initial',1,1,1,'2026-08-01','2026-08-01','查询计划基线',$1,'业务员甲',
                $2,'甲部',$3,'甲组','甲组组长','甲部主管',1
         from performance_orders where qingflow_order_no like 'PLAN-%'`,
        [scenario.people[scenario.users.alice], departmentId, groupId],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_unit_id,department_name,group_unit_id,group_name,leader_name,supervisor_name,order_sequence)
         select id,'legacy_adjustment',1,2,2,'2026-08-01','2026-08-02','查询计划基线',$1,'业务员甲',
                $2,'甲部',$3,'甲组','甲组组长','甲部主管',2
         from performance_orders where qingflow_order_no between 'PLAN-0004' and 'PLAN-1854'`,
        [scenario.people[scenario.users.alice], departmentId, groupId],
      );
      const counts = await client.query<{orders:string;events:string}>(
        "select count(*)::text as orders,(select count(*)::text from performance_events) as events from performance_orders",
      );
      assert.deepEqual(counts.rows[0], { orders:"2850",events:"4701" });
      assert.deepEqual(await explain(), []);
    } finally {
      await client.end();
    }
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
          orderNo:"TRANSFER-1", customerName:"跨组客户", customerUnit:"测试单位", businessRegionSourceText:"江苏原文", businessRegionCode:"CN-JS",
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
      const matrix = response.json().permissionMatrix as Array<{ code: string; businessScope: string; businessOperations:string[]; targetResponsibilities:string; forbidden: string[] }>;
      assert.equal(matrix.find((role) => role.code === "system_admin")?.businessScope, "none");
      assert.ok(matrix.find((role) => role.code === "system_admin")?.forbidden.includes("业务查看与导出"));
      assert.equal(matrix.find((role) => role.code === "salesperson")?.businessScope, "self");
      assert.equal(matrix.find((role) => role.code === "sales_leader")?.businessScope, "group");
      assert.equal(matrix.find((role) => role.code === "sales_supervisor")?.businessScope, "department");
      assert.ok(matrix.find((role) => role.code === "sales_assistant_leader")?.businessOperations.includes("月度核对与关闭月更正"));
      assert.ok(matrix.find((role) => role.code === "hr")?.businessOperations.includes("记账期间关闭与更正审批"));
      assert.equal(matrix.find((role) => role.code === "hr")?.targetResponsibilities, "审批目标确认与修改申请");
    });
  });
});

test("账号管理使用稳定搜索分页并审计固定角色组合变更", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const setup = new Client({ connectionString: database.url });
    const writer = new Client({ connectionString: database.url });
    await setup.connect();
    await writer.connect();
    try {
      await writer.query("begin");
      const pending = await writer.query<{ id: string }>(
        `insert into users(username,display_name,password_hash,password_salt,must_change_password)
         select 'account_page_pending','分页账号 00',password_hash,password_salt,false from users where id=$1 returning id::text`,
        [scenario.users.admin],
      );
      const inserted = await setup.query<{ id: string }>(
        `insert into users(username,display_name,password_hash,password_salt,must_change_password)
         select 'account_page_'||lpad(series::text,2,'0'),'分页账号 '||lpad(series::text,2,'0'),source.password_hash,source.password_salt,false
         from generate_series(1,60) series cross join users source where source.id=$1
         returning id::text`,
        [scenario.users.admin],
      );
      await setup.query(
        `insert into user_roles(user_id,role_code,assigned_by)
         select id,'salesperson',$1 from users where username like 'account_page_%'`,
        [scenario.users.admin],
      );
      await setup.query("insert into roles(code,name) values('custom_power','自定义权限')");

      await withTestApi(database.url, async (app) => {
        const adminHeaders = await loginWriteHeaders(app, "scope_admin");
        const search = encodeURIComponent("分页账号");
        const firstRequest = app.inject({ method: "GET", url: `/api/admin/users?search=${search}`, headers: adminHeaders });
        const firstResult=await Promise.race([
          firstRequest,
          new Promise<null>((resolve)=>setTimeout(()=>resolve(null),1_000)),
        ]);
        try {
          await writer.query("commit");
        } finally {
          if(!firstResult)await writer.query("rollback");
        }
        assert.ok(firstResult,"账号读取不得等待在途写入提交");
        const first=firstResult;
        assert.equal(first.statusCode, 200, first.body);
        assert.equal(first.json().users.length, 50);
        assert.equal(first.json().pageSize, 50);
        assert.ok(first.json().nextCursor);
        assert.equal(first.json().roles.some((role: { code: string }) => role.code === "custom_power"), false);

        const late = await setup.query<{ id: string }>(
          `insert into users(username,display_name,password_hash,password_salt,must_change_password)
           select 'account_page_late','分页账号 99',password_hash,password_salt,false from users where id=$1 returning id::text`,
          [scenario.users.admin],
        );
        await setup.query("insert into user_roles(user_id,role_code,assigned_by) values($1,'salesperson',$2)", [late.rows[0]!.id, scenario.users.admin]);

        const numbered = await app.inject({ method: "GET", url: `/api/admin/users?search=${search}&page=2&pageSize=10`, headers: adminHeaders });
        assert.equal(numbered.statusCode, 200, numbered.body);
        assert.equal(numbered.json().page, 2);
        assert.equal(numbered.json().pageSize, 10);
        assert.equal(numbered.json().totalCount, 62);
        assert.equal(numbered.json().users.length, 10);
        const mixedPagination = await app.inject({ method: "GET", url: `/api/admin/users?search=${search}&page=1&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers: adminHeaders });
        assert.equal(mixedPagination.statusCode, 400, mixedPagination.body);
        const invalidPageSize = await app.inject({ method: "GET", url: "/api/admin/users?pageSize=15", headers: adminHeaders });
        assert.equal(invalidPageSize.statusCode, 400, invalidPageSize.body);

        const second = await app.inject({
          method: "GET",
          url: `/api/admin/users?search=${search}&cursor=${encodeURIComponent(first.json().nextCursor)}`,
          headers: adminHeaders,
        });
        assert.equal(second.statusCode, 200, second.body);
        assert.equal(second.json().users.length, 10);
        assert.equal(second.json().nextCursor, null);
        const ids = [...first.json().users, ...second.json().users].map((user: { id: string }) => user.id);
        assert.equal(new Set(ids).size, 60);
        assert.equal(ids.includes(pending.rows[0]!.id), false);
        assert.equal(ids.includes(late.rows[0]!.id), false);

        const mismatchedCursor = await app.inject({
          method: "GET",
          url: `/api/admin/users?search=其他&cursor=${encodeURIComponent(first.json().nextCursor)}`,
          headers: adminHeaders,
        });
        assert.equal(mismatchedCursor.statusCode, 400, mismatchedCursor.body);
        const overflowCursor = Buffer.from(JSON.stringify({ version: 1, userId: scenario.users.admin, search: "分页账号", id: "9223372036854775808", cutoffId: "9223372036854775808" }), "utf8").toString("base64url");
        const overflow = await app.inject({ method: "GET", url: `/api/admin/users?search=${search}&cursor=${overflowCursor}`, headers: adminHeaders });
        assert.equal(overflow.statusCode, 400, overflow.body);
        const empty = await app.inject({ method: "GET", url: "/api/admin/users?search=不存在的账号", headers: adminHeaders });
        assert.equal(empty.statusCode, 200, empty.body);
        assert.deepEqual(empty.json().users, []);
        assert.equal(empty.json().nextCursor, null);

        const targetId = inserted.rows[0]!.id;
        const changed = await app.inject({
          method: "PATCH",
          url: `/api/admin/users/${targetId}/roles`,
          headers: adminHeaders,
          payload: { roles: ["system_admin"] },
        });
        assert.equal(changed.statusCode, 200, changed.body);
        assert.deepEqual(changed.json(), { ok: true, changed: true });
        const roleRows = await setup.query<{ role_code: string }>("select role_code from user_roles where user_id=$1 order by role_code", [targetId]);
        assert.deepEqual(roleRows.rows.map((row) => row.role_code), ["system_admin"]);
        const audit = await setup.query<{ actor_user_id: string; before_data: { roles: string[] }; after_data: { roles: string[]; result: string }; created_at: string }>(
          `select actor_user_id::text,before_data,after_data,created_at::text
           from audit_logs where action='auth.account_roles_changed' and entity_type='user' and entity_id=$1 order by id desc limit 1`,
          [targetId],
        );
        assert.equal(audit.rows[0]!.actor_user_id, scenario.users.admin);
        assert.deepEqual(audit.rows[0]!.before_data, { roles: ["salesperson"] });
        assert.deepEqual(audit.rows[0]!.after_data, { roles: ["system_admin"], result: "succeeded" });
        assert.ok(audit.rows[0]!.created_at);

        const targetHeaders = await loginWriteHeaders(app, "account_page_01");
        const business = await app.inject({ method: "GET", url: "/api/performance/dashboard", headers: targetHeaders });
        assert.equal(business.statusCode, 403, business.body);

        const custom = await app.inject({
          method: "PATCH",
          url: `/api/admin/users/${targetId}/roles`,
          headers: adminHeaders,
          payload: { roles: ["custom_power"] },
        });
        assert.equal(custom.statusCode, 400, custom.body);
        const selfRemoval = await app.inject({
          method: "PATCH",
          url: `/api/admin/users/${scenario.users.admin}/roles`,
          headers: adminHeaders,
          payload: { roles: ["salesperson"] },
        });
        assert.equal(selfRemoval.statusCode, 409, selfRemoval.body);
      });
    } finally {
      await writer.query("rollback");
      await writer.end();
      await setup.end();
    }
  });
});

test("订单台账用固定快照稳定遍历并保持有界查询次数", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const setup = new Client({ connectionString: database.url });
    await setup.connect();
    const organization = await setup.query<{ department_id: string; group_id: string }>(
      `select (select id::text from org_units where unit_type='department' and name='甲部') as department_id,
              (select id::text from org_units where unit_type='group' and name='甲组') as group_id`,
    );
    const { department_id: departmentId, group_id: groupId } = organization.rows[0]!;
    const fixedCreatedAt = "2026-08-31T12:00:00.000Z";
    async function insertRows(prefix: string, count: number): Promise<string[]> {
      const inserted = await setup.query<{ id: string }>(
        `with orders as (
           insert into performance_orders
             (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
              source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,created_at,posted_at)
           select $1||lpad(series::text,4,'0'),'游标客户'||lpad(series::text,4,'0'),
                  '游标单位'||lpad(series::text,4,'0'),$3,'游标业务员','2026-08-31',1,1,1,'active',$4,$4
           from generate_series(1,$2::integer) series
           returning id
         )
         insert into performance_events
           (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
            accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
            department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,
            supervisor_person_id,supervisor_name)
         select id,'initial',1,1,1,'2026-08-01','2026-08-31','稳定游标回归',$3,'游标业务员',
                $5,'甲部',$6,'甲组',$7,'甲组组长',$8,'甲部主管'
         from orders returning order_id::text as id`,
        [
          prefix,
          count,
          scenario.people[scenario.users.alice],
          fixedCreatedAt,
          departmentId,
          groupId,
          scenario.people[scenario.users.leader],
          scenario.people[scenario.users.supervisor],
        ],
      );
      return inserted.rows.map((row) => row.id);
    }

    const expectedIds = await insertRows("CURSOR-FIX-", 101);
    const pool = new Pool({ connectionString: database.url });
    let listReadCount = 0;
    let orderListQuery: { statement: string; values: unknown[] } | null = null;
    const patched = new WeakSet<pg.PoolClient>();
    pool.on("acquire", (client) => {
      if (patched.has(client)) return;
      patched.add(client);
      const originalQuery = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        const statement = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
        if (/^\s*(select|with)\b/i.test(statement) && !/\bfrom sessions\b/i.test(statement)) listReadCount += 1;
        if (/select id::text, created_at as "__cursorCreatedAt"/i.test(statement)) {
          const values = typeof args[0] === "string" ? args[1] : (args[0] as { values?: unknown[] }).values;
          orderListQuery = { statement, values: Array.isArray(values) ? [...values] : [] };
        }
        return originalQuery(...args as [string, unknown[]]);
      }) as typeof client.query;
    });
    const app = await buildApp({ database: pool, logger: false });
    try {
      const leaderCookie = await loginCookie(app, "scope_leader");
      type OrderPage = {
        orders: Array<{ id: string; orderNo: string; customerName: string; customerUnit: string; salespersonName: string }>;
        previousCursor: string | null;
        nextCursor: string | null;
        pageSize: number;
      };
      async function readPage(search: string, cursor?: string, cookie = leaderCookie): Promise<{ body: OrderPage; reads: number }> {
        const query = new URLSearchParams({ search });
        if (cursor) query.set("cursor", cursor);
        listReadCount = 0;
        const response = await app.inject({ method: "GET", url: `/api/performance/orders?${query}`, headers: { cookie } });
        assert.equal(response.statusCode, 200, response.body);
        assert.ok(listReadCount <= 2, `排除会话认证后，订单列表权限与数据读取应不超过 2 次，实际 ${listReadCount} 次`);
        return { body: response.json() as OrderPage, reads: listReadCount };
      }
      async function assertListPlanHasNoPerRowEventScan() {
        assert.ok(orderListQuery);
        type PlanNode = { "Parent Relationship"?: string; "Relation Name"?: string; "Actual Loops"?: number; Plans?: PlanNode[] };
        const explained = await setup.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
          `explain (analyze,format json) ${orderListQuery.statement}`,
          orderListQuery.values,
        );
        const repeatedNodes: PlanNode[] = [];
        const visit = (node: PlanNode) => {
          if ((node["Actual Loops"] ?? 0) > 1
            && (node["Parent Relationship"] === "SubPlan" || node["Relation Name"] === "performance_events")) repeatedNodes.push(node);
          node.Plans?.forEach(visit);
        };
        const plan = explained.rows[0]!["QUERY PLAN"][0]!.Plan;
        visit(plan);
        assert.deepEqual(repeatedNodes, [], JSON.stringify(plan));
      }

      const first = await readPage("CURSOR-FIX-");
      await assertListPlanHasNoPerRowEventScan();
      assert.equal(first.body.pageSize, 50);
      assert.equal(first.body.orders.length, 50);
      assert.equal(first.body.previousCursor, null);
      assert.ok(first.body.nextCursor);

      const numbered = await app.inject({ method: "GET", url: "/api/performance/orders?search=CURSOR-FIX-&page=2&pageSize=10", headers: { cookie: leaderCookie } });
      assert.equal(numbered.statusCode, 200, numbered.body);
      assert.equal(numbered.json().page, 2);
      assert.equal(numbered.json().pageSize, 10);
      assert.equal(numbered.json().totalCount, 101);
      assert.equal(numbered.json().orders.length, 10);
      const numberedSnapshot=numbered.json<{snapshot:string}>().snapshot;
      assert.ok(numberedSnapshot);
      const mixedPagination = await app.inject({ method: "GET", url: `/api/performance/orders?search=CURSOR-FIX-&page=1&cursor=${encodeURIComponent(first.body.nextCursor!)}`, headers: { cookie: leaderCookie } });
      assert.equal(mixedPagination.statusCode, 400, mixedPagination.body);
      const invalidPageSize = await app.inject({ method: "GET", url: "/api/performance/orders?pageSize=15", headers: { cookie: leaderCookie } });
      assert.equal(invalidPageSize.statusCode, 400, invalidPageSize.body);

      const [newOrderId] = await insertRows("CURSOR-FIX-NEW-", 1);
      const numberedLast=await app.inject({method:"GET",url:`/api/performance/orders?search=CURSOR-FIX-&page=11&pageSize=10&snapshot=${encodeURIComponent(numberedSnapshot)}`,headers:{cookie:leaderCookie}});
      assert.equal(numberedLast.statusCode,200,numberedLast.body);
      assert.equal(numberedLast.json().totalCount,101);
      assert.equal(numberedLast.json().orders.length,1);
      assert.equal(numberedLast.json<{orders:Array<{id:string}>}>().orders.some((order)=>order.id===newOrderId),false);
      const numberedOutOfRange=await app.inject({method:"GET",url:`/api/performance/orders?search=CURSOR-FIX-&page=999&pageSize=10&snapshot=${encodeURIComponent(numberedSnapshot)}`,headers:{cookie:leaderCookie}});
      assert.equal(numberedOutOfRange.statusCode,200,numberedOutOfRange.body);
      assert.equal(numberedOutOfRange.json().totalCount,101);
      assert.deepEqual(numberedOutOfRange.json().orders,[]);
      const numberedMismatch=await app.inject({method:"GET",url:`/api/performance/orders?search=OTHER&page=1&pageSize=10&snapshot=${encodeURIComponent(numberedSnapshot)}`,headers:{cookie:leaderCookie}});
      assert.equal(numberedMismatch.statusCode,400,numberedMismatch.body);
      const pages = [first.body];
      let nextCursor: string | null = first.body.nextCursor;
      while (nextCursor) {
        const currentPage: OrderPage = (await readPage("CURSOR-FIX-", nextCursor)).body;
        pages.push(currentPage);
        nextCursor = currentPage.nextCursor;
      }
      assert.deepEqual(pages.map((page) => page.orders.length), [50, 50, 1]);
      const traversedIds = pages.flatMap((page) => page.orders.map((order) => order.id));
      assert.equal(new Set(traversedIds).size, 101);
      assert.deepEqual(new Set(traversedIds), new Set(expectedIds));
      assert.ok(!traversedIds.includes(newOrderId!));

      const previous = await readPage("CURSOR-FIX-", pages[1]!.previousCursor!);
      assert.deepEqual(previous.body.orders.map((order) => order.id), pages[0]!.orders.map((order) => order.id));
      assert.equal(previous.body.previousCursor, null);
      assert.ok(previous.body.nextCursor);
      const refreshed = await readPage("CURSOR-FIX-");
      assert.equal(refreshed.body.orders[0]!.id, newOrderId);

      for (const [search, field, expected] of [
        ["CURSOR-FIX-0001", "orderNo", "CURSOR-FIX-0001"],
        ["游标客户0002", "customerName", "游标客户0002"],
        ["游标单位0003", "customerUnit", "游标单位0003"],
        ["游标业务员", "salespersonName", "游标业务员"],
      ] as const) {
        const page = await readPage(search);
        assert.ok(page.body.orders.length > 0, search);
        assert.ok(page.body.orders.every((order) => order[field].includes(expected)), search);
      }

      const mismatch = await app.inject({
        method: "GET",
        url: `/api/performance/orders?search=OTHER&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
        headers: { cookie: leaderCookie },
      });
      assert.equal(mismatch.statusCode, 400, mismatch.body);
      const filterMismatch = await app.inject({
        method: "GET",
        url: `/api/performance/orders?search=CURSOR-FIX-&status=active&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
        headers: { cookie: leaderCookie },
      });
      assert.equal(filterMismatch.statusCode, 400, filterMismatch.body);
      const bobCookie = await loginCookie(app, "scope_bob");
      const otherUser = await app.inject({
        method: "GET",
        url: `/api/performance/orders?search=CURSOR-FIX-&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
        headers: { cookie: bobCookie },
      });
      assert.equal(otherUser.statusCode, 400, otherUser.body);
      const otherSnapshotUser=await app.inject({method:"GET",url:`/api/performance/orders?search=CURSOR-FIX-&page=1&pageSize=10&snapshot=${encodeURIComponent(numberedSnapshot)}`,headers:{cookie:bobCookie}});
      assert.equal(otherSnapshotUser.statusCode,400,otherSnapshotUser.body);
      const oversizedPayload = JSON.parse(Buffer.from(first.body.nextCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
      oversizedPayload.anchorId = "9223372036854775808";
      const oversizedCursor = Buffer.from(JSON.stringify(oversizedPayload), "utf8").toString("base64url");
      const oversized = await app.inject({
        method: "GET",
        url: `/api/performance/orders?search=CURSOR-FIX-&cursor=${encodeURIComponent(oversizedCursor)}`,
        headers: { cookie: leaderCookie },
      });
      assert.equal(oversized.statusCode, 400, oversized.body);
      assert.equal(oversized.json().code, "ORDER_CURSOR_INVALID");

      await insertRows("CURSOR-BUDGET-", 2_749);
      const large = await readPage("CURSOR-BUDGET-");
      assert.ok(Math.abs(large.reads - first.reads) <= 1, `规模增长前后读取次数差应不超过 1：${first.reads} -> ${large.reads}`);
      await assertListPlanHasNoPerRowEventScan();
    } finally {
      await app.close();
      await pool.end();
      await setup.end();
    }
  });
});

test("订单组合筛选始终叠加服务端权限范围", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const maximumTextFilter = "筛".repeat(300);
    const maximumSearch = "S".repeat(100);
    const setup = new Client({ connectionString: database.url });
    await setup.connect();
    try {
      await setup.query(
        `update performance_orders set
           customer_unit=case qingflow_order_no when 'SCOPE-1' then '甲客户单位' when 'SCOPE-2' then '乙客户单位' else '丙客户单位' end,
           business_region_code=case qingflow_order_no when 'SCOPE-1' then 'CN-JS' when 'SCOPE-2' then 'CN-ZJ' else 'EXT-TRADE' end,
           source_received_on=case qingflow_order_no when 'SCOPE-2' then '2026-09-01'::date else '2026-08-01'::date end,
           counted_amount=case qingflow_order_no when 'SCOPE-2' then 0 else counted_amount end,
           lifecycle_state=case qingflow_order_no when 'SCOPE-2' then 'paused' else 'active' end
         where id=any($1::bigint[])`,
        [scenario.orderIds],
      );
      await setup.query(
        `with source as (
           select salesperson_person_id,department_unit_id,group_unit_id,leader_person_id,supervisor_person_id
           from performance_events where order_id=$1 limit 1
         ), orders as (
           insert into performance_orders
             (qingflow_order_no,customer_name,customer_unit,business_region_code,salesperson_person_id,salesperson_name,
              source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,created_at,posted_at)
           select $2||series::text,'最长筛选客户',$3,'CN-JS',source.salesperson_person_id,$3,
                  '2026-08-15',1,1,1,'active','2026-08-31T14:00:00Z','2026-08-31T14:00:00Z'
           from source cross join generate_series(1,51) series returning id
         )
         insert into performance_events
           (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
            accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
            department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,
            supervisor_person_id,supervisor_name)
         select orders.id,'initial',1,1,1,'2026-08-01','2026-08-15','最长筛选游标回归',
                source.salesperson_person_id,$3,source.department_unit_id,$3,source.group_unit_id,$3,
                source.leader_person_id,'最长筛选组长',source.supervisor_person_id,'最长筛选主管'
         from orders cross join source`,
        [scenario.orderIds[0], maximumSearch, maximumTextFilter],
      );
    } finally {
      await setup.end();
    }

    await withTestApi(database.url, async (app) => {
      const leaderCookie = await loginCookie(app, "scope_leader");
      const filters = new URLSearchParams({
        search: "SCOPE-",
        month: "2026-08",
        status: "active",
        salesperson: "业务员甲",
        department: "甲部",
        group: "甲组",
        region: "CN-JS",
        customerUnit: "甲客户单位",
      });
      const matched = await app.inject({ method: "GET", url: `/api/performance/orders?${filters}`, headers: { cookie: leaderCookie } });
      assert.equal(matched.statusCode, 200, matched.body);
      assert.deepEqual((matched.json().orders as Array<{ orderNo: string }>).map((order) => order.orderNo), ["SCOPE-1"]);

      filters.set("group", "乙组");
      const empty = await app.inject({ method: "GET", url: `/api/performance/orders?${filters}`, headers: { cookie: leaderCookie } });
      assert.equal(empty.statusCode, 200, empty.body);
      assert.deepEqual(empty.json().orders, []);

      const forged = await app.inject({ method: "GET", url: "/api/performance/orders?department=乙部", headers: { cookie: leaderCookie } });
      assert.equal(forged.statusCode, 200, forged.body);
      assert.deepEqual(forged.json().orders, []);
      const assistantCookie = await loginCookie(app, "scope_assistant");
      const authorized = await app.inject({ method: "GET", url: "/api/performance/orders?department=乙部", headers: { cookie: assistantCookie } });
      assert.equal(authorized.statusCode, 200, authorized.body);
      assert.deepEqual((authorized.json().orders as Array<{ orderNo: string }>).map((order) => order.orderNo), ["SCOPE-3"]);

      const exact = await app.inject({ method: "GET", url: "/api/performance/orders?orderNo=SCOPE-1", headers: { cookie: leaderCookie } });
      assert.equal(exact.statusCode, 200, exact.body);
      assert.deepEqual((exact.json().orders as Array<{ orderNo: string }>).map((order) => order.orderNo), ["SCOPE-1"]);
      const exactMissing = await app.inject({ method: "GET", url: "/api/performance/orders?orderNo=SCOPE", headers: { cookie: leaderCookie } });
      assert.equal(exactMissing.statusCode, 200, exactMissing.body);
      assert.deepEqual(exactMissing.json().orders, []);
      const exactOutsideScope = await app.inject({ method: "GET", url: "/api/performance/orders?orderNo=SCOPE-3", headers: { cookie: leaderCookie } });
      assert.equal(exactOutsideScope.statusCode, 200, exactOutsideScope.body);
      assert.deepEqual(exactOutsideScope.json().orders, []);

      for (const query of ["month=2026-13", "status=forged", `orderNo=${"X".repeat(101)}`]) {
        const invalid = await app.inject({ method: "GET", url: `/api/performance/orders?${query}`, headers: { cookie: leaderCookie } });
        assert.equal(invalid.statusCode, 400, invalid.body);
      }

      const maximumFilters = new URLSearchParams({
        search: maximumSearch,
        month: "2026-08",
        status: "active",
        salesperson: maximumTextFilter,
        department: maximumTextFilter,
        group: maximumTextFilter,
        region: "CN-JS",
        customerUnit: maximumTextFilter,
      });
      const maximumFirst = await app.inject({ method: "GET", url: `/api/performance/orders?${maximumFilters}`, headers: { cookie: leaderCookie } });
      assert.equal(maximumFirst.statusCode, 200, maximumFirst.body);
      assert.equal(maximumFirst.json().orders.length, 50);
      assert.ok(maximumFirst.json().nextCursor.length < 2048);
      maximumFilters.set("cursor", maximumFirst.json().nextCursor);
      const maximumSecond = await app.inject({ method: "GET", url: `/api/performance/orders?${maximumFilters}`, headers: { cookie: leaderCookie } });
      assert.equal(maximumSecond.statusCode, 200, maximumSecond.body);
      assert.equal(maximumSecond.json().orders.length, 1);
    });
  });
});

test("订单导出复用组合筛选、权限范围与安全审计", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const setup = new Client({ connectionString: database.url });
    await setup.connect();
    try {
    await setup.query(
      `with source as (
         select salesperson_person_id,department_unit_id,group_unit_id,leader_person_id,supervisor_person_id
         from performance_events where order_id=$1 limit 1
       ), orders as (
         insert into performance_orders
           (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
            salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,
            lifecycle_state,created_at,posted_at)
         select 'EXPORT-MATCH-'||lpad(series::text,4,'0'),E'\t=危险客户','+危险单位',E'\t=江苏原文','CN-JS',
                source.salesperson_person_id,'业务员甲','2026-08-15',123.45,123.45,120.5,'active',
                '2026-08-31T14:00:00Z','2026-08-31T14:00:00Z'
         from source cross join generate_series(1,51) series returning id
       )
       insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
          accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
          department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,
          supervisor_person_id,supervisor_name)
       select orders.id,'initial',120.5,123.45,120.5,'2026-08-01','2026-08-15','导出回归',
              source.salesperson_person_id,'业务员甲',source.department_unit_id,'甲部',source.group_unit_id,'甲组',
              source.leader_person_id,'甲组组长',source.supervisor_person_id,'甲部主管'
       from orders cross join source`,
      [scenario.orderIds[0]],
    );
    await setup.query(
      `with source as (
         select salesperson_person_id,department_unit_id,group_unit_id,leader_person_id,supervisor_person_id
         from performance_events where order_id=$1 limit 1
       ), inserted as (
         insert into performance_orders
           (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
            salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         select 'EXPORT-OUT-OF-SCOPE','=危险客户范围外','+危险单位','浙江原文','CN-JS',
                salesperson_person_id,'业务员甲','2026-08-15',1,1,1,'active','2026-08-31T14:00:00Z'
         from source returning id
       )
       insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
          accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
          department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,
          supervisor_person_id,supervisor_name)
       select inserted.id,'initial',1,1,1,'2026-08-01','2026-08-15','范围外导出回归',
              source.salesperson_person_id,'业务员甲',source.department_unit_id,'甲部',source.group_unit_id,'甲组',
              source.leader_person_id,'甲组组长',source.supervisor_person_id,'甲部主管'
       from inserted cross join source`,
      [scenario.orderIds[2]],
    );

    const pool = new Pool({ connectionString: database.url });
    let exportReadCount = 0;
    let exportQuery: { statement: string; values: unknown[] } | null = null;
    const patched = new WeakSet<pg.PoolClient>();
    pool.on("acquire", (client) => {
      if (patched.has(client)) return;
      patched.add(client);
      const originalQuery = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        const statement = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
        if (/^\s*(select|with)\b/i.test(statement) && !/\bfrom sessions\b/i.test(statement)) exportReadCount += 1;
        if (/business_region_source_text/i.test(statement) && /from performance_orders/i.test(statement)) {
          const values = typeof args[0] === "string" ? args[1] : (args[0] as { values?: unknown[] }).values;
          exportQuery = { statement, values: Array.isArray(values) ? [...values] : [] };
        }
        return originalQuery(...args as [string, unknown[]]);
      }) as typeof client.query;
    });
    const exportNow = new Date();
    const app = await buildApp({ database: pool, logger: false, clock: () => exportNow });
    try {
      const leaderCookie = await loginCookie(app, "scope_leader");
      const filters = new URLSearchParams({
        search: "EXPORT-",
        month: "2026-08",
        status: "active",
        salesperson: "业务员甲",
        department: "甲部",
        group: "甲组",
        region: "CN-JS",
        customerUnit: "+危险单位",
      });
      exportReadCount = 0;
      const response = await app.inject({ method: "GET", url: `/api/exports/performance.csv?${filters}`, headers: { cookie: leaderCookie } });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(exportReadCount <= 2, `排除会话认证后，订单导出权限与数据读取应不超过 2 次，实际 ${exportReadCount} 次`);
      const smallReadCount = exportReadCount;
      assert.match(String(response.headers["content-type"]), /^text\/csv; charset=utf-8/);
      assert.match(String(response.headers["content-disposition"]), new RegExp(`sampleflow-orders-${businessDate(exportNow)}\\.csv`));
      assert.equal(response.body.charCodeAt(0), 0xfeff);
      const lines = response.body.split("\r\n");
      assert.equal(lines.length, 52);
      assert.equal(lines[0], '\ufeff"订单编号","客户","客户单位","业务员","部门","小组","来源区域原文","标准业务区域","到样日期","当前营业额","当前计入金额","状态"');
      assert.ok(lines.some((line) => line.includes('"EXPORT-MATCH-0001"')));
      assert.ok(lines.every((line) => !line.includes("EXPORT-OUT-OF-SCOPE")));
      assert.ok(lines.some((line) => line.includes('"\'\t=危险客户"') && line.includes('"\'+危险单位"') && line.includes('"\'\t=江苏原文"')));
      assert.ok(lines.some((line) => line.includes(',123.45,120.5,"active"')));

      async function assertExportPlanHasNoPerRowEventScan() {
        assert.ok(exportQuery);
        type PlanNode = { "Parent Relationship"?: string; "Relation Name"?: string; "Actual Loops"?: number; Plans?: PlanNode[] };
        const explained = await setup.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
          `explain (analyze,format json) ${exportQuery.statement}`,
          exportQuery.values,
        );
        const repeatedNodes: PlanNode[] = [];
        const visit = (node: PlanNode) => {
          if ((node["Actual Loops"] ?? 0) > 1
            && (node["Parent Relationship"] === "SubPlan" || node["Relation Name"] === "performance_events")) repeatedNodes.push(node);
          node.Plans?.forEach(visit);
        };
        visit(explained.rows[0]!["QUERY PLAN"][0]!.Plan);
        assert.deepEqual(repeatedNodes, []);
      }
      await assertExportPlanHasNoPerRowEventScan();

      const adminCookie = await loginCookie(app, "scope_admin");
      const denied = await app.inject({ method: "GET", url: `/api/exports/performance.csv?${filters}`, headers: { cookie: adminCookie } });
      assert.equal(denied.statusCode, 403, denied.body);

      await setup.query(
        `with source as (
           select salesperson_person_id,department_unit_id,group_unit_id,leader_person_id,supervisor_person_id
           from performance_events where order_id=$1 limit 1
         ), orders as (
           insert into performance_orders
             (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
              salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,
              lifecycle_state,created_at,posted_at)
           select 'EXPORT-MATCH-'||lpad(series::text,4,'0'),E'\t=危险客户','+危险单位',E'\t=江苏原文','CN-JS',
                  source.salesperson_person_id,'业务员甲','2026-08-15',123.45,123.45,120.5,'active',
                  '2026-08-31T14:00:00Z','2026-08-31T14:00:00Z'
           from source cross join generate_series(52,2850) series returning id
         )
         insert into performance_events
           (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
            accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
            department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,
            supervisor_person_id,supervisor_name,order_sequence)
         select orders.id,'initial',120.5,123.45,120.5,'2026-08-01','2026-08-15','大规模导出回归',
                source.salesperson_person_id,'业务员甲',source.department_unit_id,'甲部',source.group_unit_id,'甲组',
                source.leader_person_id,'甲组组长',source.supervisor_person_id,'甲部主管',1
         from orders cross join source`,
        [scenario.orderIds[0]],
      );
      await setup.query(
        `with source as (
           select salesperson_person_id,department_unit_id,group_unit_id,leader_person_id,supervisor_person_id
           from performance_events where order_id=$1 limit 1
         )
         insert into performance_events
           (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
            accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
            department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,
            supervisor_person_id,supervisor_name,order_sequence)
         select orders.id,'legacy_adjustment',0,123.45,120.5,'2026-08-01','2026-08-16','大规模导出回归',
                source.salesperson_person_id,'业务员甲',source.department_unit_id,'甲部',source.group_unit_id,'甲组',
                source.leader_person_id,'甲组组长',source.supervisor_person_id,'甲部主管',2
         from performance_orders orders cross join source
         where orders.qingflow_order_no between 'EXPORT-MATCH-0052' and 'EXPORT-MATCH-1902'`,
        [scenario.orderIds[0]],
      );
      const largeCounts = await setup.query<{ orders: string; events: string }>(
        `select count(*)::text as orders,
                (select count(*)::text from performance_events events join performance_orders orders on orders.id=events.order_id
                 where orders.qingflow_order_no like 'EXPORT-MATCH-%') as events
         from performance_orders where qingflow_order_no like 'EXPORT-MATCH-%'`,
      );
      assert.deepEqual(largeCounts.rows[0], { orders: "2850", events: "4701" });

      exportReadCount = 0;
      const largeResponse = await app.inject({ method: "GET", url: `/api/exports/performance.csv?${filters}`, headers: { cookie: leaderCookie } });
      assert.equal(largeResponse.statusCode, 200, largeResponse.body);
      assert.ok(exportReadCount <= 2, `大规模订单导出读取应不超过 2 次，实际 ${exportReadCount} 次`);
      assert.ok(Math.abs(exportReadCount - smallReadCount) <= 1, `小规模 ${smallReadCount} 次、大规模 ${exportReadCount} 次，读取次数差应不超过 1`);
      assert.equal(largeResponse.body.split("\r\n").length, 2851);
      assert.match(largeResponse.body, /EXPORT-MATCH-0052/);
      assert.match(largeResponse.body, /EXPORT-MATCH-2850/);
      assert.doesNotMatch(largeResponse.body, /EXPORT-OUT-OF-SCOPE/);
      await assertExportPlanHasNoPerRowEventScan();

      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const controller = new AbortController();
      await setup.query("begin");
      try {
        await setup.query("lock table performance_orders in access exclusive mode");
        const abortResponse = await fetch(`${address}/api/exports/performance.csv?${filters}`, { headers: { cookie: leaderCookie }, signal: controller.signal });
        assert.equal(abortResponse.status, 200);
        controller.abort();
        await assert.rejects(abortResponse.text(), (error: unknown) => error instanceof Error && error.name === "AbortError");
      } finally {
        await setup.query("rollback");
      }
      let aborted = false;
      for (let attempt = 0; attempt < 100 && !aborted; attempt += 1) {
        const result = await setup.query<{ exists: boolean }>(
          `select exists(select 1 from audit_logs where action='performance.order_export' and after_data->>'failureCode'='EXPORT_ABORTED') as exists`,
        );
        aborted = result.rows[0]!.exists;
        if (!aborted) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(aborted, true, "客户端中断后应释放查询并记录 EXPORT_ABORTED");

      const audits = await setup.query<{ actor_user_id: string; after_data: { filterSummary: Record<string,string>; rowCount: number; status: string; requestId: string; fileSha256: string | null; failureCode?: string } }>(
        `select actor_user_id::text,after_data from audit_logs where action='performance.order_export' order by id`,
      );
      assert.equal(audits.rowCount, 4);
      assert.deepEqual(audits.rows.map((row) => ({ actor: row.actor_user_id, rowCount: row.after_data.rowCount, status: row.after_data.status, failureCode: row.after_data.failureCode })), [
        { actor: scenario.users.leader, rowCount: 51, status: "completed", failureCode: undefined },
        { actor: scenario.users.admin, rowCount: 0, status: "blocked", failureCode: "ACCESS_DENIED" },
        { actor: scenario.users.leader, rowCount: 2850, status: "completed", failureCode: undefined },
        { actor: scenario.users.leader, rowCount: 0, status: "blocked", failureCode: "EXPORT_ABORTED" },
      ]);
      assert.deepEqual(audits.rows[0]!.after_data.filterSummary, Object.fromEntries(filters));
      assert.equal(audits.rows[0]!.after_data.fileSha256, createHash("sha256").update(response.body).digest("hex"));
      assert.equal(audits.rows[2]!.after_data.fileSha256, createHash("sha256").update(largeResponse.body).digest("hex"));
      assert.ok(audits.rows.every((row) => row.after_data.requestId));
      assert.doesNotMatch(JSON.stringify(audits.rows), /EXPORT-MATCH|危险客户|江苏原文/);
    } finally {
      await app.close();
      await pool.end();
    }
    } finally {
      await setup.end();
    }
  });
});

test("组织创建与任职写入保持未配置单元停用并记录审计",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedAuthorizationScenario(database.url);
    await withTestApi(database.url,async(app)=>{
      const headers=await loginWriteHeaders(app,"scope_admin");
      const department=await app.inject({method:"POST",url:"/api/admin/organization/units",headers,payload:{name:"审计部门",unitType:"department",parentId:null}});
      assert.equal(department.statusCode,201,department.body);
      const group=await app.inject({method:"POST",url:"/api/admin/organization/units",headers,payload:{name:"审计小组",unitType:"group",parentId:department.json().id}});
      assert.equal(group.statusCode,201,group.body);
      const before=new Client({connectionString:database.url});await before.connect();
      const inactive=await before.query<{active:string}>("select count(*) filter(where is_active)::text as active from org_units where id=any($1::bigint[])",[[department.json().id,group.json().id]]);
      await before.end();assert.equal(inactive.rows[0]!.active,"0");
      const assignment=await app.inject({
        method:"POST",url:"/api/admin/organization/assignments",headers,
        payload:{personId:scenario.people[scenario.users.assistant],departmentId:department.json().id,groupId:group.json().id,leaderPersonId:scenario.people[scenario.users.leader],supervisorPersonId:scenario.people[scenario.users.supervisor],effectiveFrom:"2026-09-01",effectiveTo:null},
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

test("系统管理员按生效日关闭任职并原子更换负责人",async()=>{
  await withMigratedTestDatabase(async(database)=>{
    const scenario=await seedAuthorizationScenario(database.url);
    const setup=new Client({connectionString:database.url});await setup.connect();
    try{
      const membership=await setup.query<{id:string}>("select id::text from org_memberships where person_id=$1",[scenario.people[scenario.users.alice]]);
      const responsibility=await setup.query<{id:string}>(
        `select responsibility.id::text
           from org_responsibilities responsibility
           join org_units unit on unit.id=responsibility.org_unit_id
          where responsibility.person_id=$1 and responsibility.responsibility_type='leader' and unit.name='甲组'`,
        [scenario.people[scenario.users.leader]],
      );
      const supervisorResponsibility=await setup.query<{id:string}>(
        `select responsibility.id::text
           from org_responsibilities responsibility
           join org_units unit on unit.id=responsibility.org_unit_id
          where responsibility.person_id=$1 and responsibility.responsibility_type='supervisor' and unit.name='甲部'`,
        [scenario.people[scenario.users.supervisor]],
      );
      const units=await setup.query<{id:string;name:string}>("select id::text,name from org_units where name=any($1::text[])",[["乙部","乙组"]]);
      const unitIds=Object.fromEntries(units.rows.map((unit)=>[unit.name,unit.id]));
      const beforeEvents=await setup.query(
        `select salesperson_person_id::text,department_unit_id::text,group_unit_id::text,leader_person_id::text,supervisor_person_id::text
           from performance_events order by id`,
      );
      assert.equal(beforeEvents.rowCount,3);

      await withTestApi(database.url,async(app)=>{
        const headers=await loginWriteHeaders(app,"scope_admin");
        const unauthenticated=await app.inject({method:"POST",url:`/api/admin/organization/memberships/${membership.rows[0]!.id}/close`,payload:{effectiveOn:"2026-09-01"}});
        assert.equal(unauthenticated.statusCode,401,unauthenticated.body);
        const businessHeaders=await loginWriteHeaders(app,"scope_assistant");
        const forbidden=await app.inject({method:"POST",url:`/api/admin/organization/memberships/${membership.rows[0]!.id}/close`,headers:businessHeaders,payload:{effectiveOn:"2026-09-01"}});
        assert.equal(forbidden.statusCode,403,forbidden.body);
        const invalidCloseDate=await app.inject({method:"POST",url:`/api/admin/organization/memberships/${membership.rows[0]!.id}/close`,headers,payload:{effectiveOn:"2026-01-01"}});
        assert.equal(invalidCloseDate.statusCode,409,invalidCloseDate.body);
        const closed=await app.inject({
          method:"POST",url:`/api/admin/organization/memberships/${membership.rows[0]!.id}/close`,headers,
          payload:{effectiveOn:"2026-09-01"},
        });
        assert.equal(closed.statusCode,200,closed.body);
        const closedAgain=await app.inject({
          method:"POST",url:`/api/admin/organization/memberships/${membership.rows[0]!.id}/close`,headers,
          payload:{effectiveOn:"2026-09-01"},
        });
        assert.equal(closedAgain.statusCode,409,closedAgain.body);

        const missingSuccessor=await app.inject({
          method:"POST",url:`/api/admin/organization/responsibilities/${responsibility.rows[0]!.id}/replace`,headers,
          payload:{effectiveOn:"2026-09-01"},
        });
        assert.equal(missingSuccessor.statusCode,400,missingSuccessor.body);
        const sameSuccessor=await app.inject({
          method:"POST",url:`/api/admin/organization/responsibilities/${responsibility.rows[0]!.id}/replace`,headers,
          payload:{successorPersonId:scenario.people[scenario.users.leader],effectiveOn:"2026-09-01"},
        });
        assert.equal(sameSuccessor.statusCode,409,sameSuccessor.body);
        const unknownSuccessor=await app.inject({
          method:"POST",url:`/api/admin/organization/responsibilities/${responsibility.rows[0]!.id}/replace`,headers,
          payload:{successorPersonId:"9223372036854775807",effectiveOn:"2026-09-01"},
        });
        assert.equal(unknownSuccessor.statusCode,404,unknownSuccessor.body);
        const replacements=await Promise.all([1,2].map(()=>app.inject({
          method:"POST",url:`/api/admin/organization/responsibilities/${responsibility.rows[0]!.id}/replace`,headers,
          payload:{successorPersonId:scenario.people[scenario.users.assistant],effectiveOn:"2026-09-01"},
        })));
        assert.deepEqual(replacements.map((response)=>response.statusCode).sort(),[201,409]);
        const supervisorReplaced=await app.inject({
          method:"POST",url:`/api/admin/organization/responsibilities/${supervisorResponsibility.rows[0]!.id}/replace`,headers,
          payload:{successorPersonId:scenario.people[scenario.users.assistantLeader],effectiveOn:"2026-09-01"},
        });
        assert.equal(supervisorReplaced.statusCode,201,supervisorReplaced.body);
        const transferred=await app.inject({
          method:"POST",url:"/api/admin/organization/assignments",headers,
          payload:{personId:scenario.people[scenario.users.bob],departmentId:unitIds["乙部"],groupId:unitIds["乙组"],leaderPersonId:scenario.people[scenario.users.carol],supervisorPersonId:scenario.people[scenario.users.carol],effectiveFrom:"2026-09-01",effectiveTo:null,closePrevious:true},
        });
        assert.equal(transferred.statusCode,201,transferred.body);
      });

      const assignments=await setup.query<{effective_to:string|null}>("select effective_to::text from org_memberships where id=$1",[membership.rows[0]!.id]);
      assert.equal(assignments.rows[0]!.effective_to,"2026-08-31");
      const responsibilities=await setup.query<{person_id:string;effective_from:string;effective_to:string|null}>(
        `select person_id::text,effective_from::text,effective_to::text
           from org_responsibilities where org_unit_id=(select org_unit_id from org_responsibilities where id=$1)
            and responsibility_type='leader' order by effective_from`,
        [responsibility.rows[0]!.id],
      );
      assert.deepEqual(responsibilities.rows,[
        {person_id:scenario.people[scenario.users.leader],effective_from:"2026-01-01",effective_to:"2026-08-31"},
        {person_id:scenario.people[scenario.users.assistant],effective_from:"2026-09-01",effective_to:null},
      ]);
      const supervisorResponsibilities=await setup.query<{person_id:string;effective_from:string;effective_to:string|null}>(
        `select person_id::text,effective_from::text,effective_to::text
           from org_responsibilities where org_unit_id=(select org_unit_id from org_responsibilities where id=$1)
            and responsibility_type='supervisor' order by effective_from`,
        [supervisorResponsibility.rows[0]!.id],
      );
      assert.deepEqual(supervisorResponsibilities.rows,[
        {person_id:scenario.people[scenario.users.supervisor],effective_from:"2026-01-01",effective_to:"2026-08-31"},
        {person_id:scenario.people[scenario.users.assistantLeader],effective_from:"2026-09-01",effective_to:null},
      ]);
      const afterEvents=await setup.query(
        `select salesperson_person_id::text,department_unit_id::text,group_unit_id::text,leader_person_id::text,supervisor_person_id::text
           from performance_events order by id`,
      );
      assert.deepEqual(afterEvents.rows,beforeEvents.rows);
      const audits=await setup.query<{action:string;entity_id:string;actor_user_id:string;before_data:unknown;after_data:{effectiveTo?:string;effectiveOn:string;predecessor?:{effectiveTo:string};successor?:{personId:string;effectiveFrom:string};result:string};created_at:string}>(
        `select action,entity_id,actor_user_id::text,before_data,after_data,created_at::text from audit_logs
          where action=any($1::text[]) order by id`,
        [["organization.assignment_closed","organization.responsibility_replaced","organization.assignment_closed_for_transfer","organization.assignment_created"]],
      );
      assert.equal(audits.rows.length,5);
      assert.equal(audits.rows.every((audit)=>audit.actor_user_id===scenario.users.admin&&Boolean(audit.created_at)),true);
      assert.equal(audits.rows.every((audit)=>audit.after_data.result==="succeeded"&&audit.after_data.effectiveOn==="2026-09-01"),true);
      const closedAudit=audits.rows.find((audit)=>audit.action==="organization.assignment_closed")!;
      assert.notEqual(closedAudit.before_data,null);assert.equal(closedAudit.after_data.effectiveTo,"2026-08-31");
      const leaderAudit=audits.rows.find((audit)=>audit.action==="organization.responsibility_replaced"&&audit.entity_id===responsibility.rows[0]!.id)!;
      assert.notEqual(leaderAudit.before_data,null);assert.equal(leaderAudit.after_data.predecessor!.effectiveTo,"2026-08-31");
      assert.equal(leaderAudit.after_data.successor!.effectiveFrom,"2026-09-01");assert.equal(leaderAudit.after_data.successor!.personId,scenario.people[scenario.users.assistant]);
      const supervisorAudit=audits.rows.find((audit)=>audit.action==="organization.responsibility_replaced"&&audit.entity_id===supervisorResponsibility.rows[0]!.id)!;
      assert.notEqual(supervisorAudit.before_data,null);assert.equal(supervisorAudit.after_data.predecessor!.effectiveTo,"2026-08-31");
      assert.equal(supervisorAudit.after_data.successor!.personId,scenario.people[scenario.users.assistantLeader]);
      assert.notEqual(audits.rows.find((audit)=>audit.action==="organization.assignment_closed_for_transfer")!.before_data,null);
    }finally{await setup.end();}
  });
});

test("四层正式报表页面与 CSV 同口径、同权限并留下无正文审计", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuthorizationScenario(database.url);
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const units = await client.query<{ id: string; name: string }>(
      "select id::text,name from org_units where name=any($1::text[])",
      [["甲部", "甲组"]],
    );
    const unitIds = Object.fromEntries(units.rows.map((unit) => [unit.name, unit.id]));
    const pendingGroupGoal = await client.query<{ id: string }>(
      `insert into goals(period_month,goal_level,owner_user_id,owner_person_id) values('2026-08-01','group',$1,$2) returning id::text`,
      [scenario.users.leader, scenario.people[scenario.users.leader]],
    );
    await client.query(
      `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
       values($1,1,2000,'pending_hr',$2,$3,'尚未生效的组目标')`,
      [pendingGroupGoal.rows[0]!.id, scenario.users.manager, scenario.people[scenario.users.manager]],
    );
    const activeGoals = await client.query<{ id: string; goal_level: "sales_manager" | "department" | "group" }>(
      `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,org_unit_id)
       values('2026-08-01','group',$1,$2,$3),
             ('2026-08-01','department',$4,$5,$6),
             ('2026-08-01','sales_manager',$7,$8,null)
       returning id::text,goal_level`,
      [
        scenario.users.leader, scenario.people[scenario.users.leader], unitIds["甲组"],
        scenario.users.supervisor, scenario.people[scenario.users.supervisor], unitIds["甲部"],
        scenario.users.manager, scenario.people[scenario.users.manager],
      ],
    );
    const goalIds = Object.fromEntries(activeGoals.rows.map((goal) => [goal.goal_level, goal.id]));
    await client.query(
      `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
       values($1,1,2000,'active',$4,$5,'小组正式报表'),
             ($2,1,5000,'active',$4,$5,'部门正式报表'),
             ($3,1,10000,'active',$4,$5,'销售组织正式报表')`,
      [goalIds.group, goalIds.department, goalIds.sales_manager, scenario.users.hr, scenario.people[scenario.users.hr]],
    );
    const gatedGoals = await client.query<{ id: string; period_month: string }>(
      `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
       values('2099-09-01','personal',$1,$2),('2026-07-01','personal',$3,$4)
       returning id::text,period_month::text`,
      [scenario.users.alice, scenario.people[scenario.users.alice], scenario.users.bob, scenario.people[scenario.users.bob]],
    );
    const gatedGoalIds = Object.fromEntries(gatedGoals.rows.map((goal) => [goal.period_month.slice(0, 7), goal.id]));
    await client.query(
      `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
       values($1,1,1000,'active',$3,$4,'未来月份门禁'),($2,1,0,'active',$3,$4,'零目标门禁')`,
      [gatedGoalIds["2099-09"], gatedGoalIds["2026-07"], scenario.users.hr, scenario.people[scenario.users.hr]],
    );
    await client.end();
    const pendingGroupGoalId = pendingGroupGoal.rows[0]!.id;
    await withTestApi(database.url, async (app) => {
      const leaderCookie = await loginCookie(app, "scope_leader");
      for (const url of [
        `/api/performance/formal-reports/${pendingGroupGoalId}`,
        `/api/exports/formal-reports/${pendingGroupGoalId}.csv`,
      ]) {
        const blocked = await app.inject({ method: "GET", url, headers: { cookie: leaderCookie } });
        assert.equal(blocked.statusCode, 409, `${url}: ${blocked.body}`);
        assert.equal(blocked.json().code, "TARGET_NOT_ACTIVE");
      }
      for (const [goalId, username, reason] of [
        [gatedGoalIds["2099-09"], "scope_alice", "PERIOD_IN_FUTURE"],
        [gatedGoalIds["2026-07"], "scope_bob", "TARGET_AMOUNT_NOT_POSITIVE"],
      ] as const) {
        const cookie = await loginCookie(app, username);
        for (const url of [
          `/api/performance/formal-reports/${goalId}`,
          `/api/exports/formal-reports/${goalId}.csv`,
        ]) {
          const blocked = await app.inject({ method: "GET", url, headers: { cookie } });
          assert.equal(blocked.statusCode, 409, `${url}: ${blocked.body}`);
          assert.equal(blocked.json().code, reason);
        }
      }

      const cases = [
        { level: "personal", goalId: scenario.goalIds[0]!, username: "scope_alice", deniedUsername: "scope_bob", ownerName: "业务员甲", targetAmount: "1000.00", actualAmount: "100.00", gapAmount: "900.00", achievementRate: "10.00", actorUserId: scenario.users.alice },
        { level: "group", goalId: goalIds.group!, username: "scope_leader", deniedUsername: "scope_carol", ownerName: "甲组组长", targetAmount: "2000.00", actualAmount: "200.00", gapAmount: "1800.00", achievementRate: "10.00", actorUserId: scenario.users.leader },
        { level: "department", goalId: goalIds.department!, username: "scope_supervisor", deniedUsername: "scope_leader", ownerName: "甲部主管", targetAmount: "5000.00", actualAmount: "200.00", gapAmount: "4800.00", achievementRate: "4.00", actorUserId: scenario.users.supervisor },
        { level: "sales_manager", goalId: goalIds.sales_manager!, username: "scope_manager", deniedUsername: "scope_supervisor", ownerName: "销售经理", targetAmount: "10000.00", actualAmount: "300.00", gapAmount: "9700.00", achievementRate: "3.00", actorUserId: scenario.users.manager },
      ] as const;
      const expectedHashes = new Map<string, string>();
      for (const item of cases) {
        const cookie = await loginCookie(app, item.username);
        const dashboard = await app.inject({ method: "GET", url: "/api/performance/dashboard?month=2026-08", headers: { cookie } });
        assert.equal(dashboard.statusCode, 200, dashboard.body);
        const dashboardBody = dashboard.json();
        const dashboardAchievement = item.level === "personal"
          ? dashboardBody.personalAchievement
          : item.level === "group"
            ? dashboardBody.groupAchievements.find((achievement: { goalId: string | null }) => achievement.goalId === item.goalId)
            : item.level === "department"
              ? dashboardBody.departmentAchievements.find((achievement: { goalId: string | null }) => achievement.goalId === item.goalId)
              : dashboardBody.salesAchievement;
        assert.deepEqual(
          {
            targetAmount: dashboardAchievement?.targetAmount,
            actualAmount: dashboardAchievement?.actualAmount,
            gapAmount: dashboardAchievement?.gapAmount,
            achievementRate: dashboardAchievement?.achievementRate,
          },
          { targetAmount: item.targetAmount, actualAmount: item.actualAmount, gapAmount: item.gapAmount, achievementRate: item.achievementRate },
        );
        const activeReport = await app.inject({
          method: "GET",
          url: `/api/performance/formal-reports/${item.goalId}`,
          headers: { cookie },
        });
        assert.equal(activeReport.statusCode, 200, activeReport.body);
        assert.deepEqual(activeReport.json(), {
          goalId: item.goalId,
          periodMonth: "2026-08",
          level: item.level,
          ownerName: item.ownerName,
          targetAmount: item.targetAmount,
          actualAmount: item.actualAmount,
          gapAmount: item.gapAmount,
          achievementRate: item.achievementRate,
        });

        const activeExport = await app.inject({
          method: "GET",
          url: `/api/exports/formal-reports/${item.goalId}.csv`,
          headers: { cookie },
        });
        assert.equal(activeExport.statusCode, 200, activeExport.body);
        assert.match(String(activeExport.headers["content-type"]), /^text\/csv/);
        const expectedRow = ["2026-08", item.level, item.ownerName, item.targetAmount, item.actualAmount, item.gapAmount, `${item.achievementRate}%`]
          .map((value) => `"${value}"`).join(",");
        assert.ok(activeExport.body.includes(expectedRow), activeExport.body);
        expectedHashes.set(item.goalId, createHash("sha256").update(activeExport.body).digest("hex"));

        const deniedCookie = await loginCookie(app, item.deniedUsername);
        for (const url of [
          `/api/performance/formal-reports/${item.goalId}`,
          `/api/exports/formal-reports/${item.goalId}.csv`,
        ]) {
          const denied = await app.inject({ method: "GET", url, headers: { cookie: deniedCookie } });
          assert.equal(denied.statusCode, 404, `${url}: ${denied.body}`);
        }
      }

      const adminCookie = await loginCookie(app, "scope_admin");
      for (const url of [
        `/api/performance/formal-reports/${scenario.goalIds[0]}`,
        `/api/exports/formal-reports/${scenario.goalIds[0]}.csv`,
      ]) {
        const adminDenied = await app.inject({ method: "GET", url, headers: { cookie: adminCookie } });
        assert.equal(adminDenied.statusCode, 403, adminDenied.body);
      }

      const hrCookie = await loginCookie(app, "scope_hr");
      const hrReport = await app.inject({
        method: "GET",
        url: `/api/performance/formal-reports/${scenario.goalIds[0]}`,
        headers: { cookie: hrCookie },
      });
      assert.equal(hrReport.statusCode, 200, hrReport.body);

      const verification = new Client({ connectionString: database.url });
      await verification.connect();
      try {
        const completed = await verification.query<{
          actor_user_id: string;
          entity_id: string;
          before_data: unknown;
          after_data: { filterSummary: { goalId: string; periodMonth: string; level: string }; rowCount: number; status: string; requestId: string; fileSha256: string | null };
        }>(
          `select actor_user_id::text,entity_id,before_data,after_data
           from audit_logs
           where action='performance.formal_report_export' and after_data->>'status'='completed'
           order by entity_id::bigint`,
        );
        assert.equal(completed.rowCount, cases.length);
        for (const audit of completed.rows) {
          const expected = cases.find((item) => item.goalId === audit.entity_id)!;
          assert.equal(audit.actor_user_id, expected.actorUserId);
          assert.equal(audit.before_data, null);
          assert.deepEqual(audit.after_data.filterSummary, { goalId: expected.goalId, periodMonth: "2026-08", level: expected.level });
          assert.equal(audit.after_data.rowCount, 1);
          assert.equal(audit.after_data.status, "completed");
          assert.ok(audit.after_data.requestId);
          assert.equal(audit.after_data.fileSha256, expectedHashes.get(expected.goalId));
          assert.doesNotMatch(JSON.stringify(audit.after_data), /正式业绩报表|目标月份/);
        }
        const blockedAudit = await verification.query<{ after_data: { rowCount: number; status: string; requestId: string; fileSha256: string | null; failureCode: string } }>(
          `select after_data from audit_logs
           where action='performance.formal_report_export' and entity_id=$1 and after_data->>'status'='blocked'`,
          [pendingGroupGoalId],
        );
        assert.equal(blockedAudit.rowCount, 1);
        assert.deepEqual(
          {
            rowCount: blockedAudit.rows[0]!.after_data.rowCount,
            status: blockedAudit.rows[0]!.after_data.status,
            fileSha256: blockedAudit.rows[0]!.after_data.fileSha256,
            failureCode: blockedAudit.rows[0]!.after_data.failureCode,
          },
          { rowCount: 0, status: "blocked", fileSha256: null, failureCode: "TARGET_NOT_ACTIVE" },
        );
        assert.ok(blockedAudit.rows[0]!.after_data.requestId);
      } finally {
        await verification.end();
      }
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
