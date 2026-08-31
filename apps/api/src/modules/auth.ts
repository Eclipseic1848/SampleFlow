import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { config } from "../config.js";
import type { Database } from "../db.js";
import { hashPassword, isPasswordAllowed, PASSWORD_POLICY_MESSAGE, verifyPassword } from "../security/password.js";
import { createCsrfToken, createSessionToken, CSRF_COOKIE, hashSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from "../security/session.js";
import { capabilitiesForRoles } from "./authorization.js";

export type CurrentUser = {
  id: string;
  personId: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
  roles: string[];
};

export const PERFORMANCE_EDITOR_ROLES = ["sales_assistant", "sales_assistant_leader"] as const;

export function hasAnyRole(user: CurrentUser | null, roles: readonly string[]): boolean {
  return Boolean(user && roles.some((role) => user.roles.includes(role)));
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser: CurrentUser | null;
  }
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(1000) });

async function auditLogin(db: Database, request: FastifyRequest, action: string, accountKey: string, userId?: string) {
  await db.query(
    `insert into audit_logs (actor_user_id, action, entity_type, entity_id, ip_address)
     values ($1, $2, 'session', $3, $4)`,
    [userId ?? null, action, accountKey, request.ip],
  );
}

async function loginRetryAfterSeconds(db: Database, accountKey: string, ipAddress: string, now: Date): Promise<number | null> {
  const result = await db.query<{ blocked_until: Date | null }>(
    `select max(blocked_until) as blocked_until
     from auth_login_throttles
     where (scope='account' and throttle_key=$1)
        or (scope='ip' and throttle_key=$2)`,
    [accountKey, ipAddress],
  );
  const blockedUntil = result.rows[0]?.blocked_until;
  if (!blockedUntil) return null;
  const remaining = Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000);
  return remaining > 0 ? remaining : null;
}

async function recordThrottleFailure(
  client: PoolClient,
  scope: "account" | "ip",
  throttleKey: string,
  now: Date,
): Promise<Date | null> {
  await client.query(
    `insert into auth_login_throttles(scope,throttle_key,window_started_at,failure_count,blocked_until,updated_at)
     values($1,$2,$3,0,null,$3)
     on conflict(scope,throttle_key) do nothing`,
    [scope, throttleKey, now],
  );
  const existing = await client.query<{
    blocked_until: Date | null;
    failure_count: number;
    window_started_at: Date;
  }>(
    "select window_started_at,failure_count,blocked_until from auth_login_throttles where scope=$1 and throttle_key=$2 for update",
    [scope, throttleKey],
  );
  const prior = existing.rows[0]!;
  const windowExpired = prior.window_started_at.getTime() <= now.getTime() - 15 * 60 * 1000;
  const failureCount = windowExpired ? 1 : prior.failure_count + 1;
  const windowStartedAt = windowExpired ? now : prior.window_started_at;
  let retryAfterSeconds = 0;
  if (scope === "account" && failureCount >= 10) retryAfterSeconds = 30 * 60;
  else if (scope === "account" && failureCount >= 5) retryAfterSeconds = Math.min(30, 2 ** (failureCount - 5));
  else if (scope === "ip" && failureCount >= 50) retryAfterSeconds = 30 * 60;
  const blockedUntil = retryAfterSeconds ? new Date(now.getTime() + retryAfterSeconds * 1000) : null;
  await client.query(
    `insert into auth_login_throttles(scope,throttle_key,window_started_at,failure_count,blocked_until,updated_at)
     values($1,$2,$3,$4,$5,$3)
     on conflict(scope,throttle_key) do update
     set window_started_at=excluded.window_started_at,
         failure_count=excluded.failure_count,
         blocked_until=excluded.blocked_until,
         updated_at=excluded.updated_at`,
    [scope, throttleKey, now, failureCount, blockedUntil],
  );
  return blockedUntil;
}

