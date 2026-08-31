import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { applyOrganizationImport, OrganizationImportError, type OrganizationImportInput } from "./services/organization-import.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Client,Pool } = pg;

function input(mappingSha256="mapping-a"):OrganizationImportInput {
  return {
    sourceFile:"fixture.xlsx",sourceSha256:"source-a",mappingFile:"mapping.json",mappingSha256,
    expectedBaseline:{identities:3,historicalPeople:2,historicalGroups:2,departments:2},
    organizationRows:[
      { personName:"导入甲",departmentName:"一部",groupName:"一组" },
      { personName:"导入乙",departmentName:"二部",groupName:"二组" },
      { personName:"仅身份人员",departmentName:"一部",groupName:"待确认" },
    ],
    ledgerRows:[
      { personName:"导入甲",departmentName:"一部",groupName:"一组",occurredOn:"2026-01-02",amount:100 },
      { personName:"导入乙",departmentName:"二部",groupName:"二组",occurredOn:"2026-01-03",amount:-20 },
    ],
    mapping:{
      source:"人事确认单",confirmedBy:"人事负责人",confirmedAt:"2026-08-27",
      groupLeaders:[
        { departmentName:"一部",groupName:"一组",personName:"导入甲",effectiveFrom:mappingSha256==="mapping-b"?"2026-01-02":"2026-01-01" },
        { departmentName:"二部",groupName:"二组",personName:"导入乙",effectiveFrom:"2026-01-01" },
      ],
      departmentSupervisors:[
        { departmentName:"一部",personName:"导入甲",effectiveFrom:"2026-01-01" },
        { departmentName:"二部",personName:"导入乙",effectiveFrom:"2026-01-01" },
      ],
    },
  };
}

