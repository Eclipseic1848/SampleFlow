create table organization_import_runs (
  id bigint generated always as identity primary key,
  source_file text not null,
  source_sha256 text not null,
  mapping_file text not null,
  mapping_sha256 text not null,
  report jsonb not null,
  imported_at timestamptz not null default now(),
  unique(source_sha256,mapping_sha256)
);

create or replace function reject_performance_event_mutation()
returns trigger language plpgsql as $$
begin
  if current_setting('sampleflow.allow_event_identity_backfill',true)='on'
     and old.salesperson_person_id is null and new.salesperson_person_id is not null
     and old.department_unit_id is null and new.department_unit_id is not null
     and old.group_unit_id is null and new.group_unit_id is not null
     and old.leader_person_id is null and new.leader_person_id is not null
     and old.supervisor_person_id is null and new.supervisor_person_id is not null
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
