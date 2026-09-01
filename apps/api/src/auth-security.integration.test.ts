import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Client } = pg;
const execFileAsync = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const TEST_ORIGIN = "http://127.0.0.1:4174";

function authenticatedHeaders(response: {
  headers: Record<string, string | string[] | number | number[] | undefined>;
}): Record<string, string> {
  const setCookies = response.headers["set-cookie"];
  const cookieLines = Array.isArray(setCookies) ? setCookies.map(String) : [String(setCookies)];
  const cookieParts = cookieLines.map((value) => value.split(";", 1)[0] ?? "");
  const csrfCookie = cookieParts.find((value) => value.startsWith("sampleflow_csrf="));
  assert.ok(csrfCookie);
  return {
    cookie: cookieParts.join("; "),
    origin: "http://127.0.0.1:4174",
    "x-csrf-token": decodeURIComponent(csrfCookie.slice("sampleflow_csrf=".length)),
  };
}

test("首次改密前直接调用业务 API 会被服务端拒绝", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "password_gate_user",
      displayName: "首次改密测试用户",
      password: "Temp@1",
      mustChangePassword: true,
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });

    await withTestApi(database.url, async (app) => {
      const loginWithoutOrigin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "csrf_user", password: "Before@123" },
      });
      assert.equal(loginWithoutOrigin.statusCode, 403);
      assert.equal(loginWithoutOrigin.json().code, "ORIGIN_INVALID");

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "password_gate_user", password: "Temp@1" },
      });
      assert.equal(login.statusCode, 200);
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      assert.equal(me.statusCode, 200);

      const dashboard = await app.inject({
        method: "GET",
        url: "/api/performance/dashboard",
        headers: { cookie },
      });
      assert.equal(dashboard.statusCode, 403);
      assert.deepEqual(dashboard.json(), {
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "请先修改初始密码",
      });

      const businessWrite = await app.inject({
        method: "POST",
        url: "/api/performance/orders",
        headers: { cookie },
        payload: {},
      });
      assert.equal(businessWrite.statusCode, 403);
      assert.equal(businessWrite.json().code, "PASSWORD_CHANGE_REQUIRED");
    });
  });
});

test("改密接口统一执行六位字母数字符号规则", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "password_policy_user",
      displayName: "密码规则测试用户",
      password: "Temp@1",
      mustChangePassword: true,
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });

    await withTestApi(database.url, async (app) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "password_policy_user", password: "Temp@1" },
      });
      const headers = authenticatedHeaders(login);

      const invalid = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers,
        payload: { currentPassword: "Temp@1", newPassword: "abcdef" },
      });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().code, "PASSWORD_POLICY_INVALID");

      const changed = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers,
        payload: { currentPassword: "Temp@1", newPassword: "Abc@12" },
      });
      assert.equal(changed.statusCode, 200);

      const dashboard = await app.inject({
        method: "GET",
        url: "/api/performance/dashboard",
        headers: { cookie: headers.cookie },
      });
      assert.equal(dashboard.statusCode, 200);
    });
  });
});

test("同一旧密码的并发改密最多一个成功", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "password_race_user",
      displayName: "并发改密用户",
      password: "Before@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });

    await withTestApi(database.url, async (app) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "password_race_user", password: "Before@123" },
      });
      const headers = authenticatedHeaders(login);
      const responses = await Promise.all(["AfterA@123", "AfterB@123"].map((newPassword) => app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers,
        payload: { currentPassword: "Before@123", newPassword },
      })));
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 401]);
    });
  });
});

