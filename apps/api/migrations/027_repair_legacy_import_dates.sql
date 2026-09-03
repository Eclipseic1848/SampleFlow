create table legacy_event_date_repair_evidence (
  event_id bigint primary key references performance_events(id),
  source_file_sha256 text not null,
  source_sheet text not null,
  source_row_number bigint not null,
  previous_occurred_on date not null,
  corrected_occurred_on date not null,
  previous_accounting_month date not null,
  corrected_accounting_month date not null,
  previous_reason text not null,
  corrected_reason text not null,
  repaired_at timestamptz not null default now(),
  check(corrected_occurred_on=previous_occurred_on+1),
  check(corrected_accounting_month=date_trunc('month',corrected_occurred_on)::date),
  check(corrected_reason=case when previous_reason='历史明细迁移' then '' else previous_reason end),
  unique(source_file_sha256,source_sheet,source_row_number)
);

create table legacy_order_date_repair_evidence (
  order_id bigint primary key references performance_orders(id),
  source_file_sha256 text not null,
  previous_source_received_on date not null,
  corrected_source_received_on date not null,
  repaired_at timestamptz not null default now(),
  check(corrected_source_received_on=previous_source_received_on+1)
);

create trigger legacy_event_date_repair_evidence_immutable_update
before update on legacy_event_date_repair_evidence
for each row execute function reject_import_batch_row_mutation();

create trigger legacy_event_date_repair_evidence_immutable_delete
before delete on legacy_event_date_repair_evidence
for each row execute function reject_import_batch_row_mutation();

create trigger legacy_order_date_repair_evidence_immutable_update
before update on legacy_order_date_repair_evidence
for each row execute function reject_import_batch_row_mutation();

create trigger legacy_order_date_repair_evidence_immutable_delete
before delete on legacy_order_date_repair_evidence
for each row execute function reject_import_batch_row_mutation();

do $$
declare
  source_hash constant text := '926aad3d8c59cc356094eb1abc0ca1fcb3392eae5867f2b7c0e2bb50bb5c01cf';
  event_count bigint;
  order_count bigint;
  total_amount numeric(14,2);
  first_date date;
  last_date date;
  legacy_default_reason_count bigint;
  reviewed_row_count bigint;
