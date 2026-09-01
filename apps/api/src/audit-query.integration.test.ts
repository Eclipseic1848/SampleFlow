import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Client } = pg;
const TEST_ORIGIN = "http://127.0.0.1:4174";
const apiRoot = fileURLToPath(new URL("../", import.meta.url));

type AuditRow = Readonly<{
  action: string;
  actorDisplayName: string | null;
  afterData: unknown;
  entityId: string | null;
  entityType: string;
  id: string;
}>;

async function loginCookie(app: Parameters<Parameters<typeof withTestApi>[1]>[0], username: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: TEST_ORIGIN },
    payload: { username, password: "Audit@123" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookies = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"]
    : [String(response.headers["set-cookie"])];
  return cookies.map((value) => String(value).split(";", 1)[0]).join("; ");
}

async function seedAuditScenario(databaseUrl: string) {
  const users = {
    admin: await seedTestUser(databaseUrl, { username: "audit_admin", displayName: "审计系统管理员", password: "Audit@123", roleCode: "system_admin", roleName: "系统管理员" }),
    hr: await seedTestUser(databaseUrl, { username: "audit_hr", displayName: "审计人事", password: "Audit@123", roleCode: "hr", roleName: "人事部" }),
    generalManager: await seedTestUser(databaseUrl, { username: "audit_gm", displayName: "审计总经理", password: "Audit@123", roleCode: "general_manager", roleName: "总经理" }),
    leader: await seedTestUser(databaseUrl, { username: "audit_leader", displayName: "审计甲组组长", password: "Audit@123", roleCode: "sales_leader", roleName: "业务员组长" }),
    alice: await seedTestUser(databaseUrl, { username: "audit_alice", displayName: "审计业务员甲", password: "Audit@123", roleCode: "salesperson", roleName: "业务员" }),
    bob: await seedTestUser(databaseUrl, { username: "audit_bob", displayName: "审计乙组组长", password: "Audit@123", roleCode: "sales_leader", roleName: "业务员组长" }),
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const peopleResult = await client.query<{ person_id: string; user_id: string }>(
      "select user_id::text,p.id::text as person_id from people p where user_id=any($1::bigint[])",
      [Object.values(users)],
    );
    const people = Object.fromEntries(peopleResult.rows.map((row) => [row.user_id, row.person_id])) as Record<string, string>;
    const departmentA = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('审计甲部','department') returning id::text");
    const departmentB = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('审计乙部','department') returning id::text");
    const groupA = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('审计甲组','group',$1) returning id::text", [departmentA.rows[0]!.id]);
    const groupB = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('审计乙组','group',$1) returning id::text", [departmentB.rows[0]!.id]);
    await client.query(
      `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
       values($1,$2,'leader',current_date-60),($3,$4,'leader',current_date-60),
             ($5,$6,'supervisor',current_date-60),($5,$7,'supervisor',current_date-60)`,
      [people[users.leader], groupA.rows[0]!.id, people[users.bob], groupB.rows[0]!.id, people[users.admin], departmentA.rows[0]!.id, departmentB.rows[0]!.id],
    );
    await client.query(
      `insert into org_memberships(person_id,department_id,group_id,effective_from,effective_to)
       values($1,$2,$3,current_date-60,current_date-1),($1,$4,$5,current_date,null),
             ($6,$4,$5,current_date-60,current_date-1),($6,$2,$3,current_date,null)`,
      [people[users.alice], departmentA.rows[0]!.id, groupA.rows[0]!.id, departmentB.rows[0]!.id, groupB.rows[0]!.id, people[users.bob]],
    );

    const orders: string[] = [];
    for (const [index, snapshot] of [
      { userId: users.alice, personId: people[users.alice]!, name: "审计业务员甲", departmentId: departmentA.rows[0]!.id, departmentName: "审计甲部", groupId: groupA.rows[0]!.id, groupName: "审计甲组" },
      { userId: users.bob, personId: people[users.bob]!, name: "审计业务员乙", departmentId: departmentB.rows[0]!.id, departmentName: "审计乙部", groupId: groupB.rows[0]!.id, groupName: "审计乙组" },
    ].entries()) {
      const order = await client.query<{ id: string }>(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values($1,$2,'审计测试单位',$3,$2,current_date-30,100,100,100,'active',now()) returning id::text`,
        [`AUDIT-${index + 1}`, snapshot.name, snapshot.personId],
      );
      orders.push(order.rows[0]!.id);
      await client.query(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
          salesperson_person_id,salesperson_name,department_unit_id,department_name,group_unit_id,group_name,leader_name,supervisor_name,created_at)
         values($1,'initial',100,100,100,date_trunc('month',current_date)::date,current_date-30,'审计范围测试',$2,$3,$4,$5,$6,$7,'审计组长','审计主管',now()-interval '10 minutes')`,
        [order.rows[0]!.id, snapshot.personId, snapshot.name, snapshot.departmentId, snapshot.departmentName, snapshot.groupId, snapshot.groupName],
      );
    }

    const parentGoal = await client.query<{ id: string }>(
      `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,org_unit_id)
       values(date_trunc('month',current_date)::date,'group',$1,$2,$3) returning id::text`,
      [users.leader, people[users.leader], groupA.rows[0]!.id],
    );
    const goal = await client.query<{ id: string }>(
      `insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id)
       values(date_trunc('month',current_date)::date,'personal',$1,$2,$3) returning id::text`,
      [users.alice, people[users.alice], parentGoal.rows[0]!.id],
    );
    const version = await client.query<{ id: string }>(
      `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
       values($1,1,1000,'active',$2,$3,'审计查询测试') returning id::text`,
      [goal.rows[0]!.id, users.leader, people[users.leader]],
    );
    const linkage = await client.query<{ id: string }>(
      `insert into goal_linkage_decisions(parent_goal_id,triggering_child_version_id,status)
       values($1,$2,'pending') returning id::text`,
      [parentGoal.rows[0]!.id, version.rows[0]!.id],
    );

    await client.query(
      `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,created_at) values
       ($1::bigint,'auth.account_created','user',$1::text,null,now()-interval '6 minutes'),
       ($1::bigint,'organization.unit_created','org_unit',$2::text,null,now()-interval '5 minutes'),
       ($3::bigint,'performance.order_posted','performance_order',$4::text,$5::jsonb,now()-interval '4 minutes'),
       ($6::bigint,'performance.order_posted','performance_order',$7::text,null,now()-interval '3 minutes'),
       ($8::bigint,'goal.version_created','goal_version',$9::text,null,now()-interval '2 minutes'),
       ($8::bigint,'goal.linkage_requested','goal_linkage_decision',$10::text,null,now()-interval '90 seconds'),
       ($3::bigint,'performance.order_posted','performance_order','9223372036854775808',null,now()-interval '1 minute')`,
      [
        users.admin,
        groupA.rows[0]!.id,
        users.alice,
        orders[0],
        JSON.stringify({ customer: "可见业务数据", password: "PASSWORD-CANARY", nested: { temporaryPassword: "TEMP-CANARY", token: "TOKEN-CANARY" } }),
        users.bob,
        orders[1],
        users.leader,
        version.rows[0]!.id,
        linkage.rows[0]!.id,
      ],
    );
    return { orders, users };
  } finally {
    await client.end();
  }
}