test("不存在和停用账号仍执行同一 dummy 密码验证路径", async () => {
  await withMigratedTestDatabase(async (database) => {
    const inactiveId = await seedTestUser(database.url, {
      username: "inactive_timing_user",
      displayName: "停用计时用户",
      password: "Inactive@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query("update users set is_active=false where id=$1", [inactiveId]);
    await client.end();
    const calls: Array<{ hash: string; salt: string }> = [];

    await withTestApi(database.url, async (app) => {
      for (const username of ["missing_timing_user", "inactive_timing_user"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: TEST_ORIGIN },
          payload: { username, password: "Wrong@123" },
        });
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), { message: "账号或密码错误" });
      }
    }, {
      passwordVerifier: async (_password, hash, salt) => {
        calls.push({ hash, salt });
        return false;
      },
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  });
});

test("并发角色和状态修改始终保留一个启用的系统管理员", async () => {
  await withMigratedTestDatabase(async (database) => {
    const adminA = await seedTestUser(database.url, { username: "invariant_admin_a", displayName: "不变量管理员甲", password: "AdminA@123", roleCode: "system_admin", roleName: "系统管理员" });
    const adminB = await seedTestUser(database.url, { username: "invariant_admin_b", displayName: "不变量管理员乙", password: "AdminB@123", roleCode: "system_admin", roleName: "系统管理员" });
    await seedTestUser(database.url, { username: "invariant_role_fixture", displayName: "不变量角色夹具", password: "Role@123", roleCode: "salesperson", roleName: "业务员" });
    const lock = new Client({ connectionString: database.url });
    await lock.connect();
    try {
      await withTestApi(database.url, async (app) => {
        const loginA = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: TEST_ORIGIN }, payload: { username: "invariant_admin_a", password: "AdminA@123" } });
        const loginB = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: TEST_ORIGIN }, payload: { username: "invariant_admin_b", password: "AdminB@123" } });
        await lock.query("select pg_advisory_lock(hashtext('sampleflow.active-system-admin'))");
        const requests = Promise.all([
          app.inject({ method: "PATCH", url: `/api/admin/users/${adminB}/roles`, headers: authenticatedHeaders(loginA), payload: { roles: ["salesperson"] } }),
          app.inject({ method: "PATCH", url: `/api/admin/users/${adminA}/status`, headers: authenticatedHeaders(loginB), payload: { isActive: false } }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await lock.query("select pg_advisory_unlock(hashtext('sampleflow.active-system-admin'))");
        const responses = await requests;
        assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409], responses.map((response) => response.body).join("\n"));
      });

      const activeAdmins = await lock.query<{ count: string }>(
        `select count(*)::text as count from users user_account
         join user_roles role on role.user_id=user_account.id
         where user_account.is_active and role.role_code='system_admin'`,
      );
      assert.equal(activeAdmins.rows[0]!.count, "1");
    } finally {
      await lock.query("select pg_advisory_unlock_all()").catch(() => undefined);
      await lock.end();
    }
  });
});

