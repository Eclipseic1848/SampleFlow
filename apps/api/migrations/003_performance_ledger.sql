create table performance_orders (
  id bigint generated always as identity primary key,
  qingflow_order_no text not null unique,
  customer_name text not null,
  customer_unit text not null,
  salesperson_name text not null,
  service_type text,
  source_received_on date not null,
  original_amount numeric(14, 2) not null check (original_amount >= 0),
  current_revenue numeric(14, 2) not null check (current_revenue >= 0),
  counted_amount numeric(14, 2) not null,
  lifecycle_state text not null check (lifecycle_state in ('draft', 'active', 'paused', 'zero')),
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  posted_at timestamptz
);
create index performance_orders_salesperson_idx on performance_orders (salesperson_name, source_received_on desc);
create index performance_orders_state_idx on performance_orders (lifecycle_state, source_received_on desc);

create table performance_events (
  id bigint generated always as identity primary key,
  order_id bigint not null references performance_orders(id),
  event_type text not null check (event_type in ('initial', 'revenue_change', 'pause', 'restart', 'first_include', 'legacy_adjustment')),
  delta_amount numeric(14, 2) not null,
  resulting_current_revenue numeric(14, 2) not null check (resulting_current_revenue >= 0),
  resulting_counted_amount numeric(14, 2) not null,
  accounting_month date not null,
  occurred_on date not null,
  reason text,
  salesperson_name text not null,
  department_name text not null,
  group_name text not null,
  leader_name text,
  supervisor_name text,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  source_row_number bigint,
  constraint performance_events_month_first_day check (extract(day from accounting_month) = 1)
);
create index performance_events_order_time_idx on performance_events (order_id, occurred_on, id);
create index performance_events_month_org_idx on performance_events (accounting_month, department_name, group_name);
create index performance_events_month_salesperson_idx on performance_events (accounting_month, salesperson_name) include (delta_amount);

create or replace function reject_performance_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '已入账业绩事件不可更新或删除';
end;
$$;

create trigger performance_events_immutable_update
before update on performance_events
for each row execute function reject_performance_event_mutation();

create trigger performance_events_immutable_delete
before delete on performance_events
for each row execute function reject_performance_event_mutation();