test("审计查询按管理域、业务域和事件组织快照隔离", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuditScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const adminCookie = await loginCookie(app, "audit_admin");
      const admin = await app.inject({ method: "GET", url: "/api/audits", headers: { cookie: adminCookie } });
      assert.equal(admin.statusCode, 200, admin.body);
      assert.deepEqual(admin.json<{ audits: AuditRow[] }>().audits.map((row) => row.action).sort(), ["auth.account_created", "auth.login_succeeded", "organization.unit_created"]);

      const roleClient = new Client({ connectionString: database.url });
      await roleClient.connect();
      try {
        await roleClient.query("insert into user_roles(user_id,role_code) values($1,'hr')", [scenario.users.admin]);
      } finally {
        await roleClient.end();
      }
      const combined = await app.inject({ method: "GET", url: "/api/audits", headers: { cookie: adminCookie } });
      assert.equal(combined.statusCode, 200, combined.body);
      assert.deepEqual(new Set(combined.json<{ audits: AuditRow[] }>().audits.map((row) => row.action)), new Set(["auth.account_created", "auth.login_succeeded", "organization.unit_created", "goal.version_created", "goal.linkage_requested", "performance.order_posted"]));

      for (const username of ["audit_hr", "audit_gm"]) {
        const cookie = await loginCookie(app, username);
        const response = await app.inject({ method: "GET", url: "/api/audits", headers: { cookie } });
        assert.equal(response.statusCode, 200, response.body);
        const rows = response.json<{ audits: AuditRow[] }>().audits;
        assert.deepEqual(rows.map((row) => row.action).sort(), ["goal.linkage_requested", "goal.version_created", "performance.order_posted", "performance.order_posted"]);
        assert.doesNotMatch(JSON.stringify(rows), /PASSWORD-CANARY|TEMP-CANARY|TOKEN-CANARY|password|temporaryPassword|token/);
      }

      const leaderCookie = await loginCookie(app, "audit_leader");
      const leader = await app.inject({ method: "GET", url: "/api/audits", headers: { cookie: leaderCookie } });
      assert.equal(leader.statusCode, 200, leader.body);
      const leaderRows = leader.json<{ audits: AuditRow[] }>().audits;
      assert.equal(leaderRows.some((row) => row.entityId === scenario.orders[0]), true, "移出当前小组后，历史事件仍按发生时甲组快照可见");
      assert.equal(leaderRows.some((row) => row.entityId === scenario.orders[1]), false, "当前调入甲组不能扩大乙组历史事件权限");
      assert.equal(leaderRows.some((row) => row.action === "goal.version_created"), true);
      assert.equal(leaderRows.some((row) => row.action === "goal.linkage_requested"), true);

      const bobCookie = await loginCookie(app, "audit_bob");
      const bob = await app.inject({ method: "GET", url: "/api/audits", headers: { cookie: bobCookie } });
      assert.equal(bob.statusCode, 200, bob.body);
      const bobRows = bob.json<{ audits: AuditRow[] }>().audits;
      assert.equal(bobRows.some((row) => row.entityId === scenario.orders[1]), true);
      assert.equal(bobRows.some((row) => row.action === "goal.version_created"), false, "人员当前调入乙组不能扩大乙组组长的历史目标审计权限");
      assert.equal(bobRows.some((row) => row.action === "goal.linkage_requested"), false);

      const aliceCookie = await loginCookie(app, "audit_alice");
      const exported = await app.inject({ method: "GET", url: "/api/exports/performance.csv", headers: { cookie: aliceCookie } });
      assert.equal(exported.statusCode, 200, exported.body);
      assert.doesNotMatch(exported.body, /PASSWORD-CANARY|TEMP-CANARY|TOKEN-CANARY/);
      const aliceAudit = await app.inject({ method: "GET", url: "/api/audits?action=performance.order_export", headers: { cookie: aliceCookie } });
      assert.equal(aliceAudit.statusCode, 200, aliceAudit.body);
      assert.equal(aliceAudit.json<{ audits: AuditRow[] }>().audits.some((row) => row.entityType === "order_export" && row.actorDisplayName === "审计业务员甲"), true);
      const aliceLinkage = await app.inject({ method: "GET", url: "/api/audits?action=goal.linkage_requested", headers: { cookie: aliceCookie } });
      assert.equal(aliceLinkage.statusCode, 200, aliceLinkage.body);
      assert.equal(aliceLinkage.json<{ audits: AuditRow[] }>().audits.length, 1, "子目标责任人可见由本人目标版本触发的联动审计");
    });
  });
});

