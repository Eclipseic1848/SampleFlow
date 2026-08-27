import { db } from "../db.js";
import { hashPassword, isPasswordAllowed, PASSWORD_POLICY_MESSAGE, TEMPORARY_PASSWORD_TTL_MS } from "../security/password.js";

if (process.env.NODE_ENV !== "production") {
  throw new Error("admin:bootstrap 只能在 NODE_ENV=production 的显式运维作业中运行");
}

const username = process.env.BOOTSTRAP_ADMIN_USERNAME ?? "sampleflow-admin";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!password || !isPasswordAllowed(password)) {
  throw new Error(`BOOTSTRAP_ADMIN_PASSWORD 无效：${PASSWORD_POLICY_MESSAGE}`);
}

const client = await db.connect();
try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtext('sampleflow:admin-bootstrap'))");
  await client.query("insert into roles(code,name) values('system_admin','系统管理员') on conflict(code) do nothing");
  const existing = await client.query(
    `select u.id
     from users u
     left join user_roles ur on ur.user_id=u.id and ur.role_code='system_admin'
     where lower(u.username)=lower($1) or ur.user_id is not null
     limit 1`,
    [username],
  );
  if (existing.rowCount) throw new Error("系统管理员 bootstrap 已完成，拒绝重复执行");
  const secured = await hashPassword(password);
  const expiresAt = new Date(Date.now() + TEMPORARY_PASSWORD_TTL_MS);
  const inserted = await client.query<{ id: string }>(
    `insert into users(username,display_name,password_hash,password_salt,must_change_password,temporary_password_expires_at)
     values($1,'系统管理员',$2,$3,true,$4) returning id::text`,
    [username, secured.hash, secured.salt, expiresAt],
  );
  const userId = inserted.rows[0]!.id;
  await client.query("insert into user_roles(user_id,role_code) values($1,'system_admin')", [userId]);
  await client.query(
    `insert into audit_logs(action,entity_type,entity_id,after_data)
     values('auth.admin_bootstrapped','user',$1,jsonb_build_object('username',$2::text,'temporaryPasswordExpiresAt',$3::timestamptz))`,
    [userId, username, expiresAt],
  );
  await client.query("commit");
  console.log("[管理员初始化] 系统管理员账号已就绪");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await db.end();
}
