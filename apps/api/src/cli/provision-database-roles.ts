import pg from "pg";

const { Client } = pg;
const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[数据库角色] 缺少 ${name}`);
  return value;
}

function role(name: string): string {
  const value = required(name);
  if (!ROLE_NAME.test(value)) throw new Error(`[数据库角色] ${name} 必须是小写 PostgreSQL 标识符`);
  return value;
}

function password(name: string): string {
  const value = required(name);
  if (value.length < 16 || value.includes("\0")) throw new Error(`[数据库角色] ${name} 必须至少 16 位`);
  return value;
}

const migrationRole = role("DB_MIGRATION_USER");
const appRole = role("DB_APP_USER");
const backupRole = role("DB_BACKUP_USER");
if (new Set([migrationRole, appRole, backupRole]).size !== 3) {
  throw new Error("[数据库角色] 迁移、应用和备份账号必须不同");
}

const migrationPassword = password("DB_MIGRATION_PASSWORD");
const appPassword = password("DB_APP_PASSWORD");
const backupPassword = password("DB_BACKUP_PASSWORD");
if (new Set([migrationPassword, appPassword, backupPassword]).size !== 3) {
  throw new Error("[数据库角色] 迁移、应用和备份密码必须不同");
}

const credentials = [
  [migrationRole, migrationPassword],
  [appRole, appPassword],
  [backupRole, backupPassword],
] as const;

const client = new Client(process.env.DATABASE_ADMIN_URL ? {
  connectionString: process.env.DATABASE_ADMIN_URL,
} : {
  host: required("DB_ADMIN_HOST"),
  port: Number(process.env.DB_ADMIN_PORT ?? 5432),
  database: required("DB_NAME"),
  user: required("DB_ADMIN_USER"),
  password: required("DB_ADMIN_PASSWORD"),
});

await client.connect();
try {
  const context = await client.query<{ database_name: string; admin_name: string; is_superuser: boolean }>(
    `select current_database() database_name,current_user admin_name,
            (select rolsuper from pg_roles where rolname=current_user) is_superuser`,
  );
  if (!context.rows[0]?.is_superuser) {
    throw new Error("[数据库角色] 配置账号必须是数据库管理员");
  }
  if ([migrationRole, appRole, backupRole].includes(context.rows[0].admin_name)) {
    throw new Error("[数据库角色] 数据库管理员不能兼任迁移、应用或备份账号");
  }
  const databaseName = context.rows[0].database_name;
  if (!ROLE_NAME.test(databaseName)) throw new Error("[数据库角色] 数据库名必须是小写 PostgreSQL 标识符");

  await client.query("begin");
  try {
    for (const [name, secret] of credentials) {
      const quotedSecret = await client.query<{ value: string }>("select quote_literal($1) value", [secret]);
      await client.query(`do $$ begin
        if not exists(select 1 from pg_roles where rolname='${name}') then
          create role ${name};
        end if;
      end $$`);
      await client.query(
        `alter role ${name} with login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${quotedSecret.rows[0]!.value}`,
      );
    }

    const memberships = await client.query<{ member_name: string; parent_name: string }>(
      `select member.rolname member_name,parent.rolname parent_name
       from pg_auth_members membership
       join pg_roles member on member.oid=membership.member
       join pg_roles parent on parent.oid=membership.roleid
       where member.rolname=any($1::text[]) or parent.rolname=any($1::text[])
       order by member.rolname,parent.rolname`,
      [[migrationRole, appRole, backupRole]],
    );
    if (memberships.rowCount) {
      const inherited = memberships.rows.map((item) => `${item.member_name}->${item.parent_name}`).join(", ");
      throw new Error(`[数据库角色] 目标账号存在角色继承，请先由管理员复核并移除：${inherited}`);
    }

    await client.query(`alter schema public owner to ${migrationRole}`);
    await client.query(`do $$
      declare object record;
      begin
        for object in
          select c.relkind,n.nspname schema_name,c.relname object_name
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')
            and (c.relkind<>'S' or not exists(
              select 1 from pg_depend d
              where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype in ('a','i')
            ))
            and not exists(
              select 1 from pg_depend d
              where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e'
            )
        loop
          execute format(
            case object.relkind
              when 'S' then 'alter sequence %I.%I owner to %I'
              when 'v' then 'alter view %I.%I owner to %I'
              when 'm' then 'alter materialized view %I.%I owner to %I'
              when 'f' then 'alter foreign table %I.%I owner to %I'
              else 'alter table %I.%I owner to %I'
            end,
            object.schema_name,object.object_name,'${migrationRole}'
          );
        end loop;
      end $$`);
    await client.query(`do $$
      declare object record;
      begin
        for object in
          select n.nspname schema_name,p.proname object_name,pg_get_function_identity_arguments(p.oid) arguments,p.prokind
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public'
            and not exists(
              select 1 from pg_depend d
              where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
            )
        loop
          execute format(
            case when object.prokind='p' then 'alter procedure %I.%I(%s) owner to %I'
                 else 'alter function %I.%I(%s) owner to %I' end,
            object.schema_name,object.object_name,object.arguments,'${migrationRole}'
          );
        end loop;
      end $$`);
    await client.query(`do $$
      declare object record;
      begin
        for object in
          select n.nspname schema_name,t.typname object_name
          from pg_type t join pg_namespace n on n.oid=t.typnamespace
          where n.nspname='public' and t.typtype in ('c','d','e','r')
            and not exists(select 1 from pg_class c where c.reltype=t.oid)
            and not exists(
              select 1 from pg_depend d
              where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e'
            )
        loop
          execute format('alter type %I.%I owner to %I',object.schema_name,object.object_name,'${migrationRole}');
        end loop;
      end $$`);
    await client.query(`revoke all on database ${databaseName} from public`);
    await client.query(`grant connect on database ${databaseName} to ${appRole},${backupRole}`);
    await client.query(`grant connect,create,temp on database ${databaseName} to ${migrationRole}`);
    await client.query("revoke all on schema public from public");
    await client.query(`grant usage on schema public to ${appRole},${backupRole}`);

    await client.query(`set local role ${migrationRole}`);
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
    await client.query("reset role");

    await client.query(`revoke all on all tables in schema public from ${appRole},${backupRole}`);
    await client.query(`revoke all on all sequences in schema public from ${appRole},${backupRole}`);
    await client.query(`revoke all on all functions in schema public from public,${appRole},${backupRole}`);
    await client.query(`grant select,insert,update,delete on all tables in schema public to ${appRole}`);
    await client.query(`grant usage,select on all sequences in schema public to ${appRole}`);
    await client.query(`grant select on all tables in schema public to ${backupRole}`);
    await client.query(`grant select on all sequences in schema public to ${backupRole}`);
    await client.query(`revoke insert,update,delete on schema_migrations from ${appRole}`);

    await client.query(`alter default privileges for role ${migrationRole} in schema public
      grant select,insert,update,delete on tables to ${appRole}`);
    await client.query(`alter default privileges for role ${migrationRole} in schema public
      grant usage,select on sequences to ${appRole}`);
    await client.query(`alter default privileges for role ${migrationRole}
      revoke execute on functions from public`);
    await client.query(`alter default privileges for role ${migrationRole} in schema public
      grant select on tables to ${backupRole}`);
    await client.query(`alter default privileges for role ${migrationRole} in schema public
      grant select on sequences to ${backupRole}`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  console.log(`[数据库角色] 已配置 ${migrationRole}、${appRole}、${backupRole}`);
} finally {
  await client.end();
}
