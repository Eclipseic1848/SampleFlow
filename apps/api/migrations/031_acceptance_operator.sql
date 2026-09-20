-- 仅显式运维作业可登记一个限时验收账号；新安装数据库不含任何登记。
create table acceptance_operator (
  singleton boolean primary key default true check(singleton),
  user_id bigint not null unique references users(id),
  database_name text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create function acceptance_operator_active(account_id bigint) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.acceptance_operator a join public.users u on u.id=a.user_id
    where a.user_id=account_id and a.database_name=current_database()
      and a.expires_at>now() and u.is_active and u.deleted_at is null)
$$;

-- 将批准当时的验收授权固化，账号过期或停用不会破坏历史记录及备份恢复。
alter table accounting_correction_requests add column acceptance_override boolean not null default false;
alter table historical_order_reviews add column acceptance_override boolean not null default false;
alter table import_configs add column acceptance_override boolean not null default false;
create function record_acceptance_approval() returns trigger language plpgsql as $$
declare actor_id bigint; requester_id bigint; previous_actor bigint; previous_requester bigint;
begin
  if TG_TABLE_NAME='import_configs' then
    actor_id:=NEW.approved_by; requester_id:=NEW.created_by;
    if TG_OP='UPDATE' then previous_actor:=OLD.approved_by; previous_requester:=OLD.created_by; end if;
  else
    actor_id:=NEW.reviewed_by_user_id; requester_id:=NEW.requested_by_user_id;
    if TG_OP='UPDATE' then previous_actor:=OLD.reviewed_by_user_id; previous_requester:=OLD.requested_by_user_id; end if;
  end if;
  if TG_OP='UPDATE' and OLD.acceptance_override and actor_id=previous_actor and requester_id=previous_requester then
    NEW.acceptance_override:=true;
  else
    NEW.acceptance_override:=coalesce(actor_id=requester_id and acceptance_operator_active(actor_id),false);
  end if;
  return NEW;
end $$;
create trigger acceptance_approval before insert or update on accounting_correction_requests
  for each row execute function record_acceptance_approval();
create trigger acceptance_approval before insert or update on historical_order_reviews
  for each row execute function record_acceptance_approval();
create trigger acceptance_approval before insert or update on import_configs
  for each row execute function record_acceptance_approval();

alter table accounting_correction_requests drop constraint accounting_correction_reviewer_separation;
alter table accounting_correction_requests add constraint accounting_correction_reviewer_separation check (
  reviewed_by_person_id is null or reviewed_by_person_id<>requested_by_person_id
  or (reviewed_by_user_id=requested_by_user_id and acceptance_override)
);
alter table historical_order_reviews drop constraint historical_review_reviewer_separation;
alter table historical_order_reviews add constraint historical_review_reviewer_separation check (
  reviewed_by_person_id is null or reviewed_by_person_id<>requested_by_person_id
  or (reviewed_by_user_id=requested_by_user_id and acceptance_override)
);
alter table import_configs drop constraint import_configs_approval_check;
alter table import_configs add constraint import_configs_approval_check check (
  status<>'approved' or (approved_at is not null and (
    (created_by is null and approved_by is null)
    or (approved_by is not null and (approved_by is distinct from created_by or acceptance_override))
  ))
);

-- 应用角色不得通过业务写权限授予验收例外。
revoke all on acceptance_operator from public;
grant execute on function acceptance_operator_active(bigint) to public;
do $$ declare app_role record; begin
  for app_role in select rolname from pg_roles where not rolsuper
    and oid<>(select relowner from pg_class where oid='acceptance_operator'::regclass)
    and has_table_privilege(oid,'acceptance_operator','INSERT') loop
    execute format('revoke insert,update,delete on acceptance_operator from %I',app_role.rolname);
  end loop;
end $$;
