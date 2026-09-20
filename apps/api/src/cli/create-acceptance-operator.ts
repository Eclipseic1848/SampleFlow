import { writeFile,unlink } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { ROLE_POLICIES } from "../modules/authorization.js";
import { generateTemporaryPassword,hashPassword,TEMPORARY_PASSWORD_TTL_MS } from "../security/password.js";

// 仅显式运维作业使用数据库管理员连接；业务 API 不提供授予验收例外的入口。
if(process.env.ACCEPTANCE_PROVISION_CONFIRM!=="create-single-customer-uat")throw new Error("未确认创建单账号验收例外");
const database=process.env.DB_NAME;
const output=process.env.ACCEPTANCE_CREDENTIALS_FILE;
if(!database||!output||!path.isAbsolute(output))throw new Error("必须指定目标数据库和凭据绝对路径");
const client=new pg.Client({host:process.env.DB_ADMIN_HOST,port:Number(process.env.DB_ADMIN_PORT??5432),database,user:process.env.DB_ADMIN_USER,password:process.env.DB_ADMIN_PASSWORD});
await client.connect();
let credentialWritten=false;let commitStarted=false;
try{
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtext('sampleflow:acceptance-provision'))");
  const context=(await client.query("select current_database() as name,(select rolsuper from pg_roles where rolname=current_user) as administrator")).rows[0];
  if(context.name!==database||!context.administrator)throw new Error("拒绝非管理员作业或目标数据库不匹配");
  if((await client.query("select 1 from acceptance_operator")).rowCount)throw new Error("验收账号已登记，拒绝重复创建或重置");
  const username="customer_acceptance";
  if((await client.query("select 1 from users where lower(username)=lower($1)",[username])).rowCount)throw new Error("账号已存在，拒绝覆盖");
  const roles=Object.keys(ROLE_POLICIES);
  if((await client.query("select code from roles where code=any($1::text[])",[roles])).rowCount!==roles.length)throw new Error("系统角色不完整");
  const password=generateTemporaryPassword();const secured=await hashPassword(password);
  const temporaryPasswordExpiresAt=new Date(Date.now()+TEMPORARY_PASSWORD_TTL_MS).toISOString();
  const acceptanceExpiresAt=new Date(Date.now()+14*24*60*60*1000).toISOString();
  const user=(await client.query(`insert into users(username,display_name,password_hash,password_salt,must_change_password,temporary_password_expires_at)
    values($1,'客户全功能验收',$2,$3,true,$4) returning id::text`,[username,secured.hash,secured.salt,temporaryPasswordExpiresAt])).rows[0];
  await client.query("insert into user_roles(user_id,role_code) select $1,unnest($2::text[])",[user.id,roles]);
  await client.query("insert into acceptance_operator(user_id,database_name,expires_at) values($1,$2,$3)",[user.id,database,acceptanceExpiresAt]);
  await client.query(`insert into audit_logs(action,entity_type,entity_id,after_data)
    values('acceptance.account_provisioned','user',$1,$2::jsonb)`,[user.id,JSON.stringify({username,roles,acceptanceExpiresAt,authorization:"用户明确授权当前试用系统单账号验收",source:"explicit_database_admin_operation"})]);
  await writeFile(output,JSON.stringify({username,password,userId:user.id,temporaryPasswordExpiresAt,acceptanceExpiresAt,note:"仅用于客户验收，所有操作真实生效。首次登录须改密；请勿将此账号交付生产。"},null,2)+"\n",{encoding:"utf8",flag:"wx",mode:0o600});
  credentialWritten=true;commitStarted=true;
  await client.query("commit");
  console.log(`已创建验收账号 ${username}；密码保存在指定私密文件，有效期内仅此账号具备验收例外。`);
}catch(error){
  await client.query("rollback");
  // 提交响应丢失时保留凭据，先核对数据库，不能重建或丢弃未知结果。
  if(credentialWritten&&!commitStarted)await unlink(output);
  throw error;
}finally{await client.end();}
