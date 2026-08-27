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
  return null;
end;
$$;

create constraint trigger org_memberships_responsibility_coverage
after insert or update or delete on org_memberships
deferrable initially deferred
for each row execute function validate_organization_responsibility_coverage();

create constraint trigger org_responsibilities_membership_coverage
after insert or update or delete on org_responsibilities
deferrable initially deferred
for each row execute function validate_organization_responsibility_coverage();
