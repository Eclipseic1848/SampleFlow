create extension if not exists btree_gist;

create table people (
  id bigint generated always as identity primary key,
  display_name text not null,
  user_id bigint unique references users(id),
  identity_source text not null default 'system_account',
  source_key text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint people_display_name_not_blank check (btrim(display_name) <> ''),
  constraint people_source_key_not_blank check (btrim(source_key) <> '')
);
create index people_display_name_idx on people (display_name);

insert into people(display_name,user_id,identity_source,source_key)
select display_name,id,'system_account','user:'||id::text from users;

create or replace function create_person_for_user()
returns trigger language plpgsql as $$
begin
  insert into people(display_name,user_id,identity_source,source_key)
  values(new.display_name,new.id,'system_account','user:'||new.id::text);
  return new;
end;
$$;

create trigger users_create_person
after insert on users
for each row execute function create_person_for_user();

alter table org_units drop constraint org_units_name_unit_type_key;
alter table org_units add constraint org_units_shape_check check (
  (unit_type='department' and parent_id is null)
  or (unit_type='group' and parent_id is not null)
);
create unique index org_units_department_name_uidx on org_units(lower(name)) where unit_type='department';
create unique index org_units_group_parent_name_uidx on org_units(parent_id,lower(name)) where unit_type='group';

create or replace function validate_org_unit_parent()
returns trigger language plpgsql as $$
begin
  if new.unit_type='group' and not exists(
    select 1 from org_units parent where parent.id=new.parent_id and parent.unit_type='department'
  ) then
    raise exception '小组必须属于有效部门';
  end if;
  return new;
end;
$$;

create trigger org_units_validate_parent
before insert or update of unit_type,parent_id on org_units
for each row execute function validate_org_unit_parent();

create table org_memberships (
  id bigint generated always as identity primary key,
  person_id bigint not null references people(id),
  department_id bigint not null references org_units(id),
  group_id bigint not null references org_units(id),
  effective_from date not null,
  effective_to date,
  provenance jsonb,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  constraint org_memberships_valid_range check (effective_to is null or effective_to >= effective_from),
  constraint org_memberships_no_overlap exclude using gist (
    person_id with =,
    daterange(effective_from,coalesce(effective_to+1,'infinity'::date),'[)') with &&
  )
);
create index org_memberships_department_period_idx on org_memberships(department_id,effective_from,effective_to);
create index org_memberships_group_period_idx on org_memberships(group_id,effective_from,effective_to);

create or replace function validate_org_membership()
returns trigger language plpgsql as $$
begin
  if not exists(
    select 1 from org_units g
    join org_units d on d.id=new.department_id and d.unit_type='department'
    where g.id=new.group_id and g.unit_type='group' and g.parent_id=d.id
  ) then
    raise exception '小组必须属于所选部门';
  end if;
  return new;
end;
$$;

create trigger org_memberships_validate_units
before insert or update of department_id,group_id on org_memberships
for each row execute function validate_org_membership();

create table org_responsibilities (
  id bigint generated always as identity primary key,
  person_id bigint not null references people(id),
  org_unit_id bigint not null references org_units(id),
  responsibility_type text not null check (responsibility_type in ('leader','supervisor')),
  effective_from date not null,
  effective_to date,
  provenance jsonb,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  constraint org_responsibilities_valid_range check (effective_to is null or effective_to >= effective_from),
  constraint org_responsibilities_one_owner exclude using gist (
    org_unit_id with =,
    responsibility_type with =,
    daterange(effective_from,coalesce(effective_to+1,'infinity'::date),'[)') with &&
  )
);
create index org_responsibilities_person_period_idx on org_responsibilities(person_id,effective_from,effective_to);

create or replace function validate_org_responsibility()
returns trigger language plpgsql as $$
declare expected_type text;
begin
  expected_type := case when new.responsibility_type='leader' then 'group' else 'department' end;
  if not exists(select 1 from org_units where id=new.org_unit_id and unit_type=expected_type) then
    raise exception '负责人类型与组织单元不匹配';
  end if;
  return new;
end;
$$;

create trigger org_responsibilities_validate_unit
before insert or update of org_unit_id,responsibility_type on org_responsibilities
for each row execute function validate_org_responsibility();

alter table performance_orders
  add column salesperson_person_id bigint references people(id);
create index performance_orders_salesperson_person_idx on performance_orders(salesperson_person_id,source_received_on desc);

alter table performance_events
  add column salesperson_person_id bigint references people(id),
  add column department_unit_id bigint references org_units(id),
  add column group_unit_id bigint references org_units(id),
  add column leader_person_id bigint references people(id),
  add column supervisor_person_id bigint references people(id);
create index performance_events_month_person_idx on performance_events(accounting_month,salesperson_person_id) include(delta_amount);
create index performance_events_month_unit_idx on performance_events(accounting_month,department_unit_id,group_unit_id) include(delta_amount);

alter table goals add column owner_person_id bigint references people(id);
update goals g set owner_person_id=p.id from people p where p.user_id=g.owner_user_id;
alter table goals alter column owner_person_id set not null;
create index goals_owner_person_period_idx on goals(owner_person_id,period_month desc);
