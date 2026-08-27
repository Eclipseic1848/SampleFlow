type Queryable = {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
};

export type OrganizationSnapshot = Readonly<{
  personId: string;
  salespersonName: string;
  departmentId: string;
  departmentName: string;
  groupId: string;
  groupName: string;
  leaderPersonId: string;
  leaderName: string;
  supervisorPersonId: string;
  supervisorName: string;
}>;

export class OrganizationResolutionError extends Error {}

export async function resolveOrganization(
  database: Queryable,
  personId: string,
  occurredOn: string,
): Promise<OrganizationSnapshot> {
  const result = await database.query<{
    person_id: string;
    salesperson_name: string;
    department_id: string;
    department_name: string;
    group_id: string;
    group_name: string;
    leader_person_id: string;
    leader_name: string;
    supervisor_person_id: string;
    supervisor_name: string;
  }>(
    `select p.id::text as person_id,p.display_name as salesperson_name,
            d.id::text as department_id,d.name as department_name,
            g.id::text as group_id,g.name as group_name,
            leader.id::text as leader_person_id,leader.display_name as leader_name,
            supervisor.id::text as supervisor_person_id,supervisor.display_name as supervisor_name
     from people p
     join org_memberships m on m.person_id=p.id
       and m.effective_from<=$2::date and (m.effective_to is null or m.effective_to>=$2::date)
     join org_units d on d.id=m.department_id and d.unit_type='department'
     join org_units g on g.id=m.group_id and g.unit_type='group' and g.parent_id=d.id
     join org_responsibilities lr on lr.org_unit_id=g.id and lr.responsibility_type='leader'
       and lr.effective_from<=$2::date and (lr.effective_to is null or lr.effective_to>=$2::date)
     join people leader on leader.id=lr.person_id
     join org_responsibilities sr on sr.org_unit_id=d.id and sr.responsibility_type='supervisor'
       and sr.effective_from<=$2::date and (sr.effective_to is null or sr.effective_to>=$2::date)
     join people supervisor on supervisor.id=sr.person_id
     where p.id=$1`,
    [personId, occurredOn],
  );
  if (result.rows.length !== 1) throw new OrganizationResolutionError("找不到唯一有效组织任职及负责人");
  const row = result.rows[0]!;
  return {
    personId: row.person_id,
    salespersonName: row.salesperson_name,
    departmentId: row.department_id,
    departmentName: row.department_name,
    groupId: row.group_id,
    groupName: row.group_name,
    leaderPersonId: row.leader_person_id,
    leaderName: row.leader_name,
    supervisorPersonId: row.supervisor_person_id,
    supervisorName: row.supervisor_name,
  };
}
