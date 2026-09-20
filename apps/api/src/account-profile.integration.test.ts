import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

test("账号资料编辑和删除保留身份与历史、撤销会话且不能绕过权限", async () => {
  await withMigratedTestDatabase(async database => {
    const admin = await seedTestUser(database.url, { username:"account_admin",displayName:"管理员",password:"Account@123",roleCode:"system_admin",roleName:"系统管理员" });
    const target = await seedTestUser(database.url, { username:"account_target",displayName:"原姓名",password:"Account@123",roleCode:"sales_manager",roleName:"销售经理" });
    const client = new pg.Client({connectionString:database.url});await client.connect();
    try {
      await withTestApi(database.url, async app => {
        const login = (username:string) => app.inject({method:"POST",url:"/api/auth/login",headers:{origin:"http://127.0.0.1:4174"},payload:{username,password:"Account@123"}});
        async function headers(username:string) {
          const response=await login(username);assert.equal(response.statusCode,200,response.body);
          const raw=response.headers["set-cookie"]!;const cookies=(Array.isArray(raw)?raw:[raw]).map(value=>String(value).split(";",1)[0]!);
          return {cookie:cookies.join("; "),origin:"http://127.0.0.1:4174","x-csrf-token":decodeURIComponent(cookies.find(value=>value.startsWith("sampleflow_csrf="))!.slice("sampleflow_csrf=".length))};
        }
        const adminHeaders=await headers("account_admin");const targetHeaders=await headers("account_target");
        const person=(await client.query("select id::text from people where user_id=$1",[target])).rows[0].id;
        const created=await app.inject({method:"POST",url:"/api/goals",headers:targetHeaders,payload:{periodMonth:"2026-09",level:"sales_manager",ownerPersonId:person,orgUnitId:null,parentGoalId:null,amount:1000,changeReason:"历史目标保留验证"}});
        assert.equal(created.statusCode,201,created.body);
        const history=await client.query("select * from goal_versions where goal_id=$1",[created.json().id]);
        const security=await client.query("select password_hash,password_salt from users where id=$1",[target]);
        const patch=(payload:object,actor=adminHeaders)=>app.inject({method:"PATCH",url:`/api/admin/users/${target}/profile`,headers:actor,payload});
        assert.equal((await patch({username:"new_account",displayName:"新姓名"},targetHeaders)).statusCode,403);
        assert.equal((await app.inject({method:"PATCH",url:`/api/admin/users/${target}/profile`,headers:{cookie:adminHeaders.cookie,origin:adminHeaders.origin},payload:{username:"new_account",displayName:"新姓名"}})).statusCode,403);
        for(const payload of [{username:" ",displayName:"新姓名"},{username:"new_account",displayName:" "},{username:"new_account",displayName:"新姓名",roles:["system_admin"]}])assert.equal((await patch(payload)).statusCode,400);
        assert.equal((await patch({username:"ACCOUNT_ADMIN",displayName:"错误姓名"})).statusCode,409);
        assert.equal((await client.query("select display_name from people where id=$1",[person])).rows[0].display_name,"原姓名");
        assert.equal((await patch({username:"new_account",displayName:"新姓名"})).statusCode,200);
        assert.equal((await patch({username:"new_account",displayName:"新姓名"})).json().changed,false);
        assert.equal((await login("account_target")).statusCode,401);
        const newHeaders=await headers("new_account");
        assert.deepEqual((await client.query("select id::text,display_name from people where user_id=$1",[target])).rows,[{id:person,display_name:"原姓名"}]);
        assert.deepEqual((await client.query("select password_hash,password_salt from users where id=$1",[target])).rows,security.rows);
        const remove=(username:string,actor=adminHeaders)=>app.inject({method:"DELETE",url:`/api/admin/users/${target}`,headers:actor,payload:{username}});
        assert.equal((await remove("new_account",newHeaders)).statusCode,403);
        assert.equal((await app.inject({method:"DELETE",url:`/api/admin/users/${admin}`,headers:adminHeaders,payload:{username:"account_admin"}})).statusCode,409);
        assert.equal((await remove("account_target")).statusCode,409);
        assert.equal((await remove("new_account")).statusCode,200);
        assert.equal((await remove("new_account")).json().changed,false);
        assert.equal((await login("new_account")).statusCode,401);
        assert.equal((await app.inject({method:"GET",url:"/api/auth/me",headers:newHeaders})).statusCode,401);
        for(const url of ["/api/admin/users","/api/admin/users?page=1&pageSize=10","/api/admin/users?search=新姓名"]){
          const list=await app.inject({method:"GET",url,headers:adminHeaders});assert.equal(list.statusCode,200,list.body);
          assert.equal(list.json().users.some((user:{id:string})=>user.id===target),false);
        }
        assert.equal((await patch({username:"resurrect",displayName:"复活"})).statusCode,404);
        for(const [suffix,payload] of [["status",{isActive:true}],["roles",{roles:["system_admin"]}]] as const)assert.equal((await app.inject({method:"PATCH",url:`/api/admin/users/${target}/${suffix}`,headers:adminHeaders,payload})).statusCode,404);
        assert.equal((await app.inject({method:"POST",url:`/api/admin/users/${target}/reset-password`,headers:adminHeaders,payload:{}})).statusCode,404);
        assert.equal((await app.inject({method:"POST",url:"/api/admin/users",headers:adminHeaders,payload:{username:"NEW_ACCOUNT",displayName:"重用",roles:["sales_manager"]}})).statusCode,409);
        assert.deepEqual((await client.query("select * from goal_versions where goal_id=$1",[created.json().id])).rows,history.rows);
        assert.equal((await client.query("select id::text from people where user_id=$1",[target])).rows[0].id,person);
        const audits=await client.query("select action,before_data,after_data from audit_logs where entity_id=$1 and action in ('auth.account_profile_changed','auth.account_deleted') order by id",[target]);
        assert.equal(audits.rowCount,2);assert.equal(audits.rows[0].before_data.displayName,"原姓名");assert.equal(audits.rows[0].after_data.displayName,"新姓名");
        assert.equal(JSON.stringify(audits.rows).includes("Account@123"),false);
        await assert.rejects(client.query("update users set is_active=true where id=$1",[target]),{code:"23514"});
        const otherAdmin=await seedTestUser(database.url,{username:"other_admin",displayName:"另一管理员",password:"Account@123",roleCode:"system_admin",roleName:"系统管理员"});
        const otherHeaders=await headers("other_admin");
        const concurrent=await Promise.all([
          app.inject({method:"DELETE",url:`/api/admin/users/${otherAdmin}`,headers:adminHeaders,payload:{username:"other_admin"}}),
          app.inject({method:"DELETE",url:`/api/admin/users/${admin}`,headers:otherHeaders,payload:{username:"account_admin"}}),
        ]);
        assert.equal(concurrent.filter(response=>response.statusCode===200).length,1);
        assert.ok(concurrent.every(response=>[200,401,409].includes(response.statusCode)));
        assert.equal((await client.query("select count(*)::int as count from users u join user_roles r on r.user_id=u.id where u.is_active and r.role_code='system_admin'")).rows[0].count,1);
      });
    } finally {await client.end();}
  });
});
