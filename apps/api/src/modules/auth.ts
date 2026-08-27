import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import type { Database } from "../db.js";
import { hashPassword, isPasswordAllowed, PASSWORD_POLICY_MESSAGE, verifyPassword } from "../security/password.js";
import { createCsrfToken, createSessionToken, CSRF_COOKIE, hashSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from "../security/session.js";

export type CurrentUser = {
  id: string;
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

async function loginRetryAfterSeconds(db: Database, accountKey: string, ipAddress: string): Promise<number | null> {
  const result = await db.query<{
    account_attempts: number;
    account_last_attempt: Date | null;
    ip_attempts: number;
  }>(
    `with last_success as (
       select max(created_at) as created_at
       from audit_logs
       where action='auth.login_succeeded' and entity_id=$1
     )
     select
       count(*) filter (
         where entity_id=$1
           and created_at > coalesce((select created_at from last_success), '-infinity'::timestamptz)
       )::int as account_attempts,
       max(created_at) filter (where entity_id=$1) as account_last_attempt,
       count(*) filter (where ip_address=$2)::int as ip_attempts
     from audit_logs
     where created_at > now()-interval '15 minutes'
       and action in ('auth.login_failed','auth.login_rate_limited')`,
    [accountKey, ipAddress],
  );
  const state = result.rows[0]!;
  if (state.account_attempts >= 10 || state.ip_attempts >= 50) return 30 * 60;
  if (state.account_attempts < 5 || !state.account_last_attempt) return null;
  const delay = Math.min(30, 2 ** (state.account_attempts - 5));
  const remaining = Math.ceil((state.account_last_attempt.getTime() + delay * 1000 - Date.now()) / 1000);
  return remaining > 0 ? remaining : null;
}

export async function registerAuth(app: FastifyInstance, db: Database) {
  app.decorateRequest("currentUser", null);

  app.addHook("preHandler", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const result = await db.query<{
      id: string;
      username: string;
      display_name: string;
      must_change_password: boolean;
      roles: string[];
      session_id: string;
      last_seen_at: Date;
      csrf_token_hash: string | null;
    }>(
      `select u.id::text, u.username, u.display_name, u.must_change_password,
              s.id::text as session_id, s.last_seen_at, s.csrf_token_hash,
              coalesce(array_agg(ur.role_code) filter (where ur.role_code is not null), '{}') as roles
       from sessions s
       join users u on u.id = s.user_id and u.is_active
       left join user_roles ur on ur.user_id = u.id
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
         and s.last_seen_at > now() - interval '30 minutes'
       group by u.id, u.username, u.display_name, u.must_change_password, s.id, s.last_seen_at, s.csrf_token_hash`,
      [hashSessionToken(token)],
    );
    const row = result.rows[0];
    if (!row) return;
    request.currentUser = {
      id: row.id,
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
    const retryAfter = await loginRetryAfterSeconds(db, accountKey, request.ip);
    if (retryAfter !== null) {
      await auditLogin(db, request, "auth.login_rate_limited", accountKey, user?.id);
      reply.header("retry-after", String(retryAfter));
      return reply.code(429).send({ code: "LOGIN_RATE_LIMITED", message: "登录尝试过多，请稍后再试" });
    }
    const valid = user?.is_active
      ? await verifyPassword(parsed.data.password, user.password_hash, user.password_salt)
      : false;
    if (!user || !valid) {
      await auditLogin(db, request, "auth.login_failed", accountKey, user?.id);
      return reply.code(401).send({ message: "账号或密码错误" });
    }
    if (user.must_change_password
      && user.temporary_password_expires_at
      && user.temporary_password_expires_at.getTime() <= Date.now()) {
      await auditLogin(db, request, "auth.temporary_password_expired", accountKey, user.id);
      return reply.code(401).send({
        code: "TEMPORARY_PASSWORD_EXPIRED",
        message: "临时密码已过期，请联系管理员重置",
      });
    }

    const { token, tokenHash } = createSessionToken();
    const csrf = createCsrfToken();
    await db.query(
      `insert into sessions (user_id, token_hash, csrf_token_hash, expires_at, user_agent, ip_address)
       values ($1, $2, $3, $4, $5, $6)`,
      [user.id, tokenHash, csrf.tokenHash, new Date(Date.now() + SESSION_TTL_MS), request.headers["user-agent"] ?? null, request.ip],
    );
    await auditLogin(db, request, "auth.login_succeeded", accountKey, user.id);
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
    if (token) {
      await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [hashSessionToken(token)]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    return { user: request.currentUser };
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
