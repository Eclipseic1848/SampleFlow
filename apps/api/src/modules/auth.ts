import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db.js";
import { hashPassword, verifyPassword } from "../security/password.js";
import { createSessionToken, hashSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from "../security/session.js";

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
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200) });

async function auditLogin(request: FastifyRequest, action: string, userId?: string) {
  await db.query(
    `insert into audit_logs (actor_user_id, action, entity_type, entity_id, ip_address)
     values ($1, $2, 'session', $3, $4)`,
    [userId ?? null, action, userId ?? null, request.ip],
  );
}

export async function registerAuth(app: FastifyInstance) {
  app.decorateRequest("currentUser", null);

  app.addHook("preHandler", async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const result = await db.query<{
      id: string;
      username: string;
      display_name: string;
      must_change_password: boolean;
      roles: string[];
    }>(
      `select u.id::text, u.username, u.display_name, u.must_change_password,
              coalesce(array_agg(ur.role_code) filter (where ur.role_code is not null), '{}') as roles
       from sessions s
       join users u on u.id = s.user_id and u.is_active
       left join user_roles ur on ur.user_id = u.id
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
       group by u.id, u.username, u.display_name, u.must_change_password`,
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
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请输入有效的账号和密码" });

    const result = await db.query<{
      id: string;
      username: string;
      display_name: string;
      password_hash: string;
      password_salt: string;
      is_active: boolean;
    }>(
      `select id::text, username, display_name, password_hash, password_salt, is_active
       from users where lower(username) = lower($1)`,
      [parsed.data.username],
    );
    const user = result.rows[0];
    const valid = user?.is_active
      ? await verifyPassword(parsed.data.password, user.password_hash, user.password_salt)
      : false;
    if (!user || !valid) {
      await auditLogin(request, "auth.login_failed", user?.id);
      return reply.code(401).send({ message: "账号或密码错误" });
    }

    const { token, tokenHash } = createSessionToken();
    await db.query(
      `insert into sessions (user_id, token_hash, expires_at, user_agent, ip_address)
       values ($1, $2, $3, $4, $5)`,
      [user.id, tokenHash, new Date(Date.now() + SESSION_TTL_MS), request.headers["user-agent"] ?? null, request.ip],
    );
    await auditLogin(request, "auth.login_succeeded", user.id);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [hashSessionToken(token)]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    return { user: request.currentUser };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ message: "尚未登录" });
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "新密码至少需要 12 位" });
    const found = await db.query<{ password_hash:string; password_salt:string }>("select password_hash,password_salt from users where id=$1", [request.currentUser.id]);
    const user = found.rows[0];
    if (!user || !await verifyPassword(parsed.data.currentPassword,user.password_hash,user.password_salt)) return reply.code(401).send({ message: "当前密码错误" });
    const secured = await hashPassword(parsed.data.newPassword);
    const currentHash = request.cookies[SESSION_COOKIE] ? hashSessionToken(request.cookies[SESSION_COOKIE]!) : "";
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("update users set password_hash=$2,password_salt=$3,must_change_password=false,updated_at=now() where id=$1", [request.currentUser.id,secured.hash,secured.salt]);
      await client.query("update sessions set revoked_at=now() where user_id=$1 and token_hash<>$2 and revoked_at is null", [request.currentUser.id,currentHash]);
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,ip_address) values($1,'auth.password_changed','user',$3,$2)`, [request.currentUser.id,request.ip,request.currentUser.id]);
      await client.query("commit");
      return { ok:true };
    } catch(error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });
}
