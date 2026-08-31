create table performance_event_analysis_dimensions (
  event_id bigint primary key references performance_events(id),
  business_region_code text not null check (business_region_code <> ''),
  business_region_source_text text not null check (business_region_source_text <> ''),
  customer_unit text not null check (customer_unit <> '')
);

create or replace function reject_performance_event_analysis_dimension_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '业绩分析维度快照不可更新或删除';
end;
$$;

create trigger performance_event_analysis_dimensions_immutable_update
before update on performance_event_analysis_dimensions
for each row execute function reject_performance_event_analysis_dimension_mutation();

create trigger performance_event_analysis_dimensions_immutable_delete
before delete on performance_event_analysis_dimensions
for each row execute function reject_performance_event_analysis_dimension_mutation();

alter table accounting_correction_requests
  add column analysis_dimensions_required boolean not null default false,
  add column business_region_code text,
  add column business_region_source_text text,
  add column customer_unit text,
  add column analysis_dimension_evidence text,
  add constraint accounting_correction_analysis_dimensions_required check (
    not analysis_dimensions_required or (
      business_region_code is not null and business_region_code <> '' and
      business_region_source_text is not null and business_region_source_text <> '' and
      customer_unit is not null and customer_unit <> '' and
      analysis_dimension_evidence is not null and analysis_dimension_evidence <> ''
    )
  ) not valid;

alter table accounting_correction_requests
  alter column analysis_dimensions_required set default true;

create or replace function require_performance_event_analysis_dimensions()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from performance_event_analysis_dimensions dimensions where dimensions.event_id=new.id
  ) then
    raise exception '新业绩事件必须在同一事务写入分析维度快照';
  end if;
  return null;
end;
$$;

create constraint trigger performance_events_require_analysis_dimensions
after insert on performance_events
deferrable initially deferred
for each row
execute function require_performance_event_analysis_dimensions();
