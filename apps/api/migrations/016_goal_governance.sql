alter table goals add column org_unit_id bigint references org_units(id);
alter table goals drop constraint goals_period_month_goal_level_owner_user_id_key;
create unique index goals_period_level_owner_scope_uidx
on goals(period_month,goal_level,owner_person_id,coalesce(org_unit_id,0));

alter table goal_versions
  add column created_by_person_id bigint references people(id),
  add column signed_by_person_id bigint references people(id);
update goal_versions version_row set created_by_person_id=person.id
from people person where person.user_id=version_row.created_by;
update goal_versions version_row set signed_by_person_id=person.id
from people person where person.user_id=version_row.signed_by;
alter table goal_versions alter column created_by_person_id set not null;

alter table goal_approvals add column decided_by_person_id bigint references people(id);
update goal_approvals approval set decided_by_person_id=person.id
from people person where person.user_id=approval.decided_by;
alter table goal_approvals alter column decided_by_person_id set not null;

alter table goal_change_requests
  add column requested_by_person_id bigint references people(id),
  add column handled_by_person_id bigint references people(id),
  add column requested_against_version_id bigint references goal_versions(id),
  add column outcome_comment text,
  add column created_version_id bigint references goal_versions(id),
  add column withdrawn_at timestamptz,
  add column invalidated_at timestamptz;
update goal_change_requests request_row set requested_by_person_id=person.id
from people person where person.user_id=request_row.requested_by;
update goal_change_requests request_row
set requested_against_version_id=(
  select id from goal_versions
  where goal_id=request_row.goal_id
  order by version_no desc limit 1
);
update goal_change_requests request_row set handled_by_person_id=person.id
from people person where person.user_id=request_row.handled_by;
alter table goal_change_requests alter column requested_by_person_id set not null;
alter table goal_change_requests alter column requested_against_version_id set not null;
alter table goal_change_requests drop constraint goal_change_requests_status_check;
alter table goal_change_requests add constraint goal_change_requests_status_check
  check(status in ('pending','accepted','rejected','withdrawn','invalidated','completed'));
create unique index goal_change_requests_one_live_uidx
on goal_change_requests(goal_id) where status in ('pending','accepted');

alter table goal_linkage_decisions alter column decision drop not null;
alter table goal_linkage_decisions alter column decided_by drop not null;
alter table goal_linkage_decisions alter column decided_at drop not null;
alter table goal_linkage_decisions
  add column status text not null default 'pending' check(status in ('pending','completed')),
  add column decided_by_person_id bigint references people(id),
  add column generated_change_request_id bigint references goal_change_requests(id),
  add column reason text;
update goal_linkage_decisions linkage set decided_by_person_id=person.id,status='completed'
from people person where person.user_id=linkage.decided_by;

create index goal_linkage_decisions_parent_status_idx
on goal_linkage_decisions(parent_goal_id,status,decided_at desc);