test("管理员账号路径和 body ID 按 bigint 字符串传递且不发生精度别名", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, { username: "bigint_admin", displayName: "大整数管理员", password: "Admin@123", roleCode: "system_admin", roleName: "系统管理员" });
    await seedTestUser(database.url, { username: "bigint_role_fixture", displayName: "大整数角色夹具", password: "Role@123", roleCode: "salesperson", roleName: "业务员" });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query(
        `insert into users(id,username,display_name,password_hash,password_salt,must_change_password) overriding system value
         select $1,'bigint_target','大整数目标',password_hash,password_salt,false from users where username='bigint_admin'`,
        ["9007199254740992"],
      );
      await client.query(
        `insert into people(id,display_name,identity_source,source_key) overriding system value
         values($1,'大整数人员','test','test:bigint-person')`,
        ["9007199254740992"],
      );
      await client.query(
        `insert into org_units(id,name,unit_type,parent_id,is_active) overriding system value
         values($1,'大整数部门','department',null,false),($2,'大整数小组','group',$1,false)`,
        ["9007199254740992", "9007199254740994"],
      );

      await withTestApi(database.url, async (app) => {
        const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: TEST_ORIGIN }, payload: { username: "bigint_admin", password: "Admin@123" } });
        const headers = authenticatedHeaders(login);
        const pathResponse = await app.inject({ method: "PATCH", url: "/api/admin/users/9007199254740993/status", headers, payload: { isActive: false } });
        assert.equal(pathResponse.statusCode, 404, pathResponse.body);
        const createResponse = await app.inject({
          method: "POST",
          url: "/api/admin/users",
          headers,
          payload: { username: "bigint_body_target", displayName: "大整数 body 目标", roles: ["salesperson"], personId: "9007199254740993" },
        });
        assert.equal(createResponse.statusCode, 404, createResponse.body);
        const unitResponse = await app.inject({
          method: "POST",
          url: "/api/admin/organization/units",
          headers,
          payload: { name: "大整数别名小组", unitType: "group", parentId: 9007199254740993 },
        });
        assert.equal(unitResponse.statusCode, 400, unitResponse.body);
        const assignmentResponse = await app.inject({
          method: "POST",
          url: "/api/admin/organization/assignments",
          headers,
          payload: {
            personId: 9007199254740993,
            departmentId: 9007199254740993,
            groupId: 9007199254740993,
            leaderPersonId: 9007199254740993,
            supervisorPersonId: 9007199254740993,
            effectiveFrom: "2026-09-01",
          },
        });
        assert.equal(assignmentResponse.statusCode, 400, assignmentResponse.body);
      });

      const target = await client.query<{ is_active: boolean }>("select is_active from users where id=$1", ["9007199254740992"]);
      assert.equal(target.rows[0]!.is_active, true);
      const highPerson = await client.query<{ user_id: string | null }>("select user_id::text from people where id=$1", ["9007199254740992"]);
      assert.equal(highPerson.rows[0]!.user_id, null);
      const aliases = await client.query<{ users: string; units: string; memberships: string }>(
        `select (select count(*) from users where username='bigint_body_target')::text as users,
                (select count(*) from org_units where name='大整数别名小组')::text as units,
                (select count(*) from org_memberships where person_id=$1)::text as memberships`,
        ["9007199254740992"],
      );
      assert.deepEqual(aliases.rows[0], { users: "0", units: "0", memberships: "0" });
    } finally {
      await client.end();
    }
  });
});

test("管理员创建账号的一次性临时密码可完成首次改密", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "security_admin",
      displayName: "认证管理员",
      password: "Admin@123",
      roleCode: "system_admin",
      roleName: "系统管理员",
    });
    await seedTestUser(database.url, {
      username: "role_fixture_user",
      displayName: "角色夹具用户",
      password: "Role@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });

    await withTestApi(database.url, async (app) => {
      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "security_admin", password: "Admin@123" },
      });
      const adminHeaders = authenticatedHeaders(adminLogin);

      const created = await app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: adminHeaders,
        payload: {
          username: "generated_password_user",
          displayName: "系统生成密码用户",
          roles: ["salesperson"],
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const result = created.json() as { id: string; temporaryPassword: string; temporaryPasswordExpiresAt: string };
      assert.match(result.temporaryPassword, /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9])[\x21-\x7e]{16,128}$/);
      assert.ok(Date.parse(result.temporaryPasswordExpiresAt) > Date.now());

      const userLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "generated_password_user", password: result.temporaryPassword },
      });
      assert.equal(userLogin.statusCode, 200);
      const userCookie = String(userLogin.headers["set-cookie"]).split(";", 1)[0];
      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: userCookie } });
      assert.equal(me.json().user.mustChangePassword, true);

      const changed = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: authenticatedHeaders(userLogin),
        payload: { currentPassword: result.temporaryPassword, newPassword: "Changed@123" },
      });
      assert.equal(changed.statusCode, 200, changed.body);
      const changedMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: userCookie } });
      assert.equal(changedMe.json().user.mustChangePassword, false);

      const changedLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "generated_password_user", password: "Changed@123" },
      });
      assert.equal(changedLogin.statusCode, 200, changedLogin.body);
    });
  });
});

