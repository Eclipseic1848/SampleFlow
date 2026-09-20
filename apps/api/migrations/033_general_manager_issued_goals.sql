-- 审批路径绑定创建时的版本，旧目标仍沿用总经理审批、人事终审。
alter table goal_versions add column gm_issued boolean not null default false;

create function protect_goal_issue_route() returns trigger language plpgsql as $$
begin
  if TG_OP='UPDATE' then
    if NEW.gm_issued is distinct from OLD.gm_issued then
      raise exception '目标版本下达方式不可修改';
    end if;
  elsif NEW.gm_issued and not exists (
    select 1 from goals g
    join users u on u.id=NEW.created_by and u.is_active
    join people p on p.user_id=u.id and p.id=NEW.created_by_person_id and p.is_active
    join user_roles r on r.user_id=u.id and r.role_code='general_manager'
    where g.id=NEW.goal_id and g.goal_level='sales_manager'
      and g.owner_person_id<>NEW.created_by_person_id
  ) then
    raise exception '只有总经理向其他销售经理下达的总目标可使用此审批路径';
  end if;
  return NEW;
end;
$$;

create trigger goal_issue_route_integrity before insert or update on goal_versions
for each row execute function protect_goal_issue_route();
