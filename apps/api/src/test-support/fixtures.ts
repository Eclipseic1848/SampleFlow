import pg from "pg";
import { hashPassword } from "../security/password.js";
import { assertTestDatabaseUrl } from "./test-database.js";

const { Client } = pg;

type TestUserInput = Readonly<{
  displayName: string;
  mustChangePassword?: boolean;
  password: string;
  roleCode: string;
  roleName: string;
  temporaryPasswordExpiresAt?: Date;
  username: string;
}>;

export async function seedTestUser(databaseUrl: string, input: TestUserInput): Promise<string> {
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
      `insert into users(username,display_name,password_hash,password_salt,must_change_password,temporary_password_expires_at)
       values($1,$2,$3,$4,$5,$6) returning id::text`,
      [input.username, input.displayName, secured.hash, secured.salt, input.mustChangePassword ?? false, input.temporaryPasswordExpiresAt ?? null],
    );
    await client.query("insert into user_roles(user_id,role_code) values($1,$2)", [
      user.rows[0]!.id,
      input.roleCode,
    ]);
    await client.query("commit");
    return user.rows[0]!.id;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}
