import { db } from "../db.js";
import { hashPassword } from "../security/password.js";

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

if ((process.env.NODE_ENV ?? "development") === "production") {
  throw new Error("生产环境禁止运行 db:seed；请使用显式 admin:bootstrap 作业");
}

for (const [code, name] of roles) {
  await db.query(
    `insert into roles (code, name) values ($1, $2)
     on conflict (code) do update set name = excluded.name`,
    [code, name],
  );
}

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

await db.end();
