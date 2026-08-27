insert into org_units (name, unit_type)
select distinct department_name, 'department'
from performance_events
where btrim(department_name) <> ''
on conflict (name, unit_type) do nothing;

insert into org_units (name, unit_type, parent_id)
select e.group_name, 'group', min(d.id)
from performance_events e
join org_units d on d.name=e.department_name and d.unit_type='department'
where btrim(e.group_name) <> ''
group by e.group_name
on conflict (name, unit_type) do nothing;
