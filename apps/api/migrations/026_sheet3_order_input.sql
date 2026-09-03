alter table performance_orders drop constraint performance_orders_original_amount_check;
alter table performance_orders drop constraint performance_orders_current_revenue_check;
alter table performance_events drop constraint performance_events_resulting_current_revenue_check;

alter table performance_orders drop constraint performance_orders_lifecycle_state_check;
alter table performance_orders add constraint performance_orders_lifecycle_state_check
  check(lifecycle_state in ('draft','active','paused','zero','receivable_pending','historical_review_required'));

alter table performance_orders drop constraint performance_orders_state_amounts_check;
alter table performance_orders add constraint performance_orders_state_amounts_check check (
  lifecycle_state = 'historical_review_required'
  or (lifecycle_state = 'draft' and current_revenue = 0 and counted_amount = 0)
  or (lifecycle_state = 'active' and current_revenue > 0 and counted_amount > 0)
  or (lifecycle_state = 'paused' and current_revenue > 0 and counted_amount = 0)
  or (lifecycle_state = 'zero' and current_revenue = 0 and counted_amount = 0)
  or (lifecycle_state = 'receivable_pending' and current_revenue < 0 and counted_amount < 0)
);

alter table performance_orders
  add column collaborator_person_id bigint references people(id),
  add column collaborator_name text,
  add column collaboration_ratio numeric(7,6),
  add constraint performance_orders_collaboration_check check (
    (collaborator_person_id is null and collaborator_name is null and collaboration_ratio is null)
    or (collaborator_person_id is not null and collaborator_name is not null and collaborator_name <> ''
        and collaboration_ratio > 0 and collaboration_ratio < 1
        and collaborator_person_id is distinct from salesperson_person_id)
  );

alter table performance_events
  add column service_type text,
  add column collaborator_person_id bigint references people(id),
  add column collaborator_name text,
  add column collaboration_ratio numeric(7,6),
  add column collaborator_department_unit_id bigint references org_units(id),
  add column collaborator_department_name text,
  add column collaborator_group_unit_id bigint references org_units(id),
  add column collaborator_group_name text,
  add column collaborator_leader_person_id bigint references people(id),
  add column collaborator_leader_name text,
  add column collaborator_supervisor_person_id bigint references people(id),
  add column collaborator_supervisor_name text,
  add constraint performance_events_collaboration_check check (
    (collaborator_person_id is null and collaborator_name is null and collaboration_ratio is null
      and collaborator_department_unit_id is null and collaborator_department_name is null
      and collaborator_group_unit_id is null and collaborator_group_name is null
      and collaborator_leader_person_id is null and collaborator_leader_name is null
      and collaborator_supervisor_person_id is null and collaborator_supervisor_name is null)
    or (collaborator_person_id is not null and collaborator_name is not null and collaborator_name <> ''
      and collaboration_ratio > 0 and collaboration_ratio < 1
      and collaborator_person_id is distinct from salesperson_person_id
      and collaborator_department_unit_id is not null and collaborator_department_name is not null
      and collaborator_group_unit_id is not null and collaborator_group_name is not null
      and collaborator_leader_person_id is not null and collaborator_leader_name is not null
      and collaborator_supervisor_person_id is not null and collaborator_supervisor_name is not null)
  );

create index performance_events_collaborator_person_idx
  on performance_events(collaborator_person_id,accounting_month) where collaborator_person_id is not null;
create index performance_events_collaborator_group_idx
  on performance_events(collaborator_group_unit_id,accounting_month) where collaborator_group_unit_id is not null;
create index performance_events_collaborator_department_idx
  on performance_events(collaborator_department_unit_id,accounting_month) where collaborator_department_unit_id is not null;

create view performance_event_attributions as
select event.id as event_id,'primary'::text as attribution_role,
       (event.delta_amount-round(event.delta_amount*coalesce(event.collaboration_ratio,0),2))::numeric(14,2) as attributed_amount,
       event.salesperson_person_id,event.salesperson_name,event.department_unit_id,event.department_name,
       event.group_unit_id,event.group_name,event.leader_person_id,event.leader_name,
       event.supervisor_person_id,event.supervisor_name
from performance_events event
union all
select event.id,'collaborator',round(event.delta_amount*event.collaboration_ratio,2)::numeric(14,2),
       event.collaborator_person_id,event.collaborator_name,event.collaborator_department_unit_id,event.collaborator_department_name,
       event.collaborator_group_unit_id,event.collaborator_group_name,event.collaborator_leader_person_id,event.collaborator_leader_name,
       event.collaborator_supervisor_person_id,event.collaborator_supervisor_name
from performance_events event
where event.collaborator_person_id is not null;

alter table import_configs drop constraint import_configs_fixed_event_type_check;
alter table import_configs add constraint import_configs_fixed_event_type_check
  check(fixed_event_type in ('initial','legacy_adjustment'));
alter table import_configs drop constraint import_configs_legacy_mode_check;
alter table import_configs add constraint import_configs_legacy_mode_check check (
  (allow_legacy_source_key and fixed_event_type='legacy_adjustment')
  or (not allow_legacy_source_key and fixed_event_type is distinct from 'legacy_adjustment')
);

insert into import_configs(
  config_key,version,name,status,sheet_name,expected_headers,column_mapping,required_columns,
  allowed_event_types,business_region_mapping,person_mapping,fixed_event_type,allow_legacy_source_key,approved_at
) values (
  'standard-performance',2,'标准“分子”新订单模板 v2','approved','分子',
  '["收样月份","日期","订单编号（来源于轻流系统）","客户姓名","客户单位","省份","业务员","部门","组别","系统营业额","服务类型","备注",null,"协作人","协作比例"]'::jsonb,
  '{"sourceMonth":"收样月份","occurredOn":"日期","sourceRecordId":"订单编号（来源于轻流系统）","orderNo":"订单编号（来源于轻流系统）","customerName":"客户姓名","customerUnit":"客户单位","businessRegionSourceText":"省份","salespersonSourceKey":"业务员","sourceDepartment":"部门","sourceGroup":"组别","amount":"系统营业额","serviceType":"服务类型","reason":"备注","collaboratorSourceKey":"协作人","collaborationRatio":"协作比例"}'::jsonb,
  '["sourceMonth","occurredOn","orderNo","customerName","customerUnit","businessRegionSourceText","salespersonSourceKey","sourceDepartment","sourceGroup","amount","serviceType"]'::jsonb,
  '["initial"]'::jsonb,
  '{"北京市":"CN-BJ","天津市":"CN-TJ","河北省":"CN-HE","山西省":"CN-SX","内蒙古自治区":"CN-NM","辽宁省":"CN-LN","吉林省":"CN-JL","黑龙江省":"CN-HL","上海市":"CN-SH","江苏省":"CN-JS","浙江省":"CN-ZJ","安徽省":"CN-AH","福建省":"CN-FJ","江西省":"CN-JX","山东省":"CN-SD","河南省":"CN-HA","湖北省":"CN-HB","湖南省":"CN-HN","广东省":"CN-GD","广西壮族自治区":"CN-GX","海南省":"CN-HI","重庆市":"CN-CQ","四川省":"CN-SC","贵州省":"CN-GZ","云南省":"CN-YN","西藏自治区":"CN-XZ","陕西省":"CN-SN","甘肃省":"CN-GS","青海省":"CN-QH","宁夏回族自治区":"CN-NX","新疆维吾尔自治区":"CN-XJ","台湾省":"CN-TW","外贸":"EXT-TRADE"}'::jsonb,
  '{}'::jsonb,'initial',false,now()
);
