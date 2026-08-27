create table accounting_periods (
  period_month date primary key,
  status text not null default 'open' check (status in ('open','closed')),
  verification_confirmed_by_user_id bigint references users(id),
  verification_confirmed_by_person_id bigint references people(id),
  verification_confirmed_at timestamptz,
  verification_note text,
  closed_by_user_id bigint references users(id),
  closed_by_person_id bigint references people(id),
  closed_at timestamptz,
  close_note text,
  version integer not null default 0 check (version >= 0),
  needs_reclose boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint accounting_periods_month_first_day check (extract(day from period_month) = 1)
);

create table accounting_period_closures (
  id bigint generated always as identity primary key,
  period_month date not null references accounting_periods(period_month),
  version integer not null check (version > 0),
  event_count bigint not null check (event_count >= 0),
  total_amount numeric(14,2) not null,
  confirmed_by_user_id bigint not null references users(id),
  confirmed_by_person_id bigint not null references people(id),
  closed_by_user_id bigint not null references users(id),
  closed_by_person_id bigint not null references people(id),
  closed_at timestamptz not null,
  note text,
  unique (period_month, version)
);

create table accounting_correction_requests (
  id bigint generated always as identity primary key,
  period_month date not null references accounting_periods(period_month),
  order_id bigint not null references performance_orders(id),
  event_type text not null check (event_type in ('revenue_change','pause','restart','first_include')),
  occurred_on date not null,
  reason text not null,
  requested_by_user_id bigint not null references users(id),
  requested_by_person_id bigint not null references people(id),
  requested_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','consumed','revoked')),
  reviewed_by_user_id bigint references users(id),
  reviewed_by_person_id bigint references people(id),
  reviewed_at timestamptz,
  review_note text,
  expires_at timestamptz,
  consumed_by_user_id bigint references users(id),
  consumed_by_person_id bigint references people(id),
  consumed_at timestamptz,
  consumed_event_id bigint references performance_events(id),
  constraint accounting_correction_date_in_month check (
    occurred_on >= period_month and occurred_on < (period_month + interval '1 month')::date
  ),
  constraint accounting_correction_reviewer_separation check (
    reviewed_by_person_id is null or reviewed_by_person_id <> requested_by_person_id
  )
);

create unique index accounting_correction_one_active_scope_uidx
on accounting_correction_requests(order_id, period_month)
where status in ('pending','approved');

create index accounting_correction_status_idx
on accounting_correction_requests(status, requested_at desc);

create table historical_order_reviews (
  id bigint generated always as identity primary key,
  order_id bigint not null references performance_orders(id),
  proposed_lifecycle_state text not null check (proposed_lifecycle_state in ('active','paused','zero')),
  proposed_current_revenue numeric(14,2) not null check (proposed_current_revenue >= 0),
  conclusion text not null,
  evidence text not null,
  reason text not null,
  requested_by_user_id bigint not null references users(id),
  requested_by_person_id bigint not null references people(id),
  requested_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by_user_id bigint references users(id),
  reviewed_by_person_id bigint references people(id),
  reviewed_at timestamptz,
  review_note text,
  resolution_event_id bigint references performance_events(id),
  constraint historical_review_state_revenue check (
    (proposed_lifecycle_state='zero' and proposed_current_revenue=0)
    or (proposed_lifecycle_state in ('active','paused') and proposed_current_revenue>0)
  ),
  constraint historical_review_reviewer_separation check (
    reviewed_by_person_id is null or reviewed_by_person_id <> requested_by_person_id
  )
);

create unique index historical_order_review_one_pending_uidx
on historical_order_reviews(order_id) where status='pending';

create or replace function reject_accounting_closure_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '记账期间关闭快照不可更新或删除';
end;
$$;

create trigger accounting_period_closures_immutable_update
before update on accounting_period_closures
for each row execute function reject_accounting_closure_mutation();

create trigger accounting_period_closures_immutable_delete
before delete on accounting_period_closures
for each row execute function reject_accounting_closure_mutation();
