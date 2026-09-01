import { db } from "../db.js";

try {
  const result = await db.query(
    `delete from sessions
     where (revoked_at is not null and revoked_at < now()-interval '30 days')
        or (revoked_at is null and expires_at < now()-interval '30 days')`,
  );
  console.log(`[会话清理] 已删除 ${result.rowCount ?? 0} 条会话`);
  const throttles = await db.query(
    `delete from auth_login_throttles
     where updated_at < now()-interval '30 days'
       and (blocked_until is null or blocked_until < now())`,
  );
  console.log(`[会话清理] 已删除 ${throttles.rowCount ?? 0} 条登录限流`);
} finally {
  await db.end();
}
