alter table import_configs
  add column expected_reconciliation jsonb;

alter table import_batches
  add column reconciliation_summary jsonb;

update import_batches
set reconciliation_summary=jsonb_build_object(
  'actual',jsonb_build_object(
    'rows',row_count,
    'orders',order_count,
    'events',event_count+reconciliation_count,
    'totalAmount',total_amount,
    'monthly','[]'::jsonb
  ),
  'expected',null,
  'matched',null,
  'legacyBackfill',true
);

alter table import_batches
  alter column reconciliation_summary set not null;

create or replace function protect_used_import_config_definition()
returns trigger language plpgsql as $$
begin
  if exists(select 1 from import_batches where config_id=old.id)
     and (old.name is distinct from new.name
       or old.config_key is distinct from new.config_key
       or old.version is distinct from new.version
       or old.sheet_name is distinct from new.sheet_name
       or old.expected_headers is distinct from new.expected_headers
       or old.column_mapping is distinct from new.column_mapping
       or old.required_columns is distinct from new.required_columns
       or old.allowed_event_types is distinct from new.allowed_event_types
       or old.business_region_mapping is distinct from new.business_region_mapping
       or old.person_mapping is distinct from new.person_mapping
       or old.expected_reconciliation is distinct from new.expected_reconciliation
       or old.fixed_event_type is distinct from new.fixed_event_type
       or old.allow_legacy_source_key is distinct from new.allow_legacy_source_key
       or old.created_by is distinct from new.created_by
       or old.approved_by is distinct from new.approved_by
       or old.approved_at is distinct from new.approved_at) then
    raise exception '已产生导入批次的配置定义不可修改';
  end if;
  return new;
end;
$$;