test("组织初始化可重放，保留金额并拒绝同来源替换映射", async () => {
  await withMigratedTestDatabase(async (database) => {
    const client = new Client({ connectionString:database.url });
    await client.connect();
    try {
      for (const [index,row] of ([
        ["导入甲","一部","一组",100],
        ["导入乙","二部","二组",-20],
      ] as const).entries()) {
        const order = await client.query<{id:string}>(
          `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,source_received_on,
             original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
           values($1,'客户','单位',$2,$3,100,100,$4,'active',now()) returning id::text`,
          [`IMPORT-${index+1}`,row[0],`2026-01-0${index+2}`,row[3]],
        );
        await client.query(
          `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
             accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,source_row_number)
           values($1,'legacy_adjustment',$2,100,$2,'2026-01-01',$3,'历史导入',$4,$5,$6,$7)`,
          [order.rows[0]!.id,row[3],`2026-01-0${index+2}`,row[0],row[1],row[2],index+2],
        );
      }
    } finally {
      await client.end();
    }

    const tracking=new Client({connectionString:database.url});
    await tracking.connect();
    await tracking.query(
      `insert into legacy_import_runs(source_file,source_sha256,source_rows,imported_orders,imported_events)
       values('fixture.xlsx','source-a',2,2,2)`,
    );
    await tracking.end();

    const pool = new Pool({ connectionString:database.url });
    try {
      await assert.rejects(
        applyOrganizationImport(pool,{...input(),sourceSha256:"wrong-source"}),
        (error:unknown)=>error instanceof OrganizationImportError&&/无法与唯一既有历史账本绑定/.test(error.message),
      );
      const first = await applyOrganizationImport(pool,input());
      assert.equal(first.skipped,false);
      assert.equal(first.importedIdentities,3);
      assert.equal(first.importedMemberships,2);
      assert.equal(first.importedResponsibilities,4);
      assert.equal(first.backfilledOrders,2);
      assert.equal(first.backfilledEvents,2);
      assert.equal(first.eventAmountBefore,"80.00");
      assert.equal(first.eventAmountAfter,"80.00");
      assert.equal(first.identityAccountStatuses.length,3);
      assert.ok(first.identityAccountStatuses.every((person)=>person.status==="unbound"));

      const replay = await applyOrganizationImport(pool,input());
      assert.equal(replay.skipped,true);
      const counts = await pool.query<{people:string;memberships:string;events:string}>(
        `select (select count(*) from people)::text as people,
                (select count(*) from org_memberships)::text as memberships,
                (select count(*) from performance_events where salesperson_person_id is not null)::text as events`,
      );
      assert.deepEqual(counts.rows[0],{ people:"3",memberships:"2",events:"2" });

      await assert.rejects(
        applyOrganizationImport(pool,input("mapping-b")),
        (error:unknown) => error instanceof OrganizationImportError && /不同负责人映射/.test(error.message)
          && Boolean(error.report.mappingDifferences?.some((difference)=>difference.includes("小组负责人变更"))),
      );
      await assert.rejects(
        pool.query("update performance_events set delta_amount=999 where source_row_number=2"),
        /已入账业绩事件不可更新或删除/,
      );

      await pool.query(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,source_row_number)
         select order_id,event_type,0,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,
           reason,salesperson_name,department_name,group_name,99
         from performance_events where source_row_number=2`,
      );
      const resolved=await pool.query<{salesperson_person_id:string;department_unit_id:string;group_unit_id:string;leader_person_id:string;supervisor_person_id:string;leader_name:string;supervisor_name:string}>(
        `select salesperson_person_id::text,department_unit_id::text,group_unit_id::text,leader_person_id::text,
                supervisor_person_id::text,leader_name,supervisor_name
         from performance_events where source_row_number=2`,
      );
      for(const [setting,claimedSource] of [["sampleflow.allow_event_identity_backfill","on"],["sampleflow.event_identity_backfill_source_sha256","source-a"]] as const){
        const client=await pool.connect();
        try{
          await client.query("begin");
          await client.query("select set_config($1,$2,true)",[setting,claimedSource]);
          await assert.rejects(
            client.query(
              `update performance_events set salesperson_person_id=$1,department_unit_id=$2,group_unit_id=$3,
                 leader_person_id=$4,supervisor_person_id=$5,leader_name=$6,supervisor_name=$7
               where source_row_number=99`,
              Object.values(resolved.rows[0]!),
            ),
            /已入账业绩事件不可更新或删除/,
          );
          await client.query("rollback");
        }finally{client.release();}
      }
    } finally {
      await pool.end();
    }
  });
});

test("组织回填允许历史订单更换业务员并以最后一条作为当前业务员", async () => {
  await withMigratedTestDatabase(async (database) => {
    const pool = new Pool({ connectionString:database.url });
    try {
      const order = await pool.query<{id:string}>(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,source_received_on,
           original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('TRANSFER-1','客户','单位','导入甲','2026-01-02',100,80,80,'active',now()) returning id::text`,
      );
      await pool.query(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,source_row_number)
         values($1,'legacy_adjustment',100,100,100,'2026-01-01','2026-01-02','历史导入','导入甲','一部','一组',2),
               ($1,'legacy_adjustment',-20,80,80,'2026-01-01','2026-01-03','历史调整','导入乙','二部','二组',3)`,
        [order.rows[0]!.id],
      );
      await pool.query(
        `insert into legacy_import_runs(source_file,source_sha256,source_rows,imported_orders,imported_events)
         values('fixture.xlsx','source-a',2,1,2)`,
      );

      const report = await applyOrganizationImport(pool,input());
      assert.equal(report.backfilledOrders,1);
      assert.equal(report.backfilledEvents,2);
      const current = await pool.query<{ salesperson_name:string; person_name:string }>(
        `select performance_order.salesperson_name,person.display_name person_name
         from performance_orders performance_order join people person on person.id=performance_order.salesperson_person_id
         where performance_order.id=$1`,
        [order.rows[0]!.id],
      );
      assert.deepEqual(current.rows[0],{ salesperson_name:"导入乙",person_name:"导入乙" });
      const events = await pool.query<{source_row_number:number;person_name:string;department_name:string;group_name:string}>(
        `select event.source_row_number::int,person.display_name person_name,department.name department_name,work_group.name group_name
         from performance_events event join people person on person.id=event.salesperson_person_id
         join org_units department on department.id=event.department_unit_id
         join org_units work_group on work_group.id=event.group_unit_id
         where event.order_id=$1 order by event.source_row_number`,
        [order.rows[0]!.id],
      );
      assert.deepEqual(events.rows,[
        { source_row_number:2,person_name:"导入甲",department_name:"一部",group_name:"一组" },
        { source_row_number:3,person_name:"导入乙",department_name:"二部",group_name:"二组" },
      ]);
    } finally {
      await pool.end();
    }
  });
});
