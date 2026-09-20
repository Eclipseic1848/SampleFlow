-- 调组核对只影响确认过的文件日期，不改正式任职、权限或已入账快照。
create table performance_statistical_transfers (
  id bigint generated always as identity primary key,
  person_id bigint not null references people(id),
  occurred_on date not null,
  effective_from date not null check (effective_from <= occurred_on),
  department_id bigint not null references org_units(id),
  group_id bigint not null references org_units(id),
  previous_department_id bigint not null references org_units(id),
  previous_group_id bigint not null references org_units(id),
  batch_id bigint not null references import_batches(id),
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  check (department_id <> previous_department_id or group_id <> previous_group_id)
);
create index statistical_transfers_person_date on performance_statistical_transfers(person_id,occurred_on,id desc);
create trigger statistical_transfers_validate_units
before insert on performance_statistical_transfers
for each row execute function validate_org_membership();
create trigger statistical_transfers_immutable before update or delete on performance_statistical_transfers
for each row execute function protect_import_setup_evidence();

-- 从原区间中扣除已核对的单日，其他日期保持原解析结果；所有业绩入口共用此视图。
create or replace view performance_organization_memberships as
with transfers as (
  select distinct on(person_id,occurred_on) person_id,occurred_on,department_id,group_id
  from performance_statistical_transfers order by person_id,occurred_on,id desc
), transfer_dates as (
  select person_id,range_agg(daterange(occurred_on,occurred_on,'[]')) dates
  from transfers group by person_id
), base as (
  select person_id,department_id,group_id,effective_from,effective_to from org_memberships
  union all
  select s.person_id,s.department_id,s.group_id,s.occurred_on,s.occurred_on
  from performance_statistical_assignments s
  where not exists (
    select 1 from org_memberships m where m.person_id=s.person_id
      and m.effective_from<=s.occurred_on and (m.effective_to is null or m.effective_to>=s.occurred_on)
  )
)
select b.person_id,b.department_id,b.group_id,lower(segment) effective_from,upper(segment)-1 effective_to
from base b
left join transfer_dates t on t.person_id=b.person_id
cross join lateral unnest(
  datemultirange(daterange(b.effective_from,b.effective_to,'[]')) - coalesce(t.dates,'{}'::datemultirange)
) as remaining(segment)
union all
select person_id,department_id,group_id,occurred_on,occurred_on from transfers;
