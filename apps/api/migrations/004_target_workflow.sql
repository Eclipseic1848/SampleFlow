create table goals (
  id bigint generated always as identity primary key,
  period_month date not null,
  goal_level text not null check (goal_level in ('sales_manager', 'department', 'group', 'personal')),
  owner_user_id bigint not null references users(id),
  parent_goal_id bigint references goals(id),
  created_at timestamptz not null default now(),
  constraint goals_month_first_day check (extract(day from period_month) = 1),
  unique (period_month, goal_level, owner_user_id)
);
create index goals_parent_goal_id_idx on goals (parent_goal_id);
create index goals_owner_period_idx on goals (owner_user_id, period_month desc);

create table goal_versions (
  id bigint generated always as identity primary key,
  goal_id bigint not null references goals(id),
  version_no bigint not null,
  amount numeric(14, 2) not null check (amount >= 0),
  status text not null check (status in ('draft', 'pending_signature', 'pending_gm', 'pending_hr', 'active', 'rejected', 'superseded')),
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  signed_by bigint references users(id),
  signed_at timestamptz,
  signature_text text,
  change_reason text,
  unique (goal_id, version_no)
);
create index goal_versions_goal_status_idx on goal_versions (goal_id, status, version_no desc);
create index goal_versions_created_by_idx on goal_versions (created_by);
create index goal_versions_signed_by_idx on goal_versions (signed_by);

create unique index goal_versions_one_active_idx on goal_versions (goal_id) where status = 'active';

create table goal_approvals (
  id bigint generated always as identity primary key,
  goal_version_id bigint not null references goal_versions(id),
  approval_stage text not null check (approval_stage in ('general_manager', 'hr')),
  decision text not null check (decision in ('approved', 'rejected')),
  decided_by bigint not null references users(id),
  comment text,
  decided_at timestamptz not null default now(),
  unique (goal_version_id, approval_stage)
);
create index goal_approvals_decided_by_idx on goal_approvals (decided_by);

create table goal_change_requests (
  id bigint generated always as identity primary key,
  goal_id bigint not null references goals(id),
  requested_by bigint not null references users(id),
  requested_amount numeric(14, 2),
  reason text not null,
  status text not null check (status in ('pending', 'accepted', 'rejected', 'completed')),
  handled_by bigint references users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index goal_change_requests_goal_status_idx on goal_change_requests (goal_id, status, created_at desc);
create index goal_change_requests_requested_by_idx on goal_change_requests (requested_by);
create index goal_change_requests_handled_by_idx on goal_change_requests (handled_by);

create table goal_linkage_decisions (
  id bigint generated always as identity primary key,
  parent_goal_id bigint not null references goals(id),
  triggering_child_version_id bigint not null references goal_versions(id),
  decision text not null check (decision in ('adjust_parent', 'keep_parent')),
  decided_by bigint not null references users(id),
  decided_at timestamptz not null default now(),
  unique (parent_goal_id, triggering_child_version_id)
);
create index goal_linkage_decisions_decided_by_idx on goal_linkage_decisions (decided_by);

