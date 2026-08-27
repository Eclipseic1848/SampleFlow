create table roles (
  code text primary key,
  name text not null unique
);

create table users (
  id bigint generated always as identity primary key,
  username text not null,
  display_name text not null,
  password_hash text not null,
  password_salt text not null,
  is_active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_username_not_blank check (btrim(username) <> ''),
  constraint users_display_name_not_blank check (btrim(display_name) <> '')
);
create unique index users_username_lower_uidx on users (lower(username));

create table user_roles (
  user_id bigint not null references users(id),
  role_code text not null references roles(code),
  assigned_at timestamptz not null default now(),
  assigned_by bigint references users(id),
  primary key (user_id, role_code)
);
create index user_roles_role_code_idx on user_roles (role_code);
create index user_roles_assigned_by_idx on user_roles (assigned_by);

create table sessions (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  user_agent text,
  ip_address inet
);
create index sessions_active_user_idx on sessions (user_id, expires_at) where revoked_at is null;

create table org_units (
  id bigint generated always as identity primary key,
  name text not null,
  unit_type text not null check (unit_type in ('department', 'group')),
  parent_id bigint references org_units(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (name, unit_type)
);
create index org_units_parent_id_idx on org_units (parent_id);

create table org_assignments (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  department_id bigint references org_units(id),
  group_id bigint references org_units(id),
  leader_user_id bigint references users(id),
  supervisor_user_id bigint references users(id),
  effective_from date not null,
  effective_to date,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  constraint org_assignments_valid_range check (effective_to is null or effective_to >= effective_from)
);
create index org_assignments_user_period_idx on org_assignments (user_id, effective_from desc, effective_to);
create index org_assignments_department_id_idx on org_assignments (department_id);
create index org_assignments_group_id_idx on org_assignments (group_id);
create index org_assignments_leader_user_id_idx on org_assignments (leader_user_id);
create index org_assignments_supervisor_user_id_idx on org_assignments (supervisor_user_id);
create index org_assignments_created_by_idx on org_assignments (created_by);

create table audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id bigint references users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_actor_idx on audit_logs (actor_user_id, created_at desc);