test("管理员可将新账号绑定已有人员身份且不制造重复人员", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url,{ username:"binding_admin",displayName:"绑定管理员",password:"Admin@123",roleCode:"system_admin",roleName:"系统管理员" });
    await seedTestUser(database.url,{ username:"binding_role_fixture",displayName:"绑定角色夹具",password:"Role@123",roleCode:"salesperson",roleName:"业务员" });
    const client=new Client({connectionString:database.url});
    await client.connect();
    const person=await client.query<{id:string}>(
      "insert into people(display_name,identity_source,source_key) values('历史人员甲','test','test:historical-person') returning id::text",
    );
    const before=await client.query<{count:string}>("select count(*)::text as count from people");
    await client.end();
    await withTestApi(database.url,async(app)=>{
      const login=await app.inject({method:"POST",url:"/api/auth/login",headers:{origin:TEST_ORIGIN},payload:{username:"binding_admin",password:"Admin@123"}});
      const created=await app.inject({
        method:"POST",url:"/api/admin/users",headers:authenticatedHeaders(login),
        payload:{username:"bound_historical_user",displayName:"历史人员登录账号",roles:["salesperson"],personId:person.rows[0]!.id},
      });
      assert.equal(created.statusCode,201,created.body);
      const verification=new Client({connectionString:database.url});
      await verification.connect();
      const linked=await verification.query<{person_id:string;count:string}>(
        `select p.id::text as person_id,(select count(*) from people)::text as count
         from users u join people p on p.user_id=u.id where u.username='bound_historical_user'`,
      );
      await verification.end();
      assert.equal(linked.rows[0]!.person_id,person.rows[0]!.id);
      assert.equal(linked.rows[0]!.count,before.rows[0]!.count);
    });
  });
});

test("临时密码过期后即使密码正确也不能登录", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "expired_password_user",
      displayName: "临时密码过期用户",
      password: "Expired@123",
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() - 60_000),
      roleCode: "salesperson",
      roleName: "业务员",
    });

    await withTestApi(database.url, async (app) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "expired_password_user", password: "Expired@123" },
      });
      assert.equal(login.statusCode, 401);
      assert.deepEqual(login.json(), {
        code: "TEMPORARY_PASSWORD_EXPIRED",
        message: "临时密码已过期，请联系管理员重置",
      });
    });
  });
});

test("会话连续三十分钟无活动后自动失效", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "idle_session_user",
      displayName: "闲置会话用户",
      password: "Idle@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });

    await withTestApi(database.url, async (app) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "idle_session_user", password: "Idle@123" },
      });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

      const client = new Client({ connectionString: database.url });
      await client.connect();
      try {
        await client.query("update sessions set last_seen_at=now()-interval '31 minutes'");
      } finally {
        await client.end();
      }

      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      assert.equal(me.statusCode, 401);
    });
  });
});

test("连续登录失败会触发账号级递增限速和暂停", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "rate_limited_user",
      displayName: "登录限速用户",
      password: "Correct@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });

    let now = new Date("2026-08-27T08:00:00.000Z");
    const advance = (seconds: number) => { now = new Date(now.getTime() + seconds * 1000); };
    await withTestApi(database.url, async (app) => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const failed = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: TEST_ORIGIN },
          payload: { username: "rate_limited_user", password: "Wrong@123" },
        });
        assert.equal(failed.statusCode, 401);
        assert.deepEqual(failed.json(), { message: "账号或密码错误" });
      }

      const delayed = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "rate_limited_user", password: "Wrong@123" },
      });
      assert.equal(delayed.statusCode, 429);
      assert.equal(delayed.headers["retry-after"], "1");

      for (let failureCount = 6; failureCount <= 10; failureCount += 1) {
        advance(failureCount === 6 ? 1 : 2 ** (failureCount - 6));
        const failed = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: TEST_ORIGIN },
          payload: { username: "rate_limited_user", password: "Wrong@123" },
        });
        assert.equal(failed.statusCode, 401);
      }

      const suspended = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "rate_limited_user", password: "Correct@123" },
      });
      assert.equal(suspended.statusCode, 429);
      assert.equal(suspended.headers["retry-after"], "1800");
      assert.deepEqual(suspended.json(), {
        code: "LOGIN_RATE_LIMITED",
        message: "登录尝试过多，请稍后再试",
      });

      advance(16 * 60);
      const stillSuspended = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "rate_limited_user", password: "Correct@123" },
      });
      assert.equal(stillSuspended.statusCode, 429);
      assert.equal(stillSuspended.headers["retry-after"], "840");

      advance(14 * 60);
      const restored = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "rate_limited_user", password: "Correct@123" },
      });
      assert.equal(restored.statusCode, 200);
    }, { clock: () => now });
  });
});

