alter table import_batches
  add column purpose text not null default 'ledger_import'
  check (purpose in ('ledger_import','dimension_backfill'));

alter table import_batches
  add constraint import_batches_id_source_sha256_key unique(id,source_sha256);

alter table import_batch_rows
  add constraint import_batch_rows_id_batch_id_key unique(id,batch_id);

create or replace function protect_import_batch_source_evidence()
returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception '导入来源证据不可删除';
  end if;
  if old.config_id is distinct from new.config_id
     or old.source_file_name is distinct from new.source_file_name
     or old.source_sha256 is distinct from new.source_sha256
     or old.source_bytes is distinct from new.source_bytes
     or old.purpose is distinct from new.purpose
     or old.uploaded_by is distinct from new.uploaded_by
     or old.uploaded_at is distinct from new.uploaded_at
     or old.preflighted_at is distinct from new.preflighted_at then
    raise exception '导入来源证据不可修改';
  end if;
  return new;
end;
$$;

create table legacy_event_analysis_dimension_backfills (
  event_id bigint primary key references performance_event_analysis_dimensions(event_id),
  batch_id bigint not null,
  batch_row_id bigint not null unique,
  source_file_sha256 text not null,
  confirmed_by bigint not null references users(id),
  confirmed_at timestamptz not null default now(),
  result text not null check (result='applied'),
  foreign key(batch_id,source_file_sha256) references import_batches(id,source_sha256),
  foreign key(batch_row_id,batch_id) references import_batch_rows(id,batch_id)
);

create trigger legacy_event_analysis_dimension_backfills_immutable_update
before update on legacy_event_analysis_dimension_backfills
for each row execute function reject_import_batch_row_mutation();

create trigger legacy_event_analysis_dimension_backfills_immutable_delete
before delete on legacy_event_analysis_dimension_backfills
for each row execute function reject_import_batch_row_mutation();
