create or replace function reject_confirmed_goal_version_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.signed_at is not null then
      raise exception '已确认目标版本不可删除';
    end if;
    return old;
  end if;

  if new.goal_id is distinct from old.goal_id
    or new.version_no is distinct from old.version_no
    or new.amount is distinct from old.amount
    or new.created_by is distinct from old.created_by
    or new.created_by_person_id is distinct from old.created_by_person_id
    or new.created_at is distinct from old.created_at
    or new.change_reason is distinct from old.change_reason
  then
    raise exception '目标版本内容不可修改';
  end if;

  if old.signed_at is not null and (
    new.signed_by is distinct from old.signed_by
    or new.signed_by_person_id is distinct from old.signed_by_person_id
    or new.signed_at is distinct from old.signed_at
    or new.signature_text is distinct from old.signature_text
  ) then
    raise exception '目标确认信息不可修改';
  end if;
  return new;
end;
$$;

create trigger goal_versions_confirmation_immutable_update
before update on goal_versions
for each row execute function reject_confirmed_goal_version_mutation();

create trigger goal_versions_confirmation_immutable_delete
before delete on goal_versions
for each row execute function reject_confirmed_goal_version_mutation();

create or replace function reject_audit_log_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '审计日志不可更新或删除';
end;
$$;

create trigger audit_logs_immutable_update
before update on audit_logs
for each row execute function reject_audit_log_mutation();

create trigger audit_logs_immutable_delete
before delete on audit_logs
for each row execute function reject_audit_log_mutation();
