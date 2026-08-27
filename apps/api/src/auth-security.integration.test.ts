import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
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

test("管理员创建账号时由服务端返回一次性临时密码", async () => {
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
        payload: { username: "generated_password_user", password: result.temporaryPassword },
      });
      assert.equal(userLogin.statusCode, 200);
      const userCookie = String(userLogin.headers["set-cookie"]).split(";", 1)[0];
      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: userCookie } });
      assert.equal(me.json().user.mustChangePassword, true);
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

    await withTestApi(database.url, async (app) => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const failed = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "rate_limited_user", password: "Wrong@123" },
        });
        assert.equal(failed.statusCode, 401);
        assert.deepEqual(failed.json(), { message: "账号或密码错误" });
      }

      const delayed = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "rate_limited_user", password: "Wrong@123" },
      });
      assert.equal(delayed.statusCode, 429);
      assert.equal(delayed.headers["retry-after"], "1");

      for (let attempt = 7; attempt <= 10; attempt += 1) {
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "rate_limited_user", password: "Wrong@123" },
        });
      }

      const suspended = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "rate_limited_user", password: "Correct@123" },
      });
      assert.equal(suspended.statusCode, 429);
      assert.equal(suspended.headers["retry-after"], "1800");
      assert.deepEqual(suspended.json(), {
        code: "LOGIN_RATE_LIMITED",
        message: "登录尝试过多，请稍后再试",
      });
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
        payload: { username: "session_target", password: "Original@123" },
      });
      const targetHeaders = authenticatedHeaders(targetLogin);

      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
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
        payload: { username: "session_target", password: "Original@123" },
      });
      assert.equal(oldPassword.statusCode, 401);

      const temporaryLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
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

test("会话清理命令仅删除过期或撤销超过三十天的记录", async () => {
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
    } finally {
      await client.end();
    }

    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/cleanup-sessions.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      encoding: "utf8",
    });
    assert.match(result.stdout, /已删除 2 条会话/);

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    try {
      const remaining = await verify.query<{ token_hash: string }>("select token_hash from sessions order by token_hash");
      assert.deepEqual(remaining.rows.map((row) => row.token_hash), ["revoked-recent"]);
    } finally {
      await verify.end();
    }
  });
});

test("生产初始化命令使用统一密码规则且不回显密码", async () => {
  await withMigratedTestDatabase(async (database) => {
    const invalidPassword = "abcdefghijkl";
    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", "src/cli/seed.ts"], {
        cwd: apiRoot,
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          NODE_ENV: "production",
          BOOTSTRAP_ADMIN_USERNAME: "invalid_bootstrap_admin",
          BOOTSTRAP_ADMIN_PASSWORD: invalidPassword,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const output = String(error);
        assert.doesNotMatch(output, new RegExp(invalidPassword));
        assert.match(output, /密码须为 6—128 位/);
        return true;
      },
    );

    const valid = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/seed.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: database.url,
        NODE_ENV: "production",
        BOOTSTRAP_ADMIN_USERNAME: "valid_bootstrap_admin",
        BOOTSTRAP_ADMIN_PASSWORD: "Abc@12",
      },
      encoding: "utf8",
    });
    assert.match(valid.stdout, /生产环境系统管理员账号已就绪/);
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
          payload: { username: `missing_user_${attempt}`, password: "Wrong@123" },
        });
        assert.equal(failed.statusCode, 401);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "ip_limit_target", password: "Correct@123" },
      });
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.headers["retry-after"], "1800");
    });
  });
});
