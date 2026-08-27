import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { generateTemporaryPassword, hashPassword, TEMPORARY_PASSWORD_TTL_MS } from "../security/password.js";
import { hasAnyRole } from "./auth.js";

const createUserSchema = z.strictObject({ username:z.string().trim().min(2).max(100), displayName:z.string().trim().min(1).max(100), roles:z.array(z.string().trim().min(1)).min(1) });
const statusSchema = z.object({ isActive:z.boolean() });
const resetSchema = z.strictObject({});
const unitSchema = z.object({ name:z.string().trim().min(1).max(100), unitType:z.enum(["department","group"]), parentId:z.coerce.number().int().positive().nullable().optional() });
const assignmentSchema = z.object({ username:z.string().trim().min(1), departmentId:z.coerce.number().int().positive().nullable().optional(), groupId:z.coerce.number().int().positive().nullable().optional(), leaderUsername:z.string().trim().optional(), supervisorUsername:z.string().trim().optional(), effectiveFrom:z.iso.date(), effectiveTo:z.iso.date().nullable().optional() });

function requireAdmin(request:{currentUser:import("./auth.js").CurrentUser|null},reply:{code:(status:number)=>{send:(body:unknown)=>unknown}}){if(!request.currentUser)return reply.code(401).send({message:"尚未登录"});if(!hasAnyRole(request.currentUser,["system_admin"]))return reply.code(403).send({message:"仅系统管理员可执行此操作"});return null;}

