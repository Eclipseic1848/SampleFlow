import { db } from "../db.js";

try {
  const result = await db.query(
    `delete from sessions
     where (revoked_at is not null and revoked_at < now()-interval '30 days')
        or (revoked_at is null and expires_at < now()-interval '30 days')`,
  );
  console.log(`[会话清理] 已删除 ${result.rowCount ?? 0} 条会话`);
} finally {
  await db.end();
}
