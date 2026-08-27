import { db } from "../db.js";
import { hashPassword, isPasswordAllowed, PASSWORD_POLICY_MESSAGE, TEMPORARY_PASSWORD_TTL_MS } from "../security/password.js";

const roles = [
  ["system_admin", "系统管理员"],
  ["sales_assistant", "销售助理"],
  ["sales_assistant_leader", "销售助理组长"],
  ["sales_manager", "销售经理"],
  ["sales_supervisor", "业务主管"],
  ["sales_leader", "业务员组长"],
  ["salesperson", "业务员"],
  ["hr", "人事部"],
  ["general_manager", "总经理"],
] as const;

for (const [code, name] of roles) {
  await db.query(
    `insert into roles (code, name) values ($1, $2)
     on conflict (code) do update set name = excluded.name`,
    [code, name],
  );
}

if ((process.env.NODE_ENV ?? "development") !== "production") {
  const password = "SampleFlow@2026";
  for (const [roleCode, roleName] of roles) {
    const username = roleCode;
    const existing = await db.query<{ id: string }>(
      "select id::text from users where lower(username) = lower($1)",
      [username],
    );
    let userId = existing.rows[0]?.id;
    if (!userId) {
      const { hash, salt } = await hashPassword(password);
      const inserted = await db.query<{ id: string }>(
        `insert into users (username, display_name, password_hash, password_salt, must_change_password)
         values ($1, $2, $3, $4, false) returning id::text`,
        [username, `${roleName}演示`, hash, salt],
      );
      userId = inserted.rows[0]!.id;
    }
    await db.query(
      `insert into user_roles (user_id, role_code) values ($1, $2)
       on conflict (user_id, role_code) do nothing`,
      [userId, roleCode],
    );
  }
  console.log("[种子] 演示账号已就绪，统一密码 SampleFlow@2026");
} else {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME ?? "sampleflow-admin";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password || !isPasswordAllowed(password)) throw new Error(`BOOTSTRAP_ADMIN_PASSWORD 无效：${PASSWORD_POLICY_MESSAGE}`);
  const existing = await db.query<{ id: string }>("select id::text from users where lower(username)=lower($1)", [username]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const secured = await hashPassword(password);
    const inserted = await db.query<{ id: string }>(`insert into users(username,display_name,password_hash,password_salt,must_change_password,temporary_password_expires_at) values($1,'系统管理员',$2,$3,true,$4) returning id::text`, [username, secured.hash, secured.salt, new Date(Date.now()+TEMPORARY_PASSWORD_TTL_MS)]);
    userId = inserted.rows[0]!.id;
  }
  await db.query(`insert into user_roles(user_id,role_code) values($1,'system_admin') on conflict do nothing`, [userId]);
  console.log("[种子] 生产环境系统管理员账号已就绪");
}

await db.end();
