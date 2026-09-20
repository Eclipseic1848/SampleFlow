-- 导入确认的统计归属不构成正式任职或管理授权。
create table import_person_links (
  config_id bigint not null references import_configs(id),
  source_identity text not null check (btrim(source_identity) <> ''),
  person_id bigint not null references people(id),
  batch_id bigint not null references import_batches(id),
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  primary key(config_id, source_identity)
);

create table performance_statistical_assignments (
  person_id bigint not null references people(id),
  occurred_on date not null,
  department_id bigint not null references org_units(id),
  group_id bigint not null references org_units(id),
  batch_id bigint not null references import_batches(id),
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  primary key(person_id, occurred_on)
);
create trigger statistical_assignments_validate_units
before insert or update of department_id,group_id on performance_statistical_assignments
for each row execute function validate_org_membership();

create function protect_import_setup_evidence() returns trigger language plpgsql as $$
begin
  raise exception '已确认的导入身份与统计归属不可覆盖或删除';
end;
$$;
create trigger import_person_links_immutable before update or delete on import_person_links
for each row execute function protect_import_setup_evidence();
create trigger statistical_assignments_immutable before update or delete on performance_statistical_assignments
for each row execute function protect_import_setup_evidence();

alter table performance_events drop constraint performance_events_collaboration_check;
alter table performance_events add constraint performance_events_collaboration_check check (
  (collaborator_person_id is null and collaborator_name is null and collaboration_ratio is null
    and collaborator_department_unit_id is null and collaborator_department_name is null
    and collaborator_group_unit_id is null and collaborator_group_name is null
    and collaborator_leader_person_id is null and collaborator_leader_name is null
    and collaborator_supervisor_person_id is null and collaborator_supervisor_name is null)
  or (collaborator_person_id is not null and collaborator_name is not null and collaborator_name <> ''
    and collaboration_ratio is not null and collaboration_ratio > 0 and collaboration_ratio < 1
    and collaborator_person_id is distinct from salesperson_person_id
    and collaborator_department_unit_id is not null and collaborator_department_name is not null
    and collaborator_group_unit_id is not null and collaborator_group_name is not null
    and ((collaborator_leader_person_id is null) = (collaborator_leader_name is null))
    and ((collaborator_supervisor_person_id is null) = (collaborator_supervisor_name is null)))
);

-- 只供业绩解析使用；目标与管理授权继续读取正式任职和负责人表。
create view performance_organization_memberships as
select person_id,department_id,group_id,effective_from,effective_to from org_memberships
union all
select s.person_id,s.department_id,s.group_id,s.occurred_on,s.occurred_on
from performance_statistical_assignments s
where not exists (
  select 1 from org_memberships m where m.person_id=s.person_id
    and m.effective_from<=s.occurred_on and (m.effective_to is null or m.effective_to>=s.occurred_on)
);
