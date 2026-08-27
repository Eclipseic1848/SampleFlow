import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { resolveOrganization } from "./modules/organization.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Client } = pg;

test("人员身份独立绑定账号，组织约束拒绝跨部门和重叠任职", async () => {
  await withMigratedTestDatabase(async (database) => {
    const userId = await seedTestUser(database.url, {
      username: "org_person",
      displayName: "组织测试人员",
      password: "Org@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const person = await client.query<{ id: string }>("select id::text from people where user_id=$1", [userId]);
      assert.equal(person.rowCount, 1);
      const departmentA = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('同名组甲部','department') returning id::text");
      const departmentB = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('同名组乙部','department') returning id::text");
      const groupA = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('同名小组','group',$1) returning id::text", [departmentA.rows[0]!.id]);
      const groupB = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('同名小组','group',$1) returning id::text", [departmentB.rows[0]!.id]);
      assert.notEqual(groupA.rows[0]!.id, groupB.rows[0]!.id);
      await client.query(
        `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
         values($1,$2,'leader','2026-01-01'),($1,$3,'supervisor','2026-01-01'),
               ($1,$4,'leader','2026-01-01'),($1,$5,'supervisor','2026-01-01')`,
        [person.rows[0]!.id,groupA.rows[0]!.id,departmentA.rows[0]!.id,groupB.rows[0]!.id,departmentB.rows[0]!.id],
      );

      await assert.rejects(
        client.query(
          `insert into org_memberships(person_id,department_id,group_id,effective_from)
           values($1,$2,$3,'2026-01-01')`,
          [person.rows[0]!.id, departmentA.rows[0]!.id, groupB.rows[0]!.id],
        ),
        /小组必须属于所选部门/,
      );
      await client.query(
        `insert into org_memberships(person_id,department_id,group_id,effective_from,effective_to)
         values($1,$2,$3,'2026-01-01','2026-08-31')`,
        [person.rows[0]!.id, departmentA.rows[0]!.id, groupA.rows[0]!.id],
      );
      await assert.rejects(
        client.query(
          `insert into org_memberships(person_id,department_id,group_id,effective_from)
           values($1,$2,$3,'2026-08-31')`,
          [person.rows[0]!.id, departmentB.rows[0]!.id, groupB.rows[0]!.id],
        ),
        /org_memberships_no_overlap/,
      );
    } finally {
      await client.end();
    }
  });
});

test("组织解析按事件日期返回唯一稳定快照，缺少任职时阻断", async () => {
  await withMigratedTestDatabase(async (database) => {
    const memberUserId = await seedTestUser(database.url, { username: "org_member", displayName: "成员", password: "Org@123", roleCode: "salesperson", roleName: "业务员" });
    const leaderUserId = await seedTestUser(database.url, { username: "org_leader", displayName: "组长", password: "Org@123", roleCode: "sales_leader", roleName: "业务员组长" });
    const supervisorUserId = await seedTestUser(database.url, { username: "org_supervisor", displayName: "主管", password: "Org@123", roleCode: "sales_supervisor", roleName: "业务主管" });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const people = await client.query<{ id: string; user_id: string }>("select id::text,user_id::text from people where user_id=any($1::bigint[])", [[memberUserId, leaderUserId, supervisorUserId]]);
      const personId = (userId: string) => people.rows.find((row) => row.user_id === userId)!.id;
      const department = await client.query<{ id: string }>("insert into org_units(name,unit_type) values('解析部门','department') returning id::text");
      const group = await client.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('解析小组','group',$1) returning id::text", [department.rows[0]!.id]);
      await client.query(
        `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
         values($1,$3,'leader','2026-08-01'),($2,$4,'supervisor','2026-08-01')`,
        [personId(leaderUserId), personId(supervisorUserId), group.rows[0]!.id, department.rows[0]!.id],
      );
      await client.query(
        `insert into org_memberships(person_id,department_id,group_id,effective_from)
         values($1,$2,$3,'2026-08-01')`,
        [personId(memberUserId), department.rows[0]!.id, group.rows[0]!.id],
      );

      const resolved = await resolveOrganization(client, personId(memberUserId), "2026-08-15");
      assert.deepEqual(resolved, {
        personId: personId(memberUserId),
        salespersonName: "成员",
        departmentId: department.rows[0]!.id,
        departmentName: "解析部门",
        groupId: group.rows[0]!.id,
        groupName: "解析小组",
        leaderPersonId: personId(leaderUserId),
        leaderName: "组长",
        supervisorPersonId: personId(supervisorUserId),
        supervisorName: "主管",
      });
      await assert.rejects(resolveOrganization(client, personId(memberUserId), "2026-07-31"), /找不到唯一有效组织任职/);
    } finally {
      await client.end();
    }
  });
});