test("并发登录失败不会丢失账号级限速计数", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "concurrent_rate_limit_user",
      displayName: "并发登录限速用户",
      password: "Correct@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });

    await withTestApi(database.url, async (app) => {
      const failures = await Promise.all(Array.from({ length: 10 }, () => app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "concurrent_rate_limit_user", password: "Wrong@123" },
      })));
      assert.ok(failures.every((response) => response.statusCode === 401));

      const client = new Client({ connectionString: database.url });
      await client.connect();
      try {
        const throttle = await client.query<{ failure_count: number }>(
          "select failure_count from auth_login_throttles where scope='account' and throttle_key=$1",
          ["concurrent_rate_limit_user"],
        );
        assert.equal(throttle.rows[0]?.failure_count, 10);
      } finally {
        await client.end();
      }

      const suspended = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "concurrent_rate_limit_user", password: "Correct@123" },
      });
      assert.equal(suspended.statusCode, 429);
      assert.equal(suspended.headers["retry-after"], "1800");
    });
  });
});

test("Cookie 会话写请求必须同时通过 Origin 和 CSRF 校验", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "csrf_user",
      displayName: "CSRF 测试用户",
      password: "Before@123",
      mustChangePassword: true,
      roleCode: "salesperson",
      roleName: "业务员",
    });

    await withTestApi(database.url, async (app) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "csrf_user", password: "Before@123" },
      });
      const setCookies = login.headers["set-cookie"];
      const cookieLines = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
      const cookie = cookieLines.map((value) => value.split(";", 1)[0]).join("; ");
      const csrfCookie = cookieLines
        .map((value) => value.split(";", 1)[0] ?? "")
        .find((value) => value.startsWith("sampleflow_csrf="));
      assert.ok(csrfCookie);
      const csrfToken = decodeURIComponent(csrfCookie.slice("sampleflow_csrf=".length));

      const missingProtection = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie },
        payload: { currentPassword: "Before@123", newPassword: "After@123" },
      });
      assert.equal(missingProtection.statusCode, 403);
      assert.equal(missingProtection.json().code, "CSRF_INVALID");

      const wrongOrigin = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie, origin: "https://attacker.example", "x-csrf-token": csrfToken },
        payload: { currentPassword: "Before@123", newPassword: "After@123" },
      });
      assert.equal(wrongOrigin.statusCode, 403);
      assert.equal(wrongOrigin.json().code, "ORIGIN_INVALID");

      const changed = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie, origin: "http://127.0.0.1:4174", "x-csrf-token": csrfToken },
        payload: { currentPassword: "Before@123", newPassword: "After@123" },
      });
      assert.equal(changed.statusCode, 200);
    });
  });
});

