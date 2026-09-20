import type { PoolClient } from "pg";
import type { CurrentUser } from "./modules/auth.js";

// 账号标志仅由服务端会话加载，部署开关默认关闭，不能由请求体授予。
export function acceptanceEnabled(): boolean {
  return process.env.SAMPLEFLOW_ACCEPTANCE_OVERRIDE === "enabled-for-customer-uat";
}
export function isAcceptanceOperator(user: CurrentUser | null): boolean {
  return acceptanceEnabled() && user?.acceptanceOperator === true;
}
export async function isAcceptancePerson(client: PoolClient, personId: string): Promise<boolean> {
  if (!acceptanceEnabled()) return false;
  const result=await client.query<{allowed:boolean}>("select acceptance_operator_active(user_id) as allowed from people where id=$1",[personId]);
  return result.rows[0]?.allowed===true;
}