test("开放成员任职拒绝负责人空档并接受无缝继任", async () => {
  await withMigratedTestDatabase(async(database)=>{
    const memberUserId=await seedTestUser(database.url,{username:"coverage_member",displayName:"覆盖成员",password:"Org@123",roleCode:"salesperson",roleName:"业务员"});
    const leaderAUserId=await seedTestUser(database.url,{username:"coverage_leader_a",displayName:"前任组长",password:"Org@123",roleCode:"sales_leader",roleName:"业务员组长"});
    const leaderBUserId=await seedTestUser(database.url,{username:"coverage_leader_b",displayName:"继任组长",password:"Org@123",roleCode:"sales_leader",roleName:"业务员组长"});
    const supervisorUserId=await seedTestUser(database.url,{username:"coverage_supervisor",displayName:"覆盖主管",password:"Org@123",roleCode:"sales_supervisor",roleName:"业务主管"});
    const client=new Client({connectionString:database.url});
    await client.connect();
    try{
      const people=await client.query<{id:string;user_id:string}>("select id::text,user_id::text from people where user_id=any($1::bigint[])",[[memberUserId,leaderAUserId,leaderBUserId,supervisorUserId]]);
      const personId=(userId:string)=>people.rows.find((row)=>row.user_id===userId)!.id;
      const department=await client.query<{id:string}>("insert into org_units(name,unit_type) values('覆盖部门','department') returning id::text");
      const group=await client.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('覆盖小组','group',$1) returning id::text",[department.rows[0]!.id]);
      await client.query(
        `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from,effective_to)
         values($1,$4,'leader','2026-01-01','2026-08-31'),($2,$4,'leader','2026-09-02',null),
               ($3,$5,'supervisor','2026-01-01',null)`,
        [personId(leaderAUserId),personId(leaderBUserId),personId(supervisorUserId),group.rows[0]!.id,department.rows[0]!.id],
      );
      await assert.rejects(
        client.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[personId(memberUserId),department.rows[0]!.id,group.rows[0]!.id]),
        /必须由连续的小组负责人和部门主管完整覆盖/,
      );
      await client.query("update org_responsibilities set effective_from='2026-09-01' where person_id=$1 and org_unit_id=$2",[personId(leaderBUserId),group.rows[0]!.id]);
      await client.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[personId(memberUserId),department.rows[0]!.id,group.rows[0]!.id]);
    }finally{await client.end();}
  });
});

test("没有成员的启用组织单元也必须配置持续有效的负责人", async () => {
  await withMigratedTestDatabase(async (database) => {
    const leaderUserId = await seedTestUser(database.url, { username:"active_unit_leader", displayName:"空组负责人", password:"Org@123", roleCode:"sales_leader", roleName:"业务员组长" });
    const supervisorUserId = await seedTestUser(database.url, { username:"active_unit_supervisor", displayName:"空部负责人", password:"Org@123", roleCode:"sales_supervisor", roleName:"业务主管" });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const people = await client.query<{ id:string; user_id:string }>("select id::text,user_id::text from people where user_id=any($1::bigint[])", [[leaderUserId, supervisorUserId]]);
      const personId = (userId:string) => people.rows.find((row) => row.user_id === userId)!.id;
      const department = await client.query<{ id:string }>("insert into org_units(name,unit_type,is_active) values('空成员部门','department',false) returning id::text");
      const group = await client.query<{ id:string }>("insert into org_units(name,unit_type,parent_id,is_active) values('空成员小组','group',$1,false) returning id::text", [department.rows[0]!.id]);

      await assert.rejects(
        client.query("update org_units set is_active=true where id=any($1::bigint[])", [[department.rows[0]!.id, group.rows[0]!.id]]),
        /启用组织单元必须由持续有效的负责人完整覆盖/,
      );

      await client.query("begin");
      await client.query(
        `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
         values($1,$3,'leader','2026-01-01'),($2,$4,'supervisor','2026-01-01')`,
        [personId(leaderUserId), personId(supervisorUserId), group.rows[0]!.id, department.rows[0]!.id],
      );
      await client.query("update org_units set is_active=true where id=any($1::bigint[])", [[department.rows[0]!.id, group.rows[0]!.id]]);
      await client.query("commit");

      await assert.rejects(
        client.query("delete from org_responsibilities where org_unit_id=$1", [group.rows[0]!.id]),
        /启用组织单元必须由持续有效的负责人完整覆盖/,
      );
    } finally {
      await client.end();
    }
  });
});
