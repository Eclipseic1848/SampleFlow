import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { generateTemporaryPassword, hashPassword, TEMPORARY_PASSWORD_TTL_MS } from "../security/password.js";
import { postgresBigintIdSchema } from "../validation.js";
import { hasAnyRole } from "./auth.js";
import { BUSINESS_DATE_SQL, canReadPerformance, resolveGoalAccess, resolvePerformanceAccess, ROLE_PERMISSION_MATRIX } from "./authorization.js";

const createUserSchema = z.strictObject({ username:z.string().trim().min(2).max(100), displayName:z.string().trim().min(1).max(100), roles:z.array(z.string().trim().min(1)).min(1), personId:z.coerce.number().int().positive().nullable().optional() });
const accountListQuerySchema = z.strictObject({ search:z.string().trim().max(100).optional().default(""), cursor:z.string().max(2048).optional() });
const accountCursorSchema = z.strictObject({ version:z.literal(1), userId:postgresBigintIdSchema, search:z.string().max(100), id:postgresBigintIdSchema, cutoffId:postgresBigintIdSchema });
const roleUpdateSchema = z.strictObject({ roles:z.array(z.string().trim().min(1)).min(1) });
const statusSchema = z.object({ isActive:z.boolean() });
const resetSchema = z.strictObject({});
const unitSchema = z.object({ name:z.string().trim().min(1).max(100), unitType:z.enum(["department","group"]), parentId:z.coerce.number().int().positive().nullable().optional() });
const assignmentSchema = z.strictObject({ personId:z.coerce.number().int().positive(), departmentId:z.coerce.number().int().positive(), groupId:z.coerce.number().int().positive(), leaderPersonId:z.coerce.number().int().positive(), supervisorPersonId:z.coerce.number().int().positive(), effectiveFrom:z.iso.date(), effectiveTo:z.iso.date().nullable().optional(), closePrevious:z.boolean().optional().default(false) });
const membershipCloseSchema = z.strictObject({ effectiveOn:z.iso.date() });
const responsibilityReplaceSchema = z.strictObject({ successorPersonId:postgresBigintIdSchema, effectiveOn:z.iso.date() });
const ADMIN_USER_PAGE_SIZE=50;
const fixedRoles=ROLE_PERMISSION_MATRIX.map(({code,name})=>({code,name}));
const fixedRoleCodes=new Set(fixedRoles.map(({code})=>code));

function normalizedFixedRoles(roles:string[]):string[]|null{const normalized=[...new Set(roles)].sort();return normalized.every((role)=>fixedRoleCodes.has(role))?normalized:null;}
function encodeAccountCursor(value:z.infer<typeof accountCursorSchema>):string{return Buffer.from(JSON.stringify(value),"utf8").toString("base64url");}
function decodeAccountCursor(value:string):z.infer<typeof accountCursorSchema>|null{try{const parsed=accountCursorSchema.safeParse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));return parsed.success?parsed.data:null;}catch{return null;}}

function requireAdmin(request:{currentUser:import("./auth.js").CurrentUser|null},reply:{code:(status:number)=>{send:(body:unknown)=>unknown}}){if(!request.currentUser)return reply.code(401).send({message:"尚未登录"});if(!hasAnyRole(request.currentUser,["system_admin"]))return reply.code(403).send({message:"仅系统管理员可执行此操作"});return null;}

