create table import_configs (
  id bigint generated always as identity primary key,
  config_key text not null,
  version integer not null check(version>0),
  name text not null,
  status text not null check(status in ('draft','approved','retired')),
  sheet_name text not null,
  expected_headers jsonb not null,
  column_mapping jsonb not null,
  required_columns jsonb not null default '[]'::jsonb,
  allowed_event_types jsonb not null default '["initial"]'::jsonb,
  business_region_mapping jsonb not null default '{}'::jsonb,
  person_mapping jsonb not null default '{}'::jsonb,
  fixed_event_type text check(fixed_event_type='legacy_adjustment'),
  allow_legacy_source_key boolean not null default false,
  created_by bigint references users(id),
  approved_by bigint references users(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique(config_key,version),
  constraint import_configs_approval_check check(
    status<>'approved' or (
      approved_at is not null and (
        (created_by is null and approved_by is null)
        or (approved_by is not null and approved_by is distinct from created_by)
      )
    )
  ),
  constraint import_configs_legacy_mode_check check(
    (allow_legacy_source_key and fixed_event_type='legacy_adjustment')
    or (not allow_legacy_source_key and fixed_event_type is null)
  )
);

insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,required_columns,business_region_mapping,person_mapping,fixed_event_type,allow_legacy_source_key)
values(
  'standard-performance',1,'标准业绩模板 v1','draft','业绩导入',
  '["来源记录标识","轻流订单编号","发生日期","客户姓名","客户单位","业务区域","业务员来源标识","服务类型","事件类型","金额","原因"]'::jsonb,
  '{"sourceRecordId":"来源记录标识","orderNo":"轻流订单编号","occurredOn":"发生日期","customerName":"客户姓名","customerUnit":"客户单位","businessRegionSourceText":"业务区域","salespersonSourceKey":"业务员来源标识","serviceType":"服务类型","eventType":"事件类型","amount":"金额","reason":"原因"}'::jsonb,
  '["sourceRecordId","orderNo","occurredOn","customerName","customerUnit","businessRegionSourceText","salespersonSourceKey","eventType","amount","reason"]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  null,
  false
);

create table import_batches (
  id bigint generated always as identity primary key,
  config_id bigint not null references import_configs(id),
  source_file_name text not null,
  source_sha256 text not null,
  source_bytes bytea not null,
  status text not null check(status in ('preflight_ready','blocked','imported','failed')),
  uploaded_by bigint not null references users(id),
  confirmed_by bigint references users(id),
  row_count integer not null check(row_count>=0),
  order_count integer not null check(order_count>=0),
  event_count integer not null check(event_count>=0),
  reconciliation_count integer not null default 0 check(reconciliation_count>=0),
  total_amount numeric(14,2) not null,
  warning_count integer not null default 0 check(warning_count>=0),
  blocking_count integer not null default 0 check(blocking_count>=0),
  anomalies jsonb not null default '[]'::jsonb,
  uploaded_at timestamptz not null default now(),
  preflighted_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index import_batches_hash_idx on import_batches(source_sha256,config_id);

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

create trigger import_configs_protect_used_definition
before update on import_configs
for each row execute function protect_used_import_config_definition();

create table import_batch_rows (
  id bigint generated always as identity primary key,
  batch_id bigint not null references import_batches(id) on delete cascade,
  source_sheet text not null,
  source_row_number integer not null check(source_row_number>1),
  source_key text not null,
  duplicate_fingerprint text not null,
  normalized_data jsonb not null,
  issues jsonb not null default '[]'::jsonb,
  unique(batch_id,source_sheet,source_row_number)
);

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
     or old.uploaded_by is distinct from new.uploaded_by
     or old.uploaded_at is distinct from new.uploaded_at
     or old.preflighted_at is distinct from new.preflighted_at then
    raise exception '导入来源证据不可修改';
  end if;
  return new;
end;
$$;

create trigger import_batches_protect_source_update
before update on import_batches
for each row execute function protect_import_batch_source_evidence();

create trigger import_batches_protect_source_delete
before delete on import_batches
for each row execute function protect_import_batch_source_evidence();

create or replace function reject_import_batch_row_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '导入批次行证据不可更新或删除';
end;
$$;

create trigger import_batch_rows_immutable_update
before update on import_batch_rows
for each row execute function reject_import_batch_row_mutation();

create trigger import_batch_rows_immutable_delete
before delete on import_batch_rows
for each row execute function reject_import_batch_row_mutation();

create table legacy_event_import_reconciliations (
  id bigint generated always as identity primary key,
  event_id bigint not null unique references performance_events(id),
  batch_id bigint not null references import_batches(id),
  batch_row_id bigint not null unique references import_batch_rows(id),
  reconciled_by bigint not null references users(id),
  reconciled_at timestamptz not null default now(),
  source_operator_status text not null check(source_operator_status='unknown')
);

create trigger legacy_event_reconciliations_immutable_update
before update on legacy_event_import_reconciliations
for each row execute function reject_import_batch_row_mutation();

create trigger legacy_event_reconciliations_immutable_delete
before delete on legacy_event_import_reconciliations
for each row execute function reject_import_batch_row_mutation();

alter table performance_orders
  add column business_region_source_text text,
  add column business_region_code text;

do $$
begin
  if exists(
    select 1 from performance_orders
    group by regexp_replace(lower(normalize(qingflow_order_no,NFKC)),'[[:space:]]+','','g')
    having count(*)>1
  ) then
    raise exception '现有订单存在仅大小写、空格或全半角不同的疑似重复编号';
  end if;
end;
$$;
create unique index performance_orders_order_no_comparable_uidx
  on performance_orders((regexp_replace(lower(normalize(qingflow_order_no,NFKC)),'[[:space:]]+','','g')));

drop index performance_events_source_row_uidx;
alter table performance_events
  add column import_batch_id bigint references import_batches(id),
  add column source_file_sha256 text,
  add column source_sheet text,
  add column source_record_id text,
  add column source_key text,
  add column source_business_sequence integer check(source_business_sequence>0);

create table legacy_event_source_evidence (
  event_id bigint primary key references performance_events(id),
  source_file_sha256 text not null,
  source_sheet text not null,
  source_row_number bigint not null,
  source_key text not null unique
);

insert into legacy_event_source_evidence(event_id,source_file_sha256,source_sheet,source_row_number,source_key)
select event.id,run.source_sha256,'分子',event.source_row_number,
       'legacy:'||run.source_sha256||':分子:'||event.source_row_number::text
from performance_events event
cross join legacy_import_runs run
where event.source_row_number is not null
  and (select count(*) from legacy_import_runs)=1
  and event.source_row_number between 2 and run.source_rows+1;

create trigger legacy_event_source_evidence_immutable_update
before update on legacy_event_source_evidence
for each row execute function reject_import_batch_row_mutation();

create trigger legacy_event_source_evidence_immutable_delete
before delete on legacy_event_source_evidence
for each row execute function reject_import_batch_row_mutation();

do $$
begin
  if exists(
    select 1 from performance_events event
    where event.source_row_number is not null
      and not exists(select 1 from legacy_event_source_evidence evidence where evidence.event_id=event.id)
  ) then
    raise exception '旧历史事件无法唯一关联来源文件，拒绝删除旧幂等约束';
  end if;
end;
$$;
create unique index performance_events_source_key_uidx
  on performance_events(source_key) where source_key is not null;
create index performance_events_import_batch_idx
  on performance_events(import_batch_id) where import_batch_id is not null;