begin
  select count(*),count(distinct event.order_id),coalesce(sum(event.delta_amount),0),
         min(event.occurred_on),max(event.occurred_on),
         count(*) filter(where event.reason='历史明细迁移')
    into event_count,order_count,total_amount,first_date,last_date,legacy_default_reason_count
  from legacy_event_source_evidence evidence
  join performance_events event on event.id=evidence.event_id
  where evidence.source_file_sha256=source_hash;

  if event_count=0 then return; end if;
  if event_count<>4701 or order_count<>2850 or total_amount<>14675659.07
     or first_date<>date '2026-01-03' or last_date<>date '2026-08-25'
     or legacy_default_reason_count<>2711 then
    raise exception '旧历史日期修复基线不一致，拒绝自动修复';
  end if;
  if exists(
    with expected(period_month,event_count,total_amount) as (values
      (date '2026-01-01',635::bigint,2314819.55::numeric),
      (date '2026-02-01',455::bigint,1252546.10::numeric),
      (date '2026-03-01',560::bigint,1346159.95::numeric),
      (date '2026-04-01',520::bigint,1989517.64::numeric),
      (date '2026-05-01',474::bigint,1499121.10::numeric),
      (date '2026-06-01',631::bigint,2234990.59::numeric),
      (date '2026-07-01',778::bigint,2487624.14::numeric),
      (date '2026-08-01',648::bigint,1550880.00::numeric)
    ), actual as (
      select date_trunc('month',event.occurred_on+1)::date period_month,
             count(*)::bigint event_count,sum(event.delta_amount)::numeric total_amount
      from legacy_event_source_evidence evidence
      join performance_events event on event.id=evidence.event_id
      where evidence.source_file_sha256=source_hash
      group by date_trunc('month',event.occurred_on+1)::date
    )
    select 1 from expected full join actual using(period_month)
    where expected.event_count is distinct from actual.event_count
       or expected.total_amount is distinct from actual.total_amount
  ) then
    raise exception '旧历史日期修复逐月基线不一致，拒绝自动修复';
  end if;
  select count(*) into reviewed_row_count
  from legacy_event_source_evidence evidence
  join performance_events event on event.id=evidence.event_id
  join legacy_event_analysis_dimension_backfills receipt
    on receipt.event_id=event.id and receipt.source_file_sha256=source_hash and receipt.result='applied'
  join import_batches batch
    on batch.id=receipt.batch_id and batch.source_sha256=source_hash
   and batch.purpose='dimension_backfill' and batch.status='imported'
  join import_batch_rows source_row
    on source_row.id=receipt.batch_row_id and source_row.batch_id=receipt.batch_id
   and source_row.source_sheet=evidence.source_sheet
   and source_row.source_row_number=evidence.source_row_number
  where evidence.source_file_sha256=source_hash
    and (source_row.normalized_data->>'occurredOn')::date=event.occurred_on+1
    and coalesce(source_row.normalized_data->>'reason','')=
        case when event.reason='历史明细迁移' then '' else event.reason end;
  if reviewed_row_count<>event_count then
    raise exception '旧历史日期修复缺少逐行已审核来源证据，拒绝自动修复';
  end if;
  if exists(select 1 from accounting_period_closures)
     or exists(select 1 from accounting_periods where status='closed') then
    raise exception '旧历史日期修复前已有关闭期间，必须另行走更正治理';
  end if;
  if exists(
    select 1
    from performance_events later
    where later.event_type<>'legacy_adjustment'
      and later.order_id in (
        select event.order_id
        from legacy_event_source_evidence evidence
        join performance_events event on event.id=evidence.event_id
        where evidence.source_file_sha256=source_hash
      )
  ) then
    raise exception '旧历史订单已有后续业务事件，拒绝自动修复日期';
  end if;
end;
$$;

insert into legacy_event_date_repair_evidence(
  event_id,source_file_sha256,source_sheet,source_row_number,
  previous_occurred_on,corrected_occurred_on,previous_accounting_month,corrected_accounting_month,
  previous_reason,corrected_reason
)
select event.id,evidence.source_file_sha256,evidence.source_sheet,evidence.source_row_number,
       event.occurred_on,event.occurred_on+1,event.accounting_month,date_trunc('month',event.occurred_on+1)::date,
       event.reason,case when event.reason='历史明细迁移' then '' else event.reason end
from legacy_event_source_evidence evidence
join performance_events event on event.id=evidence.event_id
where evidence.source_file_sha256='926aad3d8c59cc356094eb1abc0ca1fcb3392eae5867f2b7c0e2bb50bb5c01cf';

insert into legacy_order_date_repair_evidence(
  order_id,source_file_sha256,previous_source_received_on,corrected_source_received_on
)
select distinct orders.id,evidence.source_file_sha256,orders.source_received_on,orders.source_received_on+1
from legacy_event_source_evidence evidence
join performance_events event on event.id=evidence.event_id
join performance_orders orders on orders.id=event.order_id
where evidence.source_file_sha256='926aad3d8c59cc356094eb1abc0ca1fcb3392eae5867f2b7c0e2bb50bb5c01cf';

alter table performance_events disable trigger performance_events_immutable_update;

update performance_events event set
  occurred_on=evidence.corrected_occurred_on,
  accounting_month=evidence.corrected_accounting_month,
  reason=evidence.corrected_reason
from legacy_event_date_repair_evidence evidence
where evidence.event_id=event.id;

alter table performance_events enable trigger performance_events_immutable_update;

update performance_orders orders set source_received_on=evidence.corrected_source_received_on
from legacy_order_date_repair_evidence evidence
where evidence.order_id=orders.id;
