import pg from "pg";
import { hashPassword } from "../security/password.js";
import { assertTestDatabaseUrl } from "./test-database.js";

const { Client } = pg;

type TestUserInput = Readonly<{
  displayName: string;
  password: string;
  roleCode: string;
  roleName: string;
  username: string;
}>;

export async function seedTestUser(databaseUrl: string, input: TestUserInput): Promise<void> {
  assertTestDatabaseUrl(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    await client.query(
      "insert into roles(code,name) values($1,$2) on conflict(code) do update set name=excluded.name",
      [input.roleCode, input.roleName],
    );
    const secured = await hashPassword(input.password);
    const user = await client.query<{ id: string }>(
      `insert into users(username,display_name,password_hash,password_salt,must_change_password)
       values($1,$2,$3,$4,false) returning id::text`,
      [input.username, input.displayName, secured.hash, secured.salt],
    );
    await client.query("insert into user_roles(user_id,role_code) values($1,$2)", [
      user.rows[0]!.id,
      input.roleCode,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}