export async function registerAdmin(app:FastifyInstance,db:Database){
  app.get("/api/admin/users",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const parsed=accountListQuerySchema.safeParse(request.query);if(!parsed.success)return reply.code(400).send({message:"账号查询条件无效"});
    const cursor=parsed.data.cursor?decodeAccountCursor(parsed.data.cursor):null;
    if(parsed.data.cursor&&(!cursor||cursor.userId!==request.currentUser!.id||cursor.search!==parsed.data.search))return reply.code(400).send({message:"账号分页游标无效或已不适用于当前查询"});
    const client=await db.connect();
    try{
      await client.query("begin transaction isolation level repeatable read read only");
      if(!cursor)await client.query("lock table users in share mode");
      const result=await client.query<{cutoffId:string|null;users:Array<{id:string;username:string;displayName:string;isActive:boolean;mustChangePassword:boolean;roles:string[]}>}>(
        `with cutoff as (select coalesce($3::bigint,max(id)) as id from users), page as (
         select u.id as "__id",u.id::text,u.username,u.display_name as "displayName",u.is_active as "isActive",u.must_change_password as "mustChangePassword",
                coalesce(array_agg(ur.role_code order by ur.role_code) filter(where ur.role_code is not null),'{}') as roles
         from users u left join user_roles ur on ur.user_id=u.id cross join cutoff
         where u.id<=cutoff.id and u.id>coalesce($2::bigint,0)
           and (position(lower($1) in lower(u.username))>0 or position(lower($1) in lower(u.display_name))>0)
         group by u.id order by u.id limit $4
       )
       select cutoff.id::text as "cutoffId",
              coalesce(jsonb_agg(to_jsonb(page)-'__id' order by page."__id") filter(where page."__id" is not null),'[]'::jsonb) as users
       from cutoff left join page on true group by cutoff.id`,
        [parsed.data.search,cursor?.id??null,cursor?.cutoffId??null,ADMIN_USER_PAGE_SIZE+1],
      );
      await client.query("commit");
      const row=result.rows[0]!;const hasNext=row.users.length>ADMIN_USER_PAGE_SIZE;const users=row.users.slice(0,ADMIN_USER_PAGE_SIZE);const last=users.at(-1);
      return{users,roles:fixedRoles,permissionMatrix:ROLE_PERMISSION_MATRIX,pageSize:ADMIN_USER_PAGE_SIZE,nextCursor:hasNext&&last&&row.cutoffId?encodeAccountCursor({version:1,userId:request.currentUser!.id,search:parsed.data.search,id:last.id,cutoffId:row.cutoffId}):null};
    }catch(error){await client.query("rollback");throw error;}finally{client.release();}
  });
  app.get("/api/admin/people",async(request,reply)=>{const denied=requireAdmin(request,reply);if(denied)return denied;const result=await db.query(`select p.id::text,p.display_name as "displayName",u.username from people p left join users u on u.id=p.user_id order by p.display_name,p.id`);return{people:result.rows};});
  app.post("/api/admin/users",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const parsed=createUserSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({message:"账号信息不完整或格式无效"});
    const roles=normalizedFixedRoles(parsed.data.roles);if(!roles)return reply.code(400).send({message:"包含不存在的固定角色"});
    const temporaryPassword=generateTemporaryPassword();const temporaryPasswordExpiresAt=new Date(Date.now()+TEMPORARY_PASSWORD_TTL_MS);const client=await db.connect();
    try{
      await client.query("begin");
      if(parsed.data.personId){
        const person=await client.query<{user_id:string|null}>("select user_id::text from people where id=$1 for update",[parsed.data.personId]);
        if(!person.rows[0]){await client.query("rollback");return reply.code(404).send({message:"待绑定人员身份不存在"});}
        if(person.rows[0].user_id){await client.query("rollback");return reply.code(409).send({message:"该人员身份已绑定登录账号"});}
      }
      const password=await hashPassword(temporaryPassword);
      const user=await client.query<{id:string}>(`insert into users(username,display_name,password_hash,password_salt,must_change_password,temporary_password_expires_at) values($1,$2,$3,$4,true,$5) returning id::text`,[parsed.data.username,parsed.data.displayName,password.hash,password.salt,temporaryPasswordExpiresAt]);
      if(parsed.data.personId){
        await client.query("delete from people where user_id=$1 and source_key=$2",[user.rows[0]!.id,`user:${user.rows[0]!.id}`]);
        await client.query("update people set user_id=$2 where id=$1",[parsed.data.personId,user.rows[0]!.id]);
      }
      for(const role of roles)await client.query(`insert into user_roles(user_id,role_code,assigned_by) values($1,$2,$3)`,[user.rows[0]!.id,role,request.currentUser!.id]);
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address) values($1,'auth.account_created','user',$2,jsonb_build_object('roles',$3::text[],'personId',$4::bigint),$5)`,[request.currentUser!.id,user.rows[0]!.id,roles,parsed.data.personId??null,request.ip]);
      await client.query("commit");
      return reply.code(201).send({id:user.rows[0]!.id,temporaryPassword,temporaryPasswordExpiresAt:temporaryPasswordExpiresAt.toISOString()});
    }catch(error){await client.query("rollback");if((error as{code?:string}).code==="23505")return reply.code(409).send({message:"账号名已存在"});throw error;}finally{client.release();}
  });
  app.patch("/api/admin/users/:id/roles",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);const parsed=roleUpdateSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({message:"角色信息无效"});
    const roles=normalizedFixedRoles(parsed.data.roles);if(!roles)return reply.code(400).send({message:"包含不存在的固定角色"});
    if(String(params.data.id)===request.currentUser!.id&&!roles.includes("system_admin"))return reply.code(409).send({message:"不能移除当前登录账号的系统管理员角色"});
    const client=await db.connect();
    try{
      await client.query("begin");
      const user=await client.query("select id from users where id=$1 for update",[params.data.id]);
      if(!user.rowCount){await client.query("rollback");return reply.code(404).send({message:"账号不存在"});}
      const before=await client.query<{role_code:string}>("select role_code from user_roles where user_id=$1 order by role_code for update",[params.data.id]);
      const previous=before.rows.map((row)=>row.role_code);
      if(previous.length===roles.length&&previous.every((role,index)=>role===roles[index])){await client.query("commit");return{ok:true,changed:false};}
      await client.query("delete from user_roles where user_id=$1",[params.data.id]);
      await client.query("insert into user_roles(user_id,role_code,assigned_by) select $1,unnest($2::text[]),$3",[params.data.id,roles,request.currentUser!.id]);
      await client.query(
        `insert into audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,ip_address)
         values($1,'auth.account_roles_changed','user',$2,$3::jsonb,$4::jsonb,$5)`,
        [request.currentUser!.id,String(params.data.id),JSON.stringify({roles:previous}),JSON.stringify({roles,result:"succeeded"}),request.ip],
      );
      await client.query("commit");return{ok:true,changed:true};
    }catch(error){await client.query("rollback");throw error;}finally{client.release();}
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
  app.get("/api/organization",async(request,reply)=>{
    if(!request.currentUser)return reply.code(401).send({message:"尚未登录"});
    const [performanceAccess,goalAccess]=await Promise.all([resolvePerformanceAccess(db,request.currentUser),resolveGoalAccess(db,request.currentUser)]);
    const all=request.currentUser.roles.includes("system_admin")||performanceAccess.all||goalAccess.all;
    if(!all&&!canReadPerformance(performanceAccess)&&goalAccess.ownerPersonIds.length===0)return reply.code(403).send({message:"当前角色没有组织查看权限"});
    const [units,assignments]=await Promise.all([
      db.query(`select u.id::text,u.name,u.unit_type as "unitType",u.parent_id::text as "parentId",p.name as "parentName",u.is_active as "isActive" from org_units u left join org_units p on p.id=u.parent_id where ($1::boolean or u.id=any($3::bigint[]) or u.id=any($4::bigint[]) or exists(select 1 from org_memberships m where m.person_id=$2 and (m.department_id=u.id or m.group_id=u.id))) order by u.unit_type,u.name`,[all,request.currentUser.personId,performanceAccess.groupIds,performanceAccess.departmentIds]),
      db.query(`select m.id::text,u.username,p.display_name as "displayName",d.name as "departmentName",g.name as "groupName",m.effective_from::text as "effectiveFrom",m.effective_to::text as "effectiveTo" from org_memberships m join people p on p.id=m.person_id left join users u on u.id=p.user_id join org_units d on d.id=m.department_id join org_units g on g.id=m.group_id where ($1::boolean or m.person_id=$2 or ((m.group_id=any($3::bigint[]) or m.department_id=any($4::bigint[])) and m.effective_from<=${BUSINESS_DATE_SQL} and (m.effective_to is null or m.effective_to>=${BUSINESS_DATE_SQL}))) order by m.effective_from desc,p.display_name`,[all,request.currentUser.personId,performanceAccess.groupIds,performanceAccess.departmentIds]),
    ]);
    const responsibilities=request.currentUser.roles.includes("system_admin")
      ?await db.query(`select responsibility.id::text,responsibility.person_id::text as "personId",person.display_name as "displayName",user_account.username,
                             responsibility.org_unit_id::text as "unitId",unit.name as "unitName",unit.unit_type as "unitType",
                             responsibility.responsibility_type as "responsibilityType",responsibility.effective_from::text as "effectiveFrom",responsibility.effective_to::text as "effectiveTo"
                        from org_responsibilities responsibility join people person on person.id=responsibility.person_id
                        left join users user_account on user_account.id=person.user_id join org_units unit on unit.id=responsibility.org_unit_id
                       order by responsibility.effective_from desc,unit.unit_type,unit.name,person.display_name`)
      :{rows:[]};
    return{units:units.rows,assignments:assignments.rows,responsibilities:responsibilities.rows};
  });
  app.post("/api/admin/organization/units",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const parsed=unitSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({message:"组织单元信息无效"});
    if(parsed.data.unitType==="group"&&!parsed.data.parentId)return reply.code(400).send({message:"小组必须指定所属部门"});
    const client=await db.connect();
    try{
      await client.query("begin");
      const result=await client.query<{id:string}>(`insert into org_units(name,unit_type,parent_id,is_active) values($1,$2,$3,false) returning id::text`,[parsed.data.name,parsed.data.unitType,parsed.data.parentId??null]);
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address) values($1,'organization.unit_created','org_unit',$2,$3::jsonb,$4)`,[request.currentUser!.id,result.rows[0]!.id,JSON.stringify({...parsed.data,isActive:false}),request.ip]);
      await client.query("commit");return reply.code(201).send({id:result.rows[0]!.id});
    }catch(error){await client.query("rollback");if((error as{code?:string}).code==="23505")return reply.code(409).send({message:"同名组织单元已存在"});throw error;}finally{client.release();}
  });
  app.post("/api/admin/organization/assignments",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const parsed=assignmentSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({message:"组织任职信息无效"});
    const personIds=[parsed.data.personId,parsed.data.leaderPersonId,parsed.data.supervisorPersonId];
    const people=await db.query<{id:string}>("select id::text from people where id=any($1::bigint[])",[personIds]);
    if(new Set(people.rows.map((person)=>person.id)).size!==new Set(personIds.map(String)).size)return reply.code(404).send({message:"成员或负责人身份不存在"});
    const client=await db.connect();
    try{
      await client.query("begin");
      if(parsed.data.closePrevious){
        const previous=await client.query<{id:string;departmentId:string;groupId:string;effectiveFrom:string;effectiveTo:string|null}>(
          `select id::text,department_id::text as "departmentId",group_id::text as "groupId",effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo"
             from org_memberships
            where person_id=$1 and effective_from<$2::date and (effective_to is null or effective_to>=$2::date)
            order by effective_from desc
            for update`,
          [parsed.data.personId,parsed.data.effectiveFrom],
        );
        if(previous.rowCount!==1){
          await client.query("rollback");
          return reply.code(409).send({message:"异动生效日前必须恰好存在一条可结束的任职"});
        }
        const current=previous.rows[0]!;
        if(current.departmentId===String(parsed.data.departmentId)&&current.groupId===String(parsed.data.groupId)){
          await client.query("rollback");
          return reply.code(409).send({message:"异动后的部门和小组不能与当前任职相同"});
        }
        const closed=await client.query<{effectiveTo:string}>(
          `update org_memberships set effective_to=$2::date-1 where id=$1 returning effective_to::text as "effectiveTo"`,
          [current.id,parsed.data.effectiveFrom],
        );
        await client.query(
          `insert into audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,ip_address)
           values($1,'organization.assignment_closed_for_transfer','org_membership',$2,$3::jsonb,$4::jsonb,$5)`,
          [request.currentUser!.id,current.id,JSON.stringify(current),JSON.stringify({...current,effectiveTo:closed.rows[0]!.effectiveTo,effectiveOn:parsed.data.effectiveFrom,result:"succeeded"}),request.ip],
        );
      }
      for(const [personId,unitId,type] of [[parsed.data.leaderPersonId,parsed.data.groupId,"leader"],[parsed.data.supervisorPersonId,parsed.data.departmentId,"supervisor"]] as const){
        const existing=await client.query(
          `select 1 from org_responsibilities where person_id=$1 and org_unit_id=$2 and responsibility_type=$3
             and effective_from<=$4::date
             and (($5::date is null and effective_to is null)
                  or ($5::date is not null and (effective_to is null or effective_to>=$5::date)))`,
          [personId,unitId,type,parsed.data.effectiveFrom,parsed.data.effectiveTo??null],
        );
        if(!existing.rowCount){
          const responsibility=await client.query<{id:string}>(
            `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from,effective_to,created_by)
             values($1,$2,$3,$4,$5,$6) returning id::text`,
            [personId,unitId,type,parsed.data.effectiveFrom,parsed.data.effectiveTo??null,request.currentUser!.id],
          );
          await client.query(
            `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address)
             values($1,'organization.responsibility_created','org_responsibility',$2,$3::jsonb,$4)`,
            [request.currentUser!.id,responsibility.rows[0]!.id,JSON.stringify({personId,orgUnitId:unitId,responsibilityType:type,effectiveFrom:parsed.data.effectiveFrom,effectiveTo:parsed.data.effectiveTo??null,effectiveOn:parsed.data.effectiveFrom,result:"succeeded"}),request.ip],
          );
        }
      }
      const membership=await client.query<{id:string}>(
        `insert into org_memberships(person_id,department_id,group_id,effective_from,effective_to,created_by)
         values($1,$2,$3,$4,$5,$6) returning id::text`,
        [parsed.data.personId,parsed.data.departmentId,parsed.data.groupId,parsed.data.effectiveFrom,parsed.data.effectiveTo??null,request.currentUser!.id],
      );
      const activated=await client.query<{id:string}>("update org_units set is_active=true where id=any($1::bigint[]) and not is_active returning id::text",[[parsed.data.departmentId,parsed.data.groupId]]);
      for(const unit of activated.rows){
        await client.query(
          `insert into audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,ip_address)
           values($1,'organization.unit_activated','org_unit',$2,$3::jsonb,$4::jsonb,$5)`,
          [request.currentUser!.id,unit.id,JSON.stringify({isActive:false}),JSON.stringify({isActive:true}),request.ip],
        );
      }
      await client.query(`insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,ip_address) values($1,'organization.assignment_created','org_membership',$2,$3::jsonb,$4)`,[request.currentUser!.id,membership.rows[0]!.id,JSON.stringify({...parsed.data,effectiveOn:parsed.data.effectiveFrom,result:"succeeded"}),request.ip]);
      await client.query("commit");
      return reply.code(201).send({ok:true});
    }catch(error){await client.query("rollback");if(["23P01","23514","23503","P0001"].includes((error as{code?:string}).code??""))return reply.code(409).send({message:"组织层级、成员任职或负责人有效期冲突"});throw error;}finally{client.release();}
  });
  app.post("/api/admin/organization/memberships/:id/close",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const params=z.strictObject({id:postgresBigintIdSchema}).safeParse(request.params);const parsed=membershipCloseSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({message:"任职关闭信息无效"});
    const client=await db.connect();
    try{
      await client.query("begin");
      const before=await client.query<{id:string;personId:string;departmentId:string;groupId:string;effectiveFrom:string;effectiveTo:string|null}>(
        `select id::text,person_id::text as "personId",department_id::text as "departmentId",group_id::text as "groupId",
                effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo"
           from org_memberships where id=$1 for update`,
        [params.data.id],
      );
      if(!before.rowCount){await client.query("rollback");return reply.code(404).send({message:"人员任职不存在"});}
      const current=before.rows[0]!;
      if(current.effectiveTo){await client.query("rollback");return reply.code(409).send({message:"人员任职已经关闭"});}
      if(parsed.data.effectiveOn<=current.effectiveFrom){await client.query("rollback");return reply.code(409).send({message:"离任生效日期必须晚于任职起始日期"});}
      const closed=await client.query<{effectiveTo:string}>("update org_memberships set effective_to=$2::date-1 where id=$1 returning effective_to::text as \"effectiveTo\"",[params.data.id,parsed.data.effectiveOn]);
      await client.query(
        `insert into audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,ip_address)
         values($1,'organization.assignment_closed','org_membership',$2,$3::jsonb,$4::jsonb,$5)`,
        [request.currentUser!.id,params.data.id,JSON.stringify(current),JSON.stringify({...current,effectiveTo:closed.rows[0]!.effectiveTo,effectiveOn:parsed.data.effectiveOn,result:"succeeded"}),request.ip],
      );
      await client.query("commit");return{ok:true,effectiveTo:closed.rows[0]!.effectiveTo};
    }catch(error){await client.query("rollback");if(["23514","P0001"].includes((error as{code?:string}).code??""))return reply.code(409).send({message:"任职截止日期与组织有效期冲突"});throw error;}finally{client.release();}
  });
  app.post("/api/admin/organization/responsibilities/:id/replace",async(request,reply)=>{
    const denied=requireAdmin(request,reply);if(denied)return denied;
    const params=z.strictObject({id:postgresBigintIdSchema}).safeParse(request.params);const parsed=responsibilityReplaceSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({message:"负责人继任信息无效"});
    const client=await db.connect();
    try{
      await client.query("begin");
      const successor=await client.query("select id from people where id=$1",[parsed.data.successorPersonId]);
      if(!successor.rowCount){await client.query("rollback");return reply.code(404).send({message:"继任负责人身份不存在"});}
      const before=await client.query<{id:string;personId:string;orgUnitId:string;responsibilityType:"leader"|"supervisor";effectiveFrom:string;effectiveTo:string|null}>(
        `select id::text,person_id::text as "personId",org_unit_id::text as "orgUnitId",responsibility_type as "responsibilityType",
                effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo"
           from org_responsibilities where id=$1 for update`,
        [params.data.id],
      );
      if(!before.rowCount){await client.query("rollback");return reply.code(404).send({message:"负责人职责不存在"});}
      const current=before.rows[0]!;
      if(current.effectiveTo){await client.query("rollback");return reply.code(409).send({message:"负责人职责已经结束"});}
      if(parsed.data.effectiveOn<=current.effectiveFrom){await client.query("rollback");return reply.code(409).send({message:"继任生效日期必须晚于现任负责人起始日期"});}
      if(parsed.data.successorPersonId===current.personId){await client.query("rollback");return reply.code(409).send({message:"继任负责人不能与现任负责人相同"});}
      const closed=await client.query<{effectiveTo:string}>("update org_responsibilities set effective_to=$2::date-1 where id=$1 returning effective_to::text as \"effectiveTo\"",[params.data.id,parsed.data.effectiveOn]);
      const created=await client.query<{id:string}>(
        `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from,created_by)
         values($1,$2,$3,$4,$5) returning id::text`,
        [parsed.data.successorPersonId,current.orgUnitId,current.responsibilityType,parsed.data.effectiveOn,request.currentUser!.id],
      );
      await client.query(
        `insert into audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,ip_address)
         values($1,'organization.responsibility_replaced','org_responsibility',$2,$3::jsonb,$4::jsonb,$5)`,
        [request.currentUser!.id,params.data.id,JSON.stringify(current),JSON.stringify({effectiveOn:parsed.data.effectiveOn,predecessor:{...current,effectiveTo:closed.rows[0]!.effectiveTo},successor:{id:created.rows[0]!.id,personId:parsed.data.successorPersonId,orgUnitId:current.orgUnitId,responsibilityType:current.responsibilityType,effectiveFrom:parsed.data.effectiveOn,effectiveTo:null},result:"succeeded"}),request.ip],
      );
      await client.query("commit");return reply.code(201).send({id:created.rows[0]!.id,predecessorEffectiveTo:closed.rows[0]!.effectiveTo});
    }catch(error){await client.query("rollback");if(["23P01","23514","23503","P0001"].includes((error as{code?:string}).code??""))return reply.code(409).send({message:"负责人继任必须连续且不能重叠"});throw error;}finally{client.release();}
  });
}