export async function registerAdmin(app:FastifyInstance,db:Database){
  app.get("/api/admin/users",async(request,reply)=>{const denied=requireAdmin(request,reply);if(denied)return denied;const [users,roles]=await Promise.all([db.query(`select u.id::text,u.username,u.display_name as "displayName",u.is_active as "isActive",u.must_change_password as "mustChangePassword",coalesce(array_agg(ur.role_code) filter(where ur.role_code is not null),'{}') as roles from users u left join user_roles ur on ur.user_id=u.id group by u.id order by u.display_name`),db.query(`select code,name from roles order by code`)]);return{users:users.rows,roles:roles.rows};});
  app.post("/api/admin/users",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const parsed=createUserSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({message:"账号信息不完整或格式无效"});
    const temporaryPassword=generateTemporaryPassword();const temporaryPasswordExpiresAt=new Date(Date.now()+TEMPORARY_PASSWORD_TTL_MS);const client=await db.connect();
    try{
      await client.query("begin");
      const valid=await client.query<{code:string}>("select code from roles where code=any($1::text[])",[parsed.data.roles]);
      if(valid.rowCount!==new Set(parsed.data.roles).size){await client.query("rollback");return reply.code(400).send({message:"包含不存在的角色"});}
      const password=await hashPassword(temporaryPassword);
      const user=await client.query<{id:string}>(`insert into users(username,display_name,password_hash,password_salt,must_change_password,temporary_password_expires_at) values($1,$2,$3,$4,true,$5) returning id::text`,[parsed.data.username,parsed.data.displayName,password.hash,password.salt,temporaryPasswordExpiresAt]);
      for(const role of parsed.data.roles)await client.query(`insert into user_roles(user_id,role_code,assigned_by) values($1,$2,$3)`,[user.rows[0]!.id,role,request.currentUser!.id]);
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address) values($1,'auth.account_created','user',$2,jsonb_build_object('roles',$3::text[]),$4)`,[request.currentUser!.id,user.rows[0]!.id,parsed.data.roles,request.ip]);
      await client.query("commit");
      return reply.code(201).send({id:user.rows[0]!.id,temporaryPassword,temporaryPasswordExpiresAt:temporaryPasswordExpiresAt.toISOString()});
    }catch(error){await client.query("rollback");if((error as{code?:string}).code==="23505")return reply.code(409).send({message:"账号名已存在"});throw error;}finally{client.release();}
  });
  app.patch("/api/admin/users/:id/status",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);const parsed=statusSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({message:"状态信息无效"});
    if(String(params.data.id)===request.currentUser!.id&&!parsed.data.isActive)return reply.code(409).send({message:"不能停用当前登录账号"});
    const client=await db.connect();
    try{
      await client.query("begin");
      const before=await client.query<{is_active:boolean}>("select is_active from users where id=$1 for update",[params.data.id]);
      if(!before.rowCount){await client.query("rollback");return reply.code(404).send({message:"账号不存在"});}
      await client.query("update users set is_active=$2,updated_at=now() where id=$1",[params.data.id,parsed.data.isActive]);
      if(!parsed.data.isActive)await client.query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null",[params.data.id]);
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,ip_address) values($1,'auth.account_status_changed','user',$2,jsonb_build_object('isActive',$3::boolean),jsonb_build_object('isActive',$4::boolean),$5)`,[request.currentUser!.id,String(params.data.id),before.rows[0]!.is_active,parsed.data.isActive,request.ip]);
      await client.query("commit");return{ok:true};
    }catch(error){await client.query("rollback");throw error;}finally{client.release();}
  });
  app.post("/api/admin/users/:id/reset-password",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);const parsed=resetSchema.safeParse(request.body??{});
    if(!params.success||!parsed.success)return reply.code(400).send({message:"密码信息无效"});
    const temporaryPassword=generateTemporaryPassword();const temporaryPasswordExpiresAt=new Date(Date.now()+TEMPORARY_PASSWORD_TTL_MS);const password=await hashPassword(temporaryPassword);const client=await db.connect();
    try{
      await client.query("begin");
      const result=await client.query("update users set password_hash=$2,password_salt=$3,must_change_password=true,temporary_password_expires_at=$4,updated_at=now() where id=$1 returning id",[params.data.id,password.hash,password.salt,temporaryPasswordExpiresAt]);
      if(!result.rowCount){await client.query("rollback");return reply.code(404).send({message:"账号不存在"});}
      await client.query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null",[params.data.id]);
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,ip_address) values($1,'auth.password_reset','user',$2,$3)`,[request.currentUser!.id,String(params.data.id),request.ip]);
      await client.query("commit");
      return{ok:true,temporaryPassword,temporaryPasswordExpiresAt:temporaryPasswordExpiresAt.toISOString()};
    }catch(error){await client.query("rollback");throw error;}finally{client.release();}
  });
  app.get("/api/organization",async(request,reply)=>{if(!request.currentUser)return reply.code(401).send({message:"尚未登录"});const [units,assignments]=await Promise.all([db.query(`select u.id::text,u.name,u.unit_type as "unitType",u.parent_id::text as "parentId",p.name as "parentName",u.is_active as "isActive" from org_units u left join org_units p on p.id=u.parent_id order by u.unit_type,u.name`),db.query(`select a.id::text,u.username,u.display_name as "displayName",d.name as "departmentName",g.name as "groupName",a.effective_from as "effectiveFrom",a.effective_to as "effectiveTo" from org_assignments a join users u on u.id=a.user_id left join org_units d on d.id=a.department_id left join org_units g on g.id=a.group_id order by a.effective_from desc,u.display_name`)]);return{units:units.rows,assignments:assignments.rows};});
  app.post("/api/admin/organization/units",async(request,reply)=>{const denied=requireAdmin(request,reply);if(denied)return denied;const parsed=unitSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({message:"组织单元信息无效"});if(parsed.data.unitType==="group"&&!parsed.data.parentId)return reply.code(400).send({message:"小组必须指定所属部门"});try{const result=await db.query(`insert into org_units(name,unit_type,parent_id) values($1,$2,$3) returning id::text`,[parsed.data.name,parsed.data.unitType,parsed.data.parentId??null]);return reply.code(201).send({id:result.rows[0]!.id});}catch(error){if((error as{code?:string}).code==="23505")return reply.code(409).send({message:"同名组织单元已存在"});throw error;}});
  app.post("/api/admin/organization/assignments",async(request,reply)=>{const denied=requireAdmin(request,reply);if(denied)return denied;const parsed=assignmentSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({message:"组织任职信息无效"});const users=await db.query<{id:string;username:string}>("select id::text,username from users where lower(username)=any($1::text[])",[[parsed.data.username,parsed.data.leaderUsername,parsed.data.supervisorUsername].filter(Boolean).map(x=>x!.toLowerCase())]);const find=(name?:string)=>users.rows.find(user=>user.username.toLowerCase()===name?.toLowerCase())?.id;const userId=find(parsed.data.username);if(!userId)return reply.code(404).send({message:"人员账号不存在"});await db.query(`insert into org_assignments(user_id,department_id,group_id,leader_user_id,supervisor_user_id,effective_from,effective_to,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)`,[userId,parsed.data.departmentId??null,parsed.data.groupId??null,find(parsed.data.leaderUsername),find(parsed.data.supervisorUsername),parsed.data.effectiveFrom,parsed.data.effectiveTo??null,request.currentUser!.id]);return reply.code(201).send({ok:true});});
}