async function recordLoginFailure(db: Database, accountKey: string, ipAddress: string, now: Date): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await recordThrottleFailure(client, "account", accountKey, now);
    await recordThrottleFailure(client, "ip", ipAddress, now);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerAuth(app: FastifyInstance, db: Database, clock: () => Date = () => new Date()) {
  app.decorateRequest("currentUser", null);

  app.addHook("preHandler", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const result = await db.query<{
      id: string;
      person_id: string;
      username: string;
      display_name: string;
      must_change_password: boolean;
      roles: string[];
      session_id: string;
      last_seen_at: Date;
      csrf_token_hash: string | null;
    }>(
      `select u.id::text, p.id::text as person_id, u.username, u.display_name, u.must_change_password,
              s.id::text as session_id, s.last_seen_at, s.csrf_token_hash,
              coalesce(array_agg(ur.role_code) filter (where ur.role_code is not null), '{}') as roles
       from sessions s
       join users u on u.id = s.user_id and u.is_active
       join people p on p.user_id=u.id
       left join user_roles ur on ur.user_id = u.id
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
         and s.last_seen_at > now() - interval '30 minutes'
       group by u.id, p.id, u.username, u.display_name, u.must_change_password, s.id, s.last_seen_at, s.csrf_token_hash`,
      [hashSessionToken(token)],
    );
    const row = result.rows[0];
    if (!row) return;
    request.currentUser = {
      id: row.id,
      personId: row.person_id,
      username: row.username,
      displayName: row.display_name,
      mustChangePassword: row.must_change_password,
      roles: row.roles,
    };
    if (request.currentUser.mustChangePassword) {
      const allowedRoutes = new Set([
        "/api/auth/me",
        "/api/auth/logout",
        "/api/auth/change-password",
        "/api/auth/csrf",
        "/api/health",
        "/api/ready",
      ]);
      const routeUrl = request.routeOptions.url ?? request.url.split("?", 1)[0] ?? "";
      if (!allowedRoutes.has(routeUrl)) {
        return reply.code(403).send({
          code: "PASSWORD_CHANGE_REQUIRED",
          message: "请先修改初始密码",
        });
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const csrfHeader = request.headers["x-csrf-token"];
      const csrfCookie = request.cookies[CSRF_COOKIE];
      if (typeof csrfHeader !== "string"
        || !csrfCookie
        || csrfCookie !== csrfHeader
        || !row.csrf_token_hash
        || hashSessionToken(csrfHeader) !== row.csrf_token_hash) {
        return reply.code(403).send({ code: "CSRF_INVALID", message: "请求安全校验失败" });
      }
      const origin = request.headers.origin;
      if (!origin || !config.allowedOrigins.includes(origin)) {
        return reply.code(403).send({ code: "ORIGIN_INVALID", message: "请求来源不受信任" });
      }
    }
    if (row.last_seen_at.getTime() <= Date.now() - 5 * 60 * 1000) {
      await db.query("update sessions set last_seen_at=now() where id=$1", [row.session_id]);
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !config.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ code: "ORIGIN_INVALID", message: "请求来源不受信任" });
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请输入有效的账号和密码" });
    const accountKey = parsed.data.username.toLowerCase();

    const result = await db.query<{
      id: string;
      username: string;
      display_name: string;
      password_hash: string;
      password_salt: string;
      is_active: boolean;
      must_change_password: boolean;
      temporary_password_expires_at: Date | null;
    }>(
      `select id::text, username, display_name, password_hash, password_salt, is_active,
              must_change_password, temporary_password_expires_at
       from users where lower(username) = lower($1)`,
      [parsed.data.username],
    );
    const user = result.rows[0];
    const now = clock();
    const retryAfter = await loginRetryAfterSeconds(db, accountKey, request.ip, now);
    if (retryAfter !== null) {
      await auditLogin(db, request, retryAfter > 30 ? "auth.login_suspended" : "auth.login_rate_limited", accountKey, user?.id);
      reply.header("retry-after", String(retryAfter));
      return reply.code(429).send({ code: "LOGIN_RATE_LIMITED", message: "登录尝试过多，请稍后再试" });
    }
    const valid = user?.is_active
      ? await verifyPassword(parsed.data.password, user.password_hash, user.password_salt)
      : false;
    if (!user || !valid) {
      await recordLoginFailure(db, accountKey, request.ip, now);
      await auditLogin(db, request, "auth.login_failed", accountKey, user?.id);
      return reply.code(401).send({ message: "账号或密码错误" });
    }
    if (user.must_change_password
      && user.temporary_password_expires_at
      && user.temporary_password_expires_at.getTime() <= now.getTime()) {
      await auditLogin(db, request, "auth.temporary_password_expired", accountKey, user.id);
      return reply.code(401).send({
        code: "TEMPORARY_PASSWORD_EXPIRED",
        message: "临时密码已过期，请联系管理员重置",
      });
    }

    const { token, tokenHash } = createSessionToken();
    const csrf = createCsrfToken();
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into sessions (user_id, token_hash, csrf_token_hash, expires_at, user_agent, ip_address)
         values ($1, $2, $3, $4, $5, $6)`,
        [user.id, tokenHash, csrf.tokenHash, new Date(now.getTime() + SESSION_TTL_MS), request.headers["user-agent"] ?? null, request.ip],
      );
      await client.query("delete from auth_login_throttles where scope='account' and throttle_key=$1", [accountKey]);
      await client.query(
        `insert into audit_logs (actor_user_id, action, entity_type, entity_id, ip_address)
         values ($1,'auth.login_succeeded','session',$2,$3)`,
        [user.id, accountKey, request.ip],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: SESSION_TTL_MS / 1000,
    });
    reply.setCookie(CSRF_COOKIE, csrf.token, {
      path: "/",
      httpOnly: false,
      sameSite: "strict",
      secure: config.nodeEnv === "production",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { ok: true, csrfToken: csrf.token };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token && request.currentUser) {
      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [hashSessionToken(token)]);
        await client.query(
          `insert into audit_logs(actor_user_id,action,entity_type,entity_id,ip_address)
           values($1,'auth.logout','session',$2,$3)`,
          [request.currentUser.id, request.currentUser.id, request.ip],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    } else if (token) {
      await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [hashSessionToken(token)]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    return { user: { ...request.currentUser, capabilities: capabilitiesForRoles(request.currentUser.roles) } };
  });

  app.get("/api/auth/csrf", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const token = request.cookies[CSRF_COOKIE];
    if (!token) return reply.code(401).send({ message: "会话安全令牌不存在" });
    return { csrfToken: token };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success || !isPasswordAllowed(parsed.data.newPassword)) {
      return reply.code(400).send({ code: "PASSWORD_POLICY_INVALID", message: PASSWORD_POLICY_MESSAGE });
    }
    const found = await db.query<{ password_hash:string; password_salt:string }>("select password_hash,password_salt from users where id=$1", [request.currentUser.id]);
    const user = found.rows[0];
    if (!user || !await verifyPassword(parsed.data.currentPassword,user.password_hash,user.password_salt)) return reply.code(401).send({ message: "当前密码错误" });
    const secured = await hashPassword(parsed.data.newPassword);
    const currentHash = request.cookies[SESSION_COOKIE] ? hashSessionToken(request.cookies[SESSION_COOKIE]!) : "";
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("update users set password_hash=$2,password_salt=$3,must_change_password=false,temporary_password_expires_at=null,updated_at=now() where id=$1", [request.currentUser.id,secured.hash,secured.salt]);
      await client.query("update sessions set revoked_at=now() where user_id=$1 and token_hash<>$2 and revoked_at is null", [request.currentUser.id,currentHash]);
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,ip_address) values($1,'auth.password_changed','user',$3,$2)`, [request.currentUser.id,request.ip,request.currentUser.id]);
      await client.query("commit");
      return { ok:true };
    } catch(error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });
}
