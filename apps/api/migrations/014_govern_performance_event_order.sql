alter table performance_events
  add column occurred_at timestamptz,
  add column order_sequence integer,
  add column idempotency_key text,
  add column request_fingerprint text;

alter table performance_events disable trigger performance_events_immutable_update;

update performance_events set occurred_at=created_at where occurred_at is null;
with numbered as (
  select id,row_number() over(partition by order_id order by id)::integer as sequence
  from performance_events
)
update performance_events event set order_sequence=numbered.sequence
from numbered where numbered.id=event.id;

alter table performance_events alter column occurred_at set default now();
alter table performance_events alter column occurred_at set not null;
alter table performance_events alter column order_sequence set not null;
alter table performance_events add constraint performance_events_order_sequence_unique unique(order_id,order_sequence);
create unique index performance_events_idempotency_uidx on performance_events(order_id,idempotency_key) where idempotency_key is not null;

create or replace function assign_performance_event_sequence()
returns trigger language plpgsql as $$
begin
  if new.order_sequence is null then
    select coalesce(max(event.order_sequence),0)+1 into new.order_sequence
    from performance_events event where event.order_id=new.order_id;
  end if;
  return new;
end;
$$;

create trigger performance_events_assign_sequence
before insert on performance_events
for each row execute function assign_performance_event_sequence();

alter table performance_orders drop constraint performance_orders_lifecycle_state_check;
alter table performance_orders add constraint performance_orders_lifecycle_state_check
  check(lifecycle_state in ('draft','active','paused','zero','historical_review_required'));

alter table performance_events drop constraint performance_events_event_type_check;
alter table performance_events add constraint performance_events_event_type_check
  check(event_type in ('initial','revenue_change','pause','restart','first_include','legacy_adjustment','historical_review_resolution'));

with legacy_projection as (
  select order_id,count(*) as event_count,sum(delta_amount) as total
  from performance_events where event_type='legacy_adjustment' group by order_id
)
update performance_orders order_row set
  lifecycle_state=case when projection.total>0 then 'active' when projection.event_count=1 and projection.total=0 then 'zero' else 'historical_review_required' end,
  current_revenue=case when projection.total>0 then projection.total else 0 end,
  counted_amount=projection.total
from legacy_projection projection where projection.order_id=order_row.id;

alter table performance_events enable trigger performance_events_immutable_update;