test("审计查询支持人员、动作、实体、时间和稳定游标过滤", async () => {
  await withMigratedTestDatabase(async (database) => {
    const scenario = await seedAuditScenario(database.url);
    await withTestApi(database.url, async (app) => {
      const cookie = await loginCookie(app, "audit_hr");
      const pageClient = new Client({ connectionString: database.url });
      await pageClient.connect();
      try {
        await pageClient.query(
          `insert into audit_logs(actor_user_id,action,entity_type,entity_id)
           select $1,'performance.cursor_test','performance_order',$2::text from generate_series(1,51)`,
          [scenario.users.alice, scenario.orders[0]],
        );
      } finally {
        await pageClient.end();
      }
      const inFlightClient = new Client({ connectionString: database.url });
      await inFlightClient.connect();
      await inFlightClient.query("begin");
      const inFlight = await inFlightClient.query<{ id: string }>(
        "insert into audit_logs(actor_user_id,action,entity_type,entity_id) values($1,'performance.cursor_test','performance_order',$2) returning id::text",
        [scenario.users.alice, scenario.orders[0]],
      );
      const inFlightId = inFlight.rows[0]!.id;
      let firstPageResolved = false;
      const firstPagePromise = app.inject({ method: "GET", url: "/api/audits?action=performance.cursor_test", headers: { cookie } })
        .then((response) => { firstPageResolved = true; return response; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const resolvedBeforeCommit = firstPageResolved;
      await inFlightClient.query("commit");
      await inFlightClient.end();
      const firstPage = await firstPagePromise;
      assert.equal(resolvedBeforeCommit, false, "首屏应等待已开始的审计写入提交后再冻结快照");
      assert.equal(firstPage.statusCode, 200, firstPage.body);
      const firstData = firstPage.json<{ audits: AuditRow[]; nextCursor: string | null }>();
      assert.equal(firstData.audits.length, 50);
      assert.ok(firstData.nextCursor);
      const concurrentClient = new Client({ connectionString: database.url });
      await concurrentClient.connect();
      let concurrentId: string;
      try {
        const inserted = await concurrentClient.query<{ id: string }>(
          "insert into audit_logs(actor_user_id,action,entity_type,entity_id) values($1,'performance.cursor_test','performance_order',$2) returning id::text",
          [scenario.users.alice, scenario.orders[0]],
        );
        concurrentId = inserted.rows[0]!.id;
      } finally {
        await concurrentClient.end();
      }
      const cursorPage = await app.inject({ method: "GET", url: `/api/audits?action=performance.cursor_test&cursor=${firstData.nextCursor}`, headers: { cookie } });
      assert.equal(cursorPage.statusCode, 200, cursorPage.body);
      const secondRows = cursorPage.json<{ audits: AuditRow[] }>().audits;
      assert.equal(secondRows.length, 2);
      const traversedIds = [...firstData.audits, ...secondRows].map((row) => row.id);
      assert.equal(new Set(traversedIds).size, 52);
      assert.equal(traversedIds.includes(inFlightId), true);
      assert.equal(traversedIds.includes(concurrentId), false);

      const mismatched = await app.inject({ method: "GET", url: `/api/audits?action=other.action&cursor=${firstData.nextCursor}`, headers: { cookie } });
      assert.equal(mismatched.statusCode, 400, mismatched.body);
      const otherUserCookie = await loginCookie(app, "audit_admin");
      const otherUser = await app.inject({ method: "GET", url: `/api/audits?action=performance.cursor_test&cursor=${firstData.nextCursor}`, headers: { cookie: otherUserCookie } });
      assert.equal(otherUser.statusCode, 400, otherUser.body);

      const query = new URLSearchParams({ person: "审计业务员甲", action: "performance.order_posted", entityType: "performance_order", entityId: scenario.orders[0]! });
      const response = await app.inject({ method: "GET", url: `/api/audits?${query}`, headers: { cookie } });
      assert.equal(response.statusCode, 200, response.body);
      const rows = response.json<{ audits: AuditRow[]; nextCursor: string | null }>().audits;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.actorDisplayName, "审计业务员甲");
      assert.equal(rows[0]!.entityId, scenario.orders[0]);

      const empty = await app.inject({ method: "GET", url: "/api/audits?to=2000-01-01T00%3A00%3A00.000Z", headers: { cookie } });
      assert.equal(empty.statusCode, 200, empty.body);
      assert.equal(empty.json<{ audits: AuditRow[] }>().audits.length, 0);
      const invalid = await app.inject({ method: "GET", url: "/api/audits?from=2026-09-02T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z", headers: { cookie } });
      assert.equal(invalid.statusCode, 400, invalid.body);
    });
  });
});

test("审计凭据 canary 不进入真实服务日志或业务 CSV", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedAuditScenario(database.url);
    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: { ...process.env, API_PORT: "3103", DATABASE_URL: database.runtimeUrl, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    api.stdout.setEncoding("utf8");
    api.stderr.setEncoding("utf8");
    api.stdout.on("data", (chunk: string) => { logs += chunk; });
    api.stderr.on("data", (chunk: string) => { logs += chunk; });
    try {
      let ready = false;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch("http://127.0.0.1:3103/api/ready");
          if (response.ok) { ready = true; break; }
        } catch {
          // 服务尚未监听时继续等待。
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(ready, true, logs);
      const login = await fetch("http://127.0.0.1:3103/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify({ username: "audit_hr", password: "Audit@123" }),
      });
      assert.equal(login.status, 200, await login.text());
      const cookie = login.headers.get("set-cookie")?.match(/sampleflow_session=[^;,]+/)?.[0];
      assert.ok(cookie);
      const audit = await fetch("http://127.0.0.1:3103/api/audits", { headers: { cookie } });
      assert.equal(audit.status, 200);
      assert.doesNotMatch(await audit.text(), /PASSWORD-CANARY|TEMP-CANARY|TOKEN-CANARY/);
      const csv = await fetch("http://127.0.0.1:3103/api/exports/performance.csv", { headers: { cookie } });
      assert.equal(csv.status, 200);
      assert.doesNotMatch(await csv.text(), /PASSWORD-CANARY|TEMP-CANARY|TOKEN-CANARY/);
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
    assert.doesNotMatch(logs, /PASSWORD-CANARY|TEMP-CANARY|TOKEN-CANARY/);
  });
});

test("审计日志在数据库层拒绝更新和删除", async () => {
  await withMigratedTestDatabase(async (database) => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const inserted = await client.query<{ id: string }>("insert into audit_logs(action,entity_type) values('audit.immutable_test','test') returning id::text");
      await assert.rejects(client.query("update audit_logs set action='audit.changed' where id=$1", [inserted.rows[0]!.id]), /审计日志不可更新或删除/);
      await assert.rejects(client.query("delete from audit_logs where id=$1", [inserted.rows[0]!.id]), /审计日志不可更新或删除/);
      const remaining = await client.query<{ action: string }>("select action from audit_logs where id=$1", [inserted.rows[0]!.id]);
      assert.equal(remaining.rows[0]?.action, "audit.immutable_test");
    } finally {
      await client.end();
    }
  });
});