test("重置密码和停用账号会立即撤销目标账号会话", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "session_admin",
      displayName: "会话管理员",
      password: "Admin@123",
      roleCode: "system_admin",
      roleName: "系统管理员",
    });
    const targetUserId = await seedTestUser(database.url, {
      username: "session_target",
      displayName: "会话目标用户",
      password: "Original@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });

    await withTestApi(database.url, async (app) => {
      const targetLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "session_target", password: "Original@123" },
      });
      const targetHeaders = authenticatedHeaders(targetLogin);

      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "session_admin", password: "Admin@123" },
      });
      const adminHeaders = authenticatedHeaders(adminLogin);
      const reset = await app.inject({
        method: "POST",
        url: `/api/admin/users/${targetUserId}/reset-password`,
        headers: adminHeaders,
        payload: {},
      });
      assert.equal(reset.statusCode, 200);
      const temporaryPassword = reset.json().temporaryPassword as string;

      const oldSession = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: targetHeaders.cookie },
      });
      assert.equal(oldSession.statusCode, 401);
      const oldPassword = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "session_target", password: "Original@123" },
      });
      assert.equal(oldPassword.statusCode, 401);

      const temporaryLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "session_target", password: temporaryPassword },
      });
      assert.equal(temporaryLogin.statusCode, 200);
      const temporaryHeaders = authenticatedHeaders(temporaryLogin);

      const disabled = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${targetUserId}/status`,
        headers: adminHeaders,
        payload: { isActive: false },
      });
      assert.equal(disabled.statusCode, 200);
      const disabledSession = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: temporaryHeaders.cookie },
      });
      assert.equal(disabledSession.statusCode, 401);
    });
  });
});

test("维护清理命令仅删除保留期外的会话和已过期限流记录", async () => {
  await withMigratedTestDatabase(async (database) => {
    const userId = await seedTestUser(database.url, {
      username: "session_cleanup_user",
      displayName: "会话清理用户",
      password: "Cleanup@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query(
        `insert into sessions(user_id,token_hash,expires_at,revoked_at)
         values
           ($1,'expired-old',now()-interval '31 days',null),
           ($1,'revoked-old',now()+interval '1 day',now()-interval '31 days'),
           ($1,'revoked-recent',now()+interval '1 day',now()-interval '1 day')`,
        [userId],
      );
      await client.query(
        `insert into auth_login_throttles(scope,throttle_key,window_started_at,failure_count,blocked_until,updated_at)
         values
           ('account','expired-throttle',now()-interval '40 days',10,now()-interval '31 days',now()-interval '31 days'),
           ('account','recent-throttle',now()-interval '40 days',1,null,now()-interval '1 day'),
           ('ip','blocked-throttle',now()-interval '40 days',10,now()+interval '1 day',now()-interval '31 days')`,
      );
    } finally {
      await client.end();
    }

    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/cleanup-sessions.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      encoding: "utf8",
    });
    assert.match(result.stdout, /已删除 2 条会话/);
    assert.match(result.stdout, /已删除 1 条登录限流/);

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    try {
      const remaining = await verify.query<{ token_hash: string }>("select token_hash from sessions order by token_hash");
      assert.deepEqual(remaining.rows.map((row) => row.token_hash), ["revoked-recent"]);
      const throttles = await verify.query<{ throttle_key: string }>("select throttle_key from auth_login_throttles order by throttle_key");
      assert.deepEqual(throttles.rows.map((row) => row.throttle_key), ["blocked-throttle", "recent-throttle"]);
      const cleanupIndex = await verify.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where schemaname='public' and indexname='auth_login_throttles_updated_at_idx'",
      );
      assert.match(cleanupIndex.rows[0]!.indexdef, /updated_at/);
    } finally {
      await verify.end();
    }
  });
});

test("生产初始化命令生成一次性临时密码并拒绝重复执行", async () => {
  await withMigratedTestDatabase(async (database) => {
    const created = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/bootstrap-admin.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: database.url,
        NODE_ENV: "production",
        BOOTSTRAP_ADMIN_USERNAME: "valid_bootstrap_admin",
      },
      encoding: "utf8",
    });
    const temporaryPassword = created.stdout.match(/临时密码（仅显示一次）：([^\r\n]+)/)?.[1];
    assert.ok(temporaryPassword);
    assert.match(temporaryPassword, /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9])[\x21-\x7e]{16,128}$/);
    assert.equal(created.stdout.split(temporaryPassword).length - 1, 1);
    assert.match(created.stdout, /失效时间：\d{4}-\d{2}-\d{2}T/);

    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const user = await client.query<{ temporary_password_expires_at: Date }>(
        "select temporary_password_expires_at from users where username=$1",
        ["valid_bootstrap_admin"],
      );
      const expiresAt = user.rows[0]!.temporary_password_expires_at.getTime();
      assert.ok(expiresAt >= Date.now() + 23 * 60 * 60 * 1000);
      assert.ok(expiresAt <= Date.now() + 24 * 60 * 60 * 1000);
      const audit = await client.query<{ after_data: unknown }>(
        "select after_data from audit_logs where action='auth.admin_bootstrapped'",
      );
      assert.doesNotMatch(JSON.stringify(audit.rows), new RegExp(temporaryPassword));
    } finally {
      await client.end();
    }

    await withTestApi(database.url, async (app) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN },
        payload: { username: "valid_bootstrap_admin", password: temporaryPassword },
      });
      assert.equal(login.statusCode, 200);
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      assert.equal(me.json().user.mustChangePassword, true);
    });

    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", "src/cli/bootstrap-admin.ts"], {
        cwd: apiRoot,
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          NODE_ENV: "production",
          BOOTSTRAP_ADMIN_USERNAME: "valid_bootstrap_admin",
        },
        encoding: "utf8",
      }),
      /bootstrap 已完成/,
    );
  });
});

test("同一来源 IP 的大量失败会暂停后续登录", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "ip_limit_target",
      displayName: "IP 限速目标用户",
      password: "Correct@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    await withTestApi(database.url, async (app) => {
      for (let attempt = 1; attempt <= 50; attempt += 1) {
        const failed = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: TEST_ORIGIN, "x-forwarded-for": `198.51.100.${attempt}, 203.0.113.10` },
          payload: { username: `missing_user_${attempt}`, password: "Wrong@123" },
        });
        assert.equal(failed.statusCode, 401);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN, "x-forwarded-for": "198.51.100.250, 203.0.113.10" },
        payload: { username: "ip_limit_target", password: "Correct@123" },
      });
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.headers["retry-after"], "1800");

      const otherSource = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: TEST_ORIGIN, "x-forwarded-for": "198.51.100.250, 203.0.113.11" },
        payload: { username: "ip_limit_target", password: "Correct@123" },
      });
      assert.equal(otherSource.statusCode, 200);
    }, { trustProxy: "127.0.0.1" });
  });
});

test("认证响应与真实服务日志不包含密码、会话令牌或内部栈", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "log_safety_user",
      displayName: "日志安全用户",
      password: "Correct@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const passwordMarker = "NeverLogThis@456";
    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: { ...process.env, API_PORT: "3102", DATABASE_URL: database.url, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    api.stdout.setEncoding("utf8");
    api.stderr.setEncoding("utf8");
    api.stdout.on("data", (chunk: string) => { logs += chunk; });
    api.stderr.on("data", (chunk: string) => { logs += chunk; });

    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const ready = await fetch("http://127.0.0.1:3102/api/ready");
          if (ready.ok) break;
        } catch {
          // 服务尚未监听时继续等待。
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const response = await fetch("http://127.0.0.1:3102/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify({ username: "log_safety_user", password: passwordMarker }),
      });
      assert.equal(response.status, 401);
      const body = await response.text();
      assert.doesNotMatch(body, new RegExp(passwordMarker));
      assert.doesNotMatch(body, /sampleflow_session|sampleflow_csrf|"stack"/i);
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
    assert.doesNotMatch(logs, new RegExp(passwordMarker));
    assert.doesNotMatch(logs, /sampleflow_session|sampleflow_csrf/);
  });
});
