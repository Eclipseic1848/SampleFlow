alter table org_units alter column is_active set default false;

update org_units u set is_active=false
where u.is_active and not coalesce((
  select daterange(min(r.effective_from),'infinity'::date,'[)') <@
         range_agg(daterange(r.effective_from,coalesce(r.effective_to+1,'infinity'::date),'[)'))
  from org_responsibilities r
  where r.org_unit_id=u.id
    and r.responsibility_type=case when u.unit_type='group' then 'leader' else 'supervisor' end
),false);

create or replace function validate_organization_responsibility_coverage()
returns trigger language plpgsql as $$
begin
  if exists(
    select 1 from org_memberships m
    where not coalesce(
      daterange(m.effective_from,coalesce(m.effective_to+1,'infinity'::date),'[)') <@ (
        select range_agg(daterange(r.effective_from,coalesce(r.effective_to+1,'infinity'::date),'[)'))
        from org_responsibilities r
        where r.org_unit_id=m.group_id and r.responsibility_type='leader'
      ),false
    ) or not coalesce(
      daterange(m.effective_from,coalesce(m.effective_to+1,'infinity'::date),'[)') <@ (
        select range_agg(daterange(r.effective_from,coalesce(r.effective_to+1,'infinity'::date),'[)'))
        from org_responsibilities r
        where r.org_unit_id=m.department_id and r.responsibility_type='supervisor'
      ),false
    )
  ) then
    raise exception '成员任职期间必须由连续的小组负责人和部门主管完整覆盖';
  end if;

  if exists(
    select 1 from org_units u
    where u.is_active and not coalesce((
      select daterange(min(r.effective_from),'infinity'::date,'[)') <@
             range_agg(daterange(r.effective_from,coalesce(r.effective_to+1,'infinity'::date),'[)'))
      from org_responsibilities r
      where r.org_unit_id=u.id
        and r.responsibility_type=case when u.unit_type='group' then 'leader' else 'supervisor' end
    ),false)
  ) then
    raise exception '启用组织单元必须由持续有效的负责人完整覆盖';
  end if;
  return null;
end;
$$;

create constraint trigger org_units_responsibility_coverage
after insert or update or delete on org_units
deferrable initially deferred
for each row execute function validate_organization_responsibility_coverage();

do $$
begin
  if exists(
    select 1 from org_units u
    where u.is_active and not coalesce((
      select daterange(min(r.effective_from),'infinity'::date,'[)') <@
             range_agg(daterange(r.effective_from,coalesce(r.effective_to+1,'infinity'::date),'[)'))
      from org_responsibilities r
      where r.org_unit_id=u.id
        and r.responsibility_type=case when u.unit_type='group' then 'leader' else 'supervisor' end
    ),false)
  ) then
    raise exception '既有启用组织单元缺少持续有效负责人，迁移停止';
  end if;
end;
$$;

create or replace function reject_performance_event_mutation()
returns trigger language plpgsql as $$
declare
  backfill_source_sha256 text := current_setting('sampleflow.event_identity_backfill_source_sha256',true);
begin
  if old.event_type='legacy_adjustment'
     and old.source_row_number is not null
     and exists(
       select 1 from legacy_import_runs run
       where run.source_sha256=backfill_source_sha256
         and old.source_row_number between 2 and run.source_rows+1
     )
     and old.salesperson_person_id is null and new.salesperson_person_id is not null
     and old.department_unit_id is null and new.department_unit_id is not null
     and old.group_unit_id is null and new.group_unit_id is not null
     and old.leader_person_id is null and new.leader_person_id is not null
     and old.supervisor_person_id is null and new.supervisor_person_id is not null
     and exists(
       select 1
       from people salesperson
       join org_memberships membership on membership.person_id=salesperson.id
       join org_units department on department.id=membership.department_id
       join org_units work_group on work_group.id=membership.group_id and work_group.parent_id=department.id
       join org_responsibilities leader_assignment on leader_assignment.org_unit_id=work_group.id and leader_assignment.responsibility_type='leader'
       join people leader on leader.id=leader_assignment.person_id
       join org_responsibilities supervisor_assignment on supervisor_assignment.org_unit_id=department.id and supervisor_assignment.responsibility_type='supervisor'
       join people supervisor on supervisor.id=supervisor_assignment.person_id
       where salesperson.id=new.salesperson_person_id
         and salesperson.source_key='legacy-organization:'||old.salesperson_name
         and department.id=new.department_unit_id and department.name=old.department_name
         and work_group.id=new.group_unit_id and work_group.name=old.group_name
         and leader.id=new.leader_person_id and leader.display_name=new.leader_name
         and supervisor.id=new.supervisor_person_id and supervisor.display_name=new.supervisor_name
         and membership.effective_from<=old.occurred_on and (membership.effective_to is null or membership.effective_to>=old.occurred_on)
         and leader_assignment.effective_from<=old.occurred_on and (leader_assignment.effective_to is null or leader_assignment.effective_to>=old.occurred_on)
         and supervisor_assignment.effective_from<=old.occurred_on and (supervisor_assignment.effective_to is null or supervisor_assignment.effective_to>=old.occurred_on)
     )
     and old.order_id=new.order_id
     and old.event_type=new.event_type
     and old.delta_amount=new.delta_amount
     and old.resulting_current_revenue=new.resulting_current_revenue
     and old.resulting_counted_amount=new.resulting_counted_amount
     and old.accounting_month=new.accounting_month
     and old.occurred_on=new.occurred_on
     and old.reason is not distinct from new.reason
     and old.salesperson_name=new.salesperson_name
     and old.department_name=new.department_name
     and old.group_name=new.group_name
     and (old.leader_name is null or old.leader_name=new.leader_name)
     and (old.supervisor_name is null or old.supervisor_name=new.supervisor_name)
     and old.created_by is not distinct from new.created_by
     and old.created_at=new.created_at
     and old.source_row_number is not distinct from new.source_row_number then
    return new;
  end if;
  raise exception '已入账业绩事件不可更新或删除';
end;
$$;
