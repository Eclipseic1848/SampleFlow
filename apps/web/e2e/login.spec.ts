import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parseImportWorkbook, type ImportLayout } from "../../api/src/domain/performance-import-xlsx.js";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;
const importTemplate=fileURLToPath(new URL("../public/SampleFlow标准业绩导入模板.xlsx",import.meta.url));

test("API 返回空 502 时登录页显示服务不可用而不是 JSON 解析错误", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: '{"message":"未登录"}' });
  });
  await page.route("**/api/ready", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 503, contentType: "text/plain", body: "" });
  });
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({ status: 502, contentType: "text/plain", body: "" });
  });

  await page.goto("/");
  await expect(page.getByText("正在检查 API 与数据库")).toBeVisible();
  await expect(page.getByText("API 或数据库暂不可用")).toBeVisible();
  const loginPassword = page.getByLabel("密码", { exact: true });
  await expect(loginPassword).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "显示密码" }).click();
  await expect(loginPassword).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "隐藏密码" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "隐藏密码" }).click();
  await expect(loginPassword).toHaveAttribute("type", "password");
  await loginPassword.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("登录服务暂时不可用，请确认 API 已启动后重试");
  await expect(page.getByRole("alert")).not.toContainText("Unexpected end of JSON input");
});

test("销售助理可通过真实 API 登录", async ({ database, page }) => {
    await seedTestUser(database.url, {
      username: "e2e_sales_assistant",
      displayName: "E2E 销售助理",
      password: "E2ePass@123",
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });

      const guestResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/me"));
      await page.goto("/");
      expect((await guestResponse).status()).toBe(401);
      await expect(page.getByRole("heading", { name: "登录系统" })).toBeVisible();
      await expect(page.getByText("前端、API 与数据库已连接")).toBeVisible();
      await page.getByLabel("账号").fill("e2e_sales_assistant");
      await page.getByLabel("密码", { exact: true }).fill("E2ePass@123");

      const loginResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/auth/login") && response.request().method() === "POST"
      );
      const dashboardResponse = page.waitForResponse((response) =>
        response.url().includes("/api/performance/dashboard")
      );
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();
      expect((await loginResponse).status()).toBe(200);
      expect((await dashboardResponse).status()).toBe(200);
      await expect(page.getByRole("heading", { name: "业绩账本总览" })).toBeVisible();
});

test("销售助理组长可用标准模板预检并确认整批入账", async ({ database, page }) => {
    await seedTestUser(database.url,{username:"e2e_import_leader",displayName:"E2E 导入组长",password:"E2ePass@123",roleCode:"sales_assistant_leader",roleName:"销售助理组长"});
    const hr=await seedTestUser(database.url,{username:"e2e_import_hr",displayName:"E2E 导入人事",password:"E2ePass@123",roleCode:"hr",roleName:"人事部"});
    const client=new Client({connectionString:database.url});await client.connect();
    try{
      const people=await client.query<{id:string;display_name:string}>("insert into people(display_name,identity_source,source_key) values('示例业务员','e2e','person:example'),('示例组长','e2e','leader:example'),('示例主管','e2e','supervisor:example') returning id::text,display_name");
      const personId=(name:string)=>people.rows.find((item)=>item.display_name===name)!.id;
      const department=await client.query<{id:string}>("insert into org_units(name,unit_type) values('E2E 销售部','department') returning id::text");
      const group=await client.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('E2E 销售组','group',$1) returning id::text",[department.rows[0]!.id]);
      await client.query("insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$2,'leader','2026-01-01'),($3,$4,'supervisor','2026-01-01')",[personId("示例组长"),group.rows[0]!.id,personId("示例主管"),department.rows[0]!.id]);
      await client.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[personId("示例业务员"),department.rows[0]!.id,group.rows[0]!.id]);
      await client.query("update import_configs set status='approved',business_region_mapping='{\"外贸\":\"EXT-TRADE\"}',approved_by=$1,approved_at=now() where config_key='standard-performance'",[hr]);
    }finally{await client.end();}
      await page.setViewportSize({width:390,height:844});
      await page.goto("/");await page.getByLabel("账号").fill("e2e_import_leader");await page.getByLabel("密码",{exact:true}).fill("E2ePass@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();await page.getByRole("button",{name:"Excel 导入"}).click();
      await expect(page.getByRole("link",{name:"下载标准业绩模板"})).toHaveAttribute("href","/SampleFlow标准业绩导入模板.xlsx");
      await page.locator('input[type="file"]').setInputFiles(importTemplate);await page.getByRole("button",{name:"运行只读预检"}).click();
      await expect(page.getByRole("heading",{name:"预检通过，等待确认"})).toBeVisible();
      await expect(page.getByRole("heading",{name:"逐月对账"})).toBeVisible();
      await expect(page.getByRole("row",{name:/2026-03.*1.*100\.00/})).toBeVisible();
      await page.getByRole("button",{name:"确认整批入账"}).click();
      await expect(page.getByRole("heading",{name:"Excel 批量导入"})).toBeHidden();await expect(page.getByText("001-A",{exact:true})).toBeVisible();
});

test("销售助理组长可在桌面端预检并确认合成历史分析维度补齐", async ({ database, page }) => {
    await seedTestUser(database.url,{username:"e2e_backfill_leader",displayName:"E2E 补齐组长",password:"E2ePass@123",roleCode:"sales_assistant_leader",roleName:"销售助理组长"});
    const sourceBytes=await readFile(importTemplate);const sourceHash=createHash("sha256").update(sourceBytes).digest("hex");
    const client=new Client({connectionString:database.url});await client.connect();
    try{
      const standard=await client.query<{sheet_name:string;expected_headers:unknown[];column_mapping:ImportLayout["columnMapping"]}>("select sheet_name,expected_headers,column_mapping from import_configs where config_key='standard-performance'");
      const columnMapping={...standard.rows[0]!.column_mapping};delete columnMapping.sourceRecordId;delete columnMapping.eventType;
      const parsed=await parseImportWorkbook("SampleFlow标准业绩导入模板.xlsx",sourceBytes,{sheetName:standard.rows[0]!.sheet_name,expectedHeaders:standard.rows[0]!.expected_headers,columnMapping,personMapping:{},fixedEventType:"legacy_adjustment"});
      const source=parsed[0]!;
      const salesperson=await client.query<{id:string}>("insert into people(display_name,identity_source,source_key) values('补齐示例业务员','e2e',$1) returning id::text",[source.salespersonSourceKey]);
      const order=await client.query<{id:string}>(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,service_type,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,salesperson_person_id,posted_at)
         values($1,$2,'旧单位','补齐示例业务员','旧服务',$3,$4,$4,$4,'active',$5,now()) returning id::text`,
        [source.orderNo,source.customerName,source.occurredOn,source.amount,salesperson.rows[0]!.id],
      );
      await client.query("begin");await client.query("set local session_replication_role=replica");
      const event=await client.query<{id:string}>(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,source_row_number,salesperson_person_id,order_sequence)
         values($1,'legacy_adjustment',$2,$2,$2,date_trunc('month',$3::date)::date,$3,$4,'补齐示例业务员','合成销售部','合成销售组',$5,$6,1)
         returning id::text`,
        [order.rows[0]!.id,source.amount,source.occurredOn,source.reason,source.rowNumber,salesperson.rows[0]!.id],
      );
      await client.query(
        `insert into legacy_event_source_evidence(event_id,source_file_sha256,source_sheet,source_row_number,source_key)
         values($1,$2,$3,$4,$5)`,
        [event.rows[0]!.id,sourceHash,source.sheet,source.rowNumber,`legacy:${sourceHash}:${source.sheet}:${source.rowNumber}`],
      );
      await client.query("commit");
      await client.query(
        `insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,allowed_event_types,
           business_region_mapping,fixed_event_type,allow_legacy_source_key,approved_at)
         values('e2e-dimension-backfill',1,'E2E 历史维度补齐','approved',$1,$2::jsonb,$3::jsonb,'["legacy_adjustment"]'::jsonb,
           $4::jsonb,'legacy_adjustment',true,now())`,
        [standard.rows[0]!.sheet_name,JSON.stringify(standard.rows[0]!.expected_headers),JSON.stringify(columnMapping),JSON.stringify({[source.businessRegionSourceText]:"EXT-TRADE"})],
      );
      await page.setViewportSize({width:1280,height:900});await page.goto("/");await page.getByLabel("账号").fill("e2e_backfill_leader");await page.getByLabel("密码",{exact:true}).fill("E2ePass@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();await page.getByRole("button",{name:"Excel 导入"}).click();
      await page.getByLabel("历史分析维度补齐").check();await expect(page.getByText("上传原始受控工作簿",{exact:false})).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles(importTemplate);await page.getByRole("button",{name:"运行只读预检"}).click();
      await expect(page.getByRole("heading",{name:"预检通过，等待确认"})).toBeVisible();await expect(page.getByRole("heading",{name:"来源对账"})).toBeVisible();
      await expect(page.getByRole("row",{name:new RegExp(`${source.rowNumber}.*可补齐.*EXT-TRADE.*${source.customerUnit}`)})).toBeVisible();
      await page.getByRole("button",{name:"确认补齐分析维度"}).click();await expect(page.getByRole("heading",{name:"Excel 批量导入"})).toBeHidden();
      const dimensions=await client.query<{business_region_code:string;business_region_source_text:string;customer_unit:string}>("select business_region_code,business_region_source_text,customer_unit from performance_event_analysis_dimensions where event_id=$1",[event.rows[0]!.id]);
      expect(dimensions.rows[0]).toEqual({business_region_code:"EXT-TRADE",business_region_source_text:source.businessRegionSourceText,customer_unit:source.customerUnit});
    }finally{await client.query("rollback").catch(()=>{});await client.end();}
});

test("订单台账以前后游标稳定浏览并在刷新后开启新快照", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_cursor_assistant",
    displayName: "E2E 游标销售助理",
    password: "Cursor@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });
  const setup = new Client({ connectionString: database.url });
  await setup.connect();
  const person = await setup.query<{ id: string }>("select id::text from people where user_id=$1", [userId]);
  async function insertRows(prefix: string, count: number) {
    await setup.query(
      `with orders as (
         insert into performance_orders
           (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
            source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,created_at,posted_at)
         select $1||lpad(series::text,4,'0'),'E2E游标客户'||lpad(series::text,4,'0'),
                'E2E游标单位'||lpad(series::text,4,'0'),$3,'E2E 游标业务员','2026-08-31',1,1,1,'active',$4,$4
         from generate_series(1,$2::integer) series returning id
       )
       insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
          accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,department_name,group_name)
       select id,'initial',1,1,1,'2026-08-01','2026-08-31','浏览器游标回归',$3,'E2E 游标业务员','E2E 部门','E2E 小组'
       from orders`,
      [prefix, count, person.rows[0]!.id, "2026-08-31T12:00:00.000Z"],
    );
  }
  await insertRows("E2E-CURSOR-", 101);

  try {
    await page.goto("/");
    await page.getByLabel("账号").fill("e2e_cursor_assistant");
    await page.getByLabel("密码", { exact: true }).fill("Cursor@123");
    await page.getByRole("button", { name: "进入 SampleFlow" }).click();
    await page.getByRole("button", { name: "订单业绩", exact: true }).click();
    const ledger = page.locator("section.orders-card").filter({ has: page.getByRole("heading", { name: "订单台账" }) });
    await expect(ledger.getByText("本页 50 笔订单", { exact: true })).toBeVisible();
    await expect(ledger.getByText("E2E-CURSOR-0101", { exact: true })).toBeVisible();
    await expect(ledger.getByRole("button", { name: "上一页" })).toBeDisabled();
    await expect(ledger.getByRole("button", { name: "下一页" })).toBeEnabled();

    await insertRows("E2E-CURSOR-NEW-", 1);
    let failNextPage = true;
    await page.route("**/api/performance/orders?cursor=*", async (route) => {
      if (failNextPage) {
        failNextPage = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"分页暂时失败"}' });
        return;
      }
      await route.continue();
    });
    await ledger.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("分页暂时失败", { exact: true })).toBeVisible();
    await ledger.getByRole("button", { name: "下一页" }).click();
    await expect(ledger.getByText("E2E-CURSOR-0051", { exact: true })).toBeVisible();
    await ledger.getByRole("button", { name: "下一页" }).click();
    await expect(ledger.getByText("E2E-CURSOR-0001", { exact: true })).toBeVisible();
    await expect(ledger.getByText("本页 1 笔订单", { exact: true })).toBeVisible();
    await expect(ledger.getByRole("button", { name: "下一页" })).toBeDisabled();
    await ledger.getByRole("button", { name: "上一页" }).click();
    await expect(ledger.getByText("E2E-CURSOR-0051", { exact: true })).toBeVisible();
    await ledger.getByRole("button", { name: "上一页" }).click();
    await expect(ledger.getByText("E2E-CURSOR-0101", { exact: true })).toBeVisible();
    await expect(ledger.getByText("E2E-CURSOR-NEW-0001", { exact: true })).toHaveCount(0);

    await ledger.getByRole("button", { name: "刷新订单" }).click();
    await expect(ledger.getByText("E2E-CURSOR-NEW-0001", { exact: true })).toBeVisible();
    await page.getByLabel("定位订单").fill("E2E游标单位0042");
    await expect(ledger.getByText("E2E-CURSOR-0042", { exact: true })).toBeVisible();
    await expect(ledger.getByText("本页 1 笔订单", { exact: true })).toBeVisible();
  } finally {
    await setup.end();
  }
});

test("订单组合筛选由 URL 恢复并区分空集、失败和无权限", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_filter_assistant",
    displayName: "E2E 筛选销售助理",
    password: "Filter@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });
  const setup = new Client({ connectionString: database.url });
  await setup.connect();
  const person = await setup.query<{ id: string }>("select id::text from people where user_id=$1", [userId]);
  async function insertRows(prefix: string, count: number, values: {
    customerUnit: string;
    salesperson: string;
    month: string;
    status: string;
    region: string;
    department: string;
    group: string;
  }) {
    await setup.query(
      `with orders as (
         insert into performance_orders
           (qingflow_order_no,customer_name,customer_unit,business_region_code,salesperson_person_id,salesperson_name,
            source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,created_at,posted_at)
         select $1||lpad(series::text,4,'0'),'E2E 筛选客户',$3,$7,$4,$5,($6::text||'-15')::date,1,1,1,$8,$11,$11
         from generate_series(1,$2::integer) series returning id
       )
       insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
          accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,department_name,group_name)
       select id,'initial',1,1,1,($6::text||'-01')::date,($6::text||'-15')::date,'浏览器组合筛选回归',$4,$5,$9,$10 from orders`,
      [
        prefix,
        count,
        values.customerUnit,
        person.rows[0]!.id,
        values.salesperson,
        values.month,
        values.region,
        values.status,
        values.department,
        values.group,
        "2026-08-31T13:00:00.000Z",
      ],
    );
  }
  const matching = {
    customerUnit: "筛选单位甲",
    salesperson: "筛选业务员甲",
    month: "2026-08",
    status: "active",
    region: "CN-JS",
    department: "筛选甲部",
    group: "筛选甲组",
  };
  await insertRows("E2E-FILTER-", 51, matching);
  await insertRows("E2E-OTHER-", 1, { ...matching, customerUnit: "筛选单位乙", region: "CN-ZJ" });

  try {
    await page.goto("/");
    await page.getByLabel("账号").fill("e2e_filter_assistant");
    await page.getByLabel("密码", { exact: true }).fill("Filter@123");
    await page.getByRole("button", { name: "进入 SampleFlow" }).click();
    await page.getByRole("button", { name: "订单业绩", exact: true }).click();
    const ledger = page.locator("section.orders-card").filter({ has: page.getByRole("heading", { name: "订单台账" }) });

    await page.getByLabel("订单月份").fill(matching.month);
    await page.getByLabel("部门筛选").fill(matching.department);
    await page.getByLabel("定位订单").fill("E2E-FILTER-");
    await expect(page).toHaveURL(/orderSearch=E2E-FILTER-/);
    await expect(page.getByLabel("订单月份")).toHaveValue(matching.month);
    await expect(page.getByLabel("部门筛选")).toHaveValue(matching.department);
    await page.getByLabel("订单状态").selectOption(matching.status);
    await page.getByLabel("业务员筛选").fill(matching.salesperson);
    await page.getByLabel("小组筛选").fill(matching.group);
    await page.getByLabel("标准业务区域筛选").selectOption(matching.region);
    await page.getByLabel("客户单位筛选").fill(matching.customerUnit);
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(ledger.getByText("E2E-FILTER-0051", { exact: true })).toBeVisible();
    await expect(ledger.getByText("E2E-OTHER-0001", { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/page=orders/);
    for (const value of ["orderMonth=2026-08", "orderStatus=active", "orderRegion=CN-JS"]) await expect(page).toHaveURL(new RegExp(value));

    await ledger.getByRole("button", { name: "下一页" }).click();
    await expect(ledger.getByText("E2E-FILTER-0001", { exact: true })).toBeVisible();
    await expect(ledger.getByText("本页 1 笔订单", { exact: true })).toBeVisible();
    const secondPageUrl = page.url();
    expect(secondPageUrl).toContain("orderCursor=");
    await page.reload();
    await expect(ledger.getByText("E2E-FILTER-0001", { exact: true })).toBeVisible();
    await ledger.getByRole("button", { name: "查看 / 调整" }).click();
    await expect(page.getByRole("dialog", { name: "E2E-FILTER-0001" })).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).click();
    expect(page.url()).toBe(secondPageUrl);

    const exportButton=page.getByRole("button",{name:"导出全部匹配订单"});
    await expect(exportButton).toBeVisible({timeout:1_000});
    const [exportRequest,download]=await Promise.all([
      page.waitForRequest("**/api/exports/performance.csv*"),
      page.waitForEvent("download"),
      exportButton.click(),
    ]);
    const exportParams=new URL(exportRequest.url()).searchParams;
    expect(Object.fromEntries(exportParams)).toEqual({
      search:"E2E-FILTER-",month:matching.month,status:matching.status,salesperson:matching.salesperson,
      department:matching.department,group:matching.group,region:matching.region,customerUnit:matching.customerUnit,
    });
    expect(exportParams.has("cursor")).toBe(false);
    const downloadStream=await download.createReadStream();
    let exportedCsv="";
    for await(const chunk of downloadStream)exportedCsv+=chunk.toString("utf8");
    expect(exportedCsv.split("\r\n")).toHaveLength(52);
    expect(exportedCsv).toContain('"E2E-FILTER-0001"');
    expect(exportedCsv).toContain('"E2E-FILTER-0051"');
    expect(exportedCsv).not.toContain("E2E-OTHER-0001");

    await page.goBack();
    await expect(ledger.getByText("E2E-FILTER-0051", { exact: true })).toBeVisible();
    await page.goForward();
    await expect(ledger.getByText("E2E-FILTER-0001", { exact: true })).toBeVisible();

    let responseMode: "live" | "empty" | "failure" | "forbidden" = "live";
    await page.route("**/api/performance/orders*", async (route) => {
      if (responseMode === "live") return route.continue();
      if (responseMode === "failure") return route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"筛选加载失败"}' });
      if (responseMode === "forbidden") return route.fulfill({ status: 403, contentType: "application/json", body: '{"message":"当前角色没有业务查看权限"}' });
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"orders":[],"previousCursor":null,"nextCursor":null,"pageSize":50}' });
    });
    responseMode = "failure";
    await page.getByLabel("客户单位筛选").fill("不存在的单位");
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page.getByRole("alert")).toHaveText("筛选加载失败");
    await expect(ledger.getByText("E2E-FILTER-0001", { exact: true })).toHaveCount(0);
    await expect(ledger.getByRole("button", { name: "上一页" })).toBeDisabled();
    await expect(ledger.getByRole("button", { name: "下一页" })).toBeDisabled();
    responseMode = "live";
    await page.getByRole("button", { name: "重试查询" }).click();
    await expect(ledger.getByText("没有符合当前组合条件的订单。", { exact: true })).toBeVisible();

    responseMode = "empty";
    await page.getByRole("button", { name: "清除筛选" }).click();
    await expect(ledger.getByText("暂无订单数据。", { exact: true })).toBeVisible();
    responseMode = "forbidden";
    await ledger.getByRole("button", { name: "刷新订单" }).click();
    await expect(page.getByText("当前账号没有订单查看权限。", { exact: true })).toBeVisible();
  } finally {
    await setup.end();
  }
});

test("无业务权限账号访问订单深链时看到明确权限说明", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_order_forbidden",
    displayName: "E2E 纯系统管理员",
    password: "Forbidden@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  await page.goto("/?page=orders&orderMonth=2026-08");
  await page.getByLabel("账号").fill("e2e_order_forbidden");
  await page.getByLabel("密码", { exact: true }).fill("Forbidden@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
  await expect(page.getByRole("heading", { name: "无法访问订单业绩" })).toBeVisible();
  await expect(page.getByText("当前账号没有订单查看权限。", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/page=orders/);
});

test("首次登录用户看到密码强度并完成改密", async ({ database, page }) => {
    await seedTestUser(database.url, {
      username: "e2e_password_change",
      displayName: "E2E 首次改密用户",
      password: "Before@123",
      mustChangePassword: true,
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_password_change");
      await page.getByLabel("密码", { exact: true }).fill("Before@123");
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();

      await expect(page.getByRole("heading", { name: "请修改初始密码" })).toBeVisible();
      await expect(page.getByText("6—128 位，并包含英文字母、数字和符号")).toBeVisible();
      await expect(page.getByText("当前密码请填写刚才登录时使用的临时密码")).toBeVisible();
      const currentPassword = page.getByLabel("当前密码", { exact: true });
      const newPassword = page.getByLabel("新密码", { exact: true });
      await expect(currentPassword).toHaveAttribute("type", "password");
      await page.getByRole("button", { name: "显示当前密码" }).click();
      await expect(currentPassword).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: "隐藏当前密码" }).click();
      await expect(currentPassword).toHaveAttribute("type", "password");
      await expect(newPassword).toHaveAttribute("type", "password");
      await page.getByRole("button", { name: "显示新密码" }).click();
      await expect(newPassword).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: "隐藏新密码" }).click();
      await expect(newPassword).toHaveAttribute("type", "password");
      // 模拟浏览器密码管理器静默回填：只改变输入框，不触发 React change 事件。
      await currentPassword.evaluate((input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
      }, "Before@123");
      await expect(currentPassword).toHaveValue("Before@123");
      await newPassword.fill("Abc@12");
      await expect(page.getByText("密码强度：弱")).toBeVisible();
      await expect(currentPassword).toHaveValue("Before@123");
      const dashboardResponse = page.waitForResponse((response) =>
        response.url().includes("/api/performance/dashboard") && response.status() === 200
      );
      await page.getByRole("button", { name: "保存新密码" }).click();
      await dashboardResponse;
      await expect(page.getByRole("heading", { name: "业绩账本总览" })).toBeVisible();
});

test("系统管理员在账号管理页查看只读角色权限说明", async ({ database, page }) => {
    await seedTestUser(database.url, {
      username: "e2e_system_admin",
      displayName: "E2E 系统管理员",
      password: "Admin@123",
      roleCode: "system_admin",
      roleName: "系统管理员",
    });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_system_admin");
      await page.getByLabel("密码", { exact: true }).fill("Admin@123");
      const accountsResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/users"));
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();

      expect((await accountsResponse).status()).toBe(200);
      await expect(page.getByRole("button", { name: "账号管理" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("button", { name: "业绩总览" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "订单业绩" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "目标管理" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "角色权限说明" })).toBeVisible();
      await expect(page.getByText("多角色账号取各角色权限并集；系统管理员角色本身不增加业务权限")).toBeVisible();

      const administratorRow = page.getByRole("row").filter({ hasText: "系统管理员" }).last();
      await expect(administratorRow).toContainText("无业务范围");
      await expect(administratorRow).toContainText("业务查看与导出");
      const salespersonRow = page.getByRole("row").filter({ hasText: "业务员" }).last();
      await expect(salespersonRow).toContainText("仅本人");

      const matrixScroller = page.locator(".permission-matrix-card .orders-table-wrap");
      expect(await matrixScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test("目标未生效时页面不提供正式报表，生效后才可查看", async ({ database, page }) => {
    const userId = await seedTestUser(database.url, {
      username: "e2e_salesperson_report",
      displayName: "E2E 业务员",
      password: "Report@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `with owner as (
         select id as person_id from people where user_id=$1
       ), active_goal as (
         insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         select '2026-08-01','personal',$1,person_id from owner returning id,owner_person_id
       ), pending_goal as (
         insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         select '2026-09-01','personal',$1,person_id from owner returning id,owner_person_id
       )
       insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
       select id,1,1000,'active',$1,owner_person_id,'浏览器门禁测试' from active_goal
       union all
       select id,1,2000,'pending_hr',$1,owner_person_id,'浏览器门禁测试' from pending_goal`,
      [userId],
    );
    const activeGoal = await client.query<{ id: string }>(
      "select id::text from goals where owner_user_id=$1 and period_month='2026-08-01'",
      [userId],
    );
    await client.end();

      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_salesperson_report");
      await page.getByLabel("密码", { exact: true }).fill("Report@123");
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();
      await page.getByRole("button", { name: "目标管理" }).click();

      const pendingRow = page.getByRole("row").filter({ hasText: "2026-09" });
      await expect(pendingRow).toContainText("待人事审批");
      await expect(pendingRow.getByRole("button", { name: "查看正式报表" })).toHaveCount(0);

      const activeRow = page.getByRole("row").filter({ hasText: "2026-08" });
      const reportResponse = page.waitForResponse((response) => response.url().includes("/api/performance/formal-reports/") && response.status() === 200);
      await activeRow.getByRole("button", { name: "查看正式报表" }).click();
      await reportResponse;
      await expect(page.getByRole("heading", { name: "正式业绩报表" })).toBeVisible();
      await expect(page.getByText("目标已生效，达成率按该层级目标独立计算")).toBeVisible();
      const reportDialog = page.getByRole("dialog");
      await expect(reportDialog.getByText("生效目标", { exact: true }).locator("..")).toContainText("¥1,000.00");
      await expect(reportDialog.getByText("实际业绩", { exact: true }).locator("..")).toContainText("¥0.00");
      await expect(reportDialog.getByText("目标差距", { exact: true }).locator("..")).toContainText("¥1,000.00");
      const downloadPromise = page.waitForEvent("download");
      await reportDialog.getByRole("button", { name: "导出正式报表" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(`sampleflow-formal-report-2026-08-${activeGoal.rows[0]!.id}.csv`);
});

test("销售经理可从选择器创建顶层目标并完成总经理到人事审批", async ({ database, page }) => {
  test.slow();
    const managerId=await seedTestUser(database.url,{username:"e2e_goal_manager",displayName:"E2E 销售经理",password:"Goal@123",roleCode:"sales_manager",roleName:"销售经理"});
    const supervisorId=await seedTestUser(database.url,{username:"e2e_goal_supervisor",displayName:"E2E 业务主管",password:"Goal@123",roleCode:"sales_supervisor",roleName:"业务主管"});
    await seedTestUser(database.url,{username:"e2e_goal_gm",displayName:"E2E 总经理",password:"Goal@123",roleCode:"general_manager",roleName:"总经理"});
    await seedTestUser(database.url,{username:"e2e_goal_hr",displayName:"E2E 人事",password:"Goal@123",roleCode:"hr",roleName:"人事部"});
    let managerPersonId="";let supervisorPersonId="";
    const setup=new Client({connectionString:database.url});await setup.connect();
    try{
      const people=await setup.query<{user_id:string;id:string}>("select user_id::text,id::text from people where user_id=any($1::bigint[])",[[managerId,supervisorId]]);
      managerPersonId=people.rows.find((row)=>row.user_id===managerId)!.id;
      supervisorPersonId=people.rows.find((row)=>row.user_id===supervisorId)!.id;
      const department=await setup.query<{id:string}>("insert into org_units(name,unit_type) values('E2E 目标部门','department') returning id::text");
      await setup.query("insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$2,'supervisor','2026-01-01')",[supervisorPersonId,department.rows[0]!.id]);
      await setup.query("update org_units set is_active=true where id=$1",[department.rows[0]!.id]);
    }finally{await setup.end();}

    const login=async(username:string)=>{await page.getByLabel("账号").fill(username);await page.getByLabel("密码",{exact:true}).fill("Goal@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();};
    const logout=async()=>{await page.getByRole("button",{name:"退出登录"}).click();await expect(page.getByRole("heading",{name:"登录系统"})).toBeVisible();};
      let delayedGoalOptions=false;
      await page.route("**/api/goals/options?*",async(route)=>{if(!delayedGoalOptions&&route.request().url().includes("periodMonth=2026-11")&&route.request().url().includes("level=sales_manager")){delayedGoalOptions=true;await new Promise((resolve)=>setTimeout(resolve,6000));}await route.continue();});
      await page.goto("/");await login("e2e_goal_manager");await expect(page.getByRole("button",{name:"目标管理"})).toBeVisible();
      const illegalRoot=await page.evaluate(async({ownerPersonId})=>{const csrf=document.cookie.split("; ").find((item)=>item.startsWith("sampleflow_csrf="))?.split("=")[1]??"";const response=await fetch("/api/goals",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":decodeURIComponent(csrf)},body:JSON.stringify({periodMonth:"2026-11",level:"sales_manager",ownerPersonId:Number(ownerPersonId),orgUnitId:null,parentGoalId:999999,amount:1000,changeReason:"非法顶层父目标"})});return{status:response.status,body:await response.text()};},{ownerPersonId:managerPersonId});
      expect(illegalRoot.status).toBe(400);expect(illegalRoot.body).not.toMatch(/constraint|foreign key/i);
      await page.getByRole("button",{name:"目标管理"}).click();
      await page.getByRole("button",{name:"下达目标"}).click();
      await expect(page.getByLabel("目标层级")).toHaveValue("sales_manager");
      const goalOptionsResponse=page.waitForResponse((response)=>response.url().includes("/api/goals/options?")&&response.url().includes("periodMonth=2026-11")&&response.url().includes("level=sales_manager")&&response.status()===200);
      await page.getByLabel("目标月份").fill("2026-11");
      await goalOptionsResponse;
      await expect(page.getByLabel("直属上级目标")).toHaveCount(0);
      await expect(page.getByLabel("目标责任人")).toHaveValue(/\d+/);
      await page.getByLabel("目标金额").fill("1000");
      await page.getByLabel("下达原因").fill("公司十一月目标");
      await page.getByRole("button",{name:"提交待确认"}).click();
      const topRow=page.getByRole("row").filter({hasText:"2026-11"}).filter({hasText:"销售经理总目标"});
      await expect(topRow).toContainText("待责任人签名");
      await topRow.getByRole("button",{name:"确认签名"}).click();
      await page.getByLabel("签名确认").fill("E2E 销售经理确认");
      await page.getByRole("button",{name:"提交签名"}).click();
      await expect(topRow).toContainText("待总经理审批");

      await logout();await login("e2e_goal_gm");await page.getByRole("button",{name:"审批中心"}).click();
      const gmRow=page.getByRole("row").filter({hasText:"2026-11"});await gmRow.getByRole("button",{name:"批准"}).click();
      await page.getByLabel("审批意见").fill("总经理同意");await page.getByRole("button",{name:"确认批准"}).click();
      await expect(gmRow).toHaveCount(0);

      await logout();await login("e2e_goal_hr");await page.getByRole("button",{name:"审批中心"}).click();
      const hrRow=page.getByRole("row").filter({hasText:"2026-11"});await hrRow.getByRole("button",{name:"批准"}).click();
      await page.getByLabel("审批意见").fill("人事终审同意");await page.getByRole("button",{name:"确认批准"}).click();
      await expect(hrRow).toHaveCount(0);

      await logout();await login("e2e_goal_manager");await page.getByRole("button",{name:"目标管理"}).click();
      await expect(page.getByRole("row").filter({hasText:"2026-11"}).filter({hasText:"已生效"})).toBeVisible();
      await page.getByRole("button",{name:"下达目标"}).click();
      await page.getByLabel("目标月份").fill("2026-11");await page.getByLabel("目标层级").selectOption("department");
      await expect(page.getByLabel("直属上级目标")).toContainText("E2E 销售经理");
      await expect(page.getByLabel("目标责任人")).toContainText("E2E 业务主管");
      await page.getByLabel("目标责任人").selectOption({label:"E2E 业务主管 · E2E 目标部门"});
      await page.getByLabel("目标金额").fill("800");await page.getByLabel("下达原因").fill("部门十一月目标");
      await page.getByRole("button",{name:"提交待确认"}).click();
      await expect(page.getByRole("row").filter({hasText:"E2E 业务主管"})).toContainText("待责任人签名");
});

test("目标修改申请在审批中心完成填金额、重签、终审和联动选择",async({database,page})=>{
  test.slow();
    const users={
      manager:await seedTestUser(database.url,{username:"e2e_change_manager",displayName:"E2E 变更经理",password:"Goal@123",roleCode:"sales_manager",roleName:"销售经理"}),
      supervisor:await seedTestUser(database.url,{username:"e2e_change_supervisor",displayName:"E2E 变更主管",password:"Goal@123",roleCode:"sales_supervisor",roleName:"业务主管"}),
      leader:await seedTestUser(database.url,{username:"e2e_change_leader",displayName:"E2E 变更组长",password:"Goal@123",roleCode:"sales_leader",roleName:"业务员组长"}),
      salesperson:await seedTestUser(database.url,{username:"e2e_change_salesperson",displayName:"E2E 变更业务员",password:"Goal@123",roleCode:"salesperson",roleName:"业务员"}),
      hr:await seedTestUser(database.url,{username:"e2e_change_hr",displayName:"E2E 变更人事",password:"Goal@123",roleCode:"hr",roleName:"人事部"}),
    };
    const setup=new Client({connectionString:database.url});await setup.connect();
    try{
      const peopleResult=await setup.query<{user_id:string;id:string}>("select user_id::text,id::text from people where user_id=any($1::bigint[])",[Object.values(users)]);
      const person=(userId:string)=>peopleResult.rows.find((row)=>row.user_id===userId)!.id;
      const department=await setup.query<{id:string}>("insert into org_units(name,unit_type) values('E2E 变更部门','department') returning id::text");
      const group=await setup.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('E2E 变更小组','group',$1) returning id::text",[department.rows[0]!.id]);
      await setup.query("insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$3,'supervisor','2026-01-01'),($2,$4,'leader','2026-01-01')",[person(users.supervisor),person(users.leader),department.rows[0]!.id,group.rows[0]!.id]);
      await setup.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[person(users.salesperson),department.rows[0]!.id,group.rows[0]!.id]);
      await setup.query("update org_units set is_active=true where id=any($1::bigint[])",[[department.rows[0]!.id,group.rows[0]!.id]]);
      const top=await setup.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id) values('2026-12-01','sales_manager',$1,$2) returning id::text",[users.manager,person(users.manager)]);
      const departmentGoal=await setup.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id) values('2026-12-01','department',$1,$2,$3,$4) returning id::text",[users.supervisor,person(users.supervisor),top.rows[0]!.id,department.rows[0]!.id]);
      const groupGoal=await setup.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id,org_unit_id) values('2026-12-01','group',$1,$2,$3,$4) returning id::text",[users.leader,person(users.leader),departmentGoal.rows[0]!.id,group.rows[0]!.id]);
      const personalGoal=await setup.query<{id:string}>("insert into goals(period_month,goal_level,owner_user_id,owner_person_id,parent_goal_id) values('2026-12-01','personal',$1,$2,$3) returning id::text",[users.salesperson,person(users.salesperson),groupGoal.rows[0]!.id]);
      for(const [goalId,amount,creator,owner] of [[top.rows[0]!.id,1000,users.manager,users.manager],[departmentGoal.rows[0]!.id,800,users.manager,users.supervisor],[groupGoal.rows[0]!.id,600,users.supervisor,users.leader],[personalGoal.rows[0]!.id,400,users.leader,users.salesperson]] as const){await setup.query("insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,signed_by,signed_by_person_id,signed_at,signature_text,change_reason) values($1,1,$2,'active',$3,$4,$5,$6,now(),'初始确认','E2E 变更初始目标')",[goalId,amount,creator,person(creator),owner,person(owner)]);}
    }finally{await setup.end();}
    const login=async(username:string)=>{await page.getByLabel("账号").fill(username);await page.getByLabel("密码",{exact:true}).fill("Goal@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();};
    const logout=async()=>{await page.getByRole("button",{name:"退出登录"}).click();await expect(page.getByRole("heading",{name:"登录系统"})).toBeVisible();};
      await page.goto("/");
      await login("e2e_change_salesperson");await page.getByRole("button",{name:"目标管理"}).click();
      const personalRow=page.getByRole("row").filter({hasText:"E2E 变更业务员"});await personalRow.getByRole("button",{name:"申请修改"}).click();
      await page.getByLabel("修改原因").fill("客户结构发生变化");await page.getByLabel("建议金额（可选）").fill("450");await page.getByRole("button",{name:"提交修改申请"}).click();
      await expect(page.getByText("修改申请已提交。")).toBeVisible();

      await logout();await login("e2e_change_leader");await page.getByRole("button",{name:"审批中心"}).click();
      const requestRow=page.getByRole("row").filter({hasText:"E2E 变更业务员"}).filter({hasText:"客户结构发生变化"});await requestRow.getByRole("button",{name:"接受并填金额"}).click();
      await page.getByLabel("新目标金额").fill("450");await page.getByLabel("处理意见").fill("同意按客户结构调整");await page.getByRole("button",{name:"接受并创建新版本"}).click();

      await logout();await login("e2e_change_salesperson");await page.getByRole("button",{name:"目标管理"}).click();
      const pendingRow=page.getByRole("row").filter({hasText:"E2E 变更业务员"});await expect(pendingRow).toContainText("¥450.00");await pendingRow.getByRole("button",{name:"确认签名"}).click();
      await page.getByLabel("签名确认").fill("E2E 业务员重新确认");await page.getByRole("button",{name:"提交签名"}).click();

      await logout();await login("e2e_change_hr");await page.getByRole("button",{name:"审批中心"}).click();
      const approvalRow=page.getByRole("row").filter({hasText:"E2E 变更业务员"}).filter({hasText:"待人事审批"});await approvalRow.getByRole("button",{name:"批准"}).click();
      await page.getByLabel("审批意见").fill("人事确认变更链完整");await page.getByRole("button",{name:"确认批准"}).click();

      await logout();await login("e2e_change_leader");await page.getByRole("button",{name:"审批中心"}).click();
      const linkageRow=page.getByRole("row").filter({hasText:"E2E 变更业务员"}).filter({hasText:"¥450.00"});await linkageRow.getByRole("button",{name:"选择是否调整"}).click();
      await page.getByLabel("处理方式").selectOption("keep_parent");await page.getByLabel("联动原因").fill("小组目标维持六百元");await page.getByRole("button",{name:"确认联动选择"}).click();
      const linkageCard=page.locator("section.workflow-card").filter({has:page.getByRole("heading",{name:"目标联动选择"})});
      await expect(linkageCard.getByRole("row").filter({hasText:"E2E 变更业务员"}).filter({hasText:"已完成"})).toBeVisible();

      await logout();await login("e2e_change_salesperson");await page.getByRole("button",{name:"目标管理"}).click();
      const activePersonal=page.getByRole("row").filter({hasText:"E2E 变更业务员"});await activePersonal.getByRole("button",{name:"申请修改"}).click();
      await page.getByLabel("修改原因").fill("再次调整并联动上级");await page.getByLabel("建议金额（可选）").fill("475");await page.getByRole("button",{name:"提交修改申请"}).click();

      await logout();await login("e2e_change_leader");await page.getByRole("button",{name:"审批中心"}).click();
      const secondRequest=page.getByRole("row").filter({hasText:"再次调整并联动上级"});await secondRequest.getByRole("button",{name:"接受并填金额"}).click();
      await page.getByLabel("新目标金额").fill("475");await page.getByLabel("处理意见").fill("接受第二次调整");await page.getByRole("button",{name:"接受并创建新版本"}).click();

      await logout();await login("e2e_change_salesperson");await page.getByRole("button",{name:"目标管理"}).click();
      const secondPending=page.getByRole("row").filter({hasText:"E2E 变更业务员"});await secondPending.getByRole("button",{name:"确认签名"}).click();
      await page.getByLabel("签名确认").fill("E2E 业务员第二次确认");await page.getByRole("button",{name:"提交签名"}).click();

      await logout();await login("e2e_change_hr");await page.getByRole("button",{name:"审批中心"}).click();
      const secondApproval=page.getByRole("row").filter({hasText:"E2E 变更业务员"}).filter({hasText:"待人事审批"});await secondApproval.getByRole("button",{name:"批准"}).click();
      await page.getByLabel("审批意见").fill("人事批准第二次调整");await page.getByRole("button",{name:"确认批准"}).click();

      await logout();await login("e2e_change_leader");await page.getByRole("button",{name:"审批中心"}).click();
      const secondLinkage=page.getByRole("row").filter({hasText:"E2E 变更业务员"}).filter({hasText:"¥475.00"});await secondLinkage.getByRole("button",{name:"选择是否调整"}).click();
      await page.getByLabel("处理方式").selectOption("adjust_parent");await page.getByLabel("联动原因").fill("需要同步调整小组目标");await page.getByRole("button",{name:"确认联动选择"}).click();
      const changeCard=page.locator("section.workflow-card").filter({has:page.getByRole("heading",{name:"目标修改申请"})});
      await expect(changeCard.getByRole("row").filter({hasText:"E2E 变更组长"}).filter({hasText:"需要同步调整小组目标"})).toContainText("待处理");
});

test("系统管理员通过页面办理组织异动并保留前后有效期", async ({ database, page }) => {
    await seedTestUser(database.url,{username:"e2e_org_admin",displayName:"E2E 组织管理员",password:"OrgAdmin@123",roleCode:"system_admin",roleName:"系统管理员"});
    await seedTestUser(database.url,{username:"e2e_org_assistant",displayName:"E2E 异动销售助理",password:"OrgAssistant@123",roleCode:"sales_assistant",roleName:"销售助理"});
    await seedTestUser(database.url,{username:"e2e_org_member",displayName:"E2E 异动业务员",password:"OrgMember@123",roleCode:"salesperson",roleName:"业务员"});
    await seedTestUser(database.url,{username:"e2e_org_leader",displayName:"E2E 异动组长",password:"OrgLeader@123",roleCode:"sales_leader",roleName:"业务员组长"});
    await seedTestUser(database.url,{username:"e2e_org_successor",displayName:"E2E 继任组长",password:"OrgSuccessor@123",roleCode:"sales_leader",roleName:"业务员组长"});
    await seedTestUser(database.url,{username:"e2e_org_supervisor",displayName:"E2E 异动主管",password:"OrgSupervisor@123",roleCode:"sales_supervisor",roleName:"业务主管"});
    await seedTestUser(database.url,{username:"e2e_org_supervisor_successor",displayName:"E2E 继任主管",password:"OrgSupervisorSuccessor@123",roleCode:"sales_supervisor",roleName:"业务主管"});

      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_org_admin");
      await page.getByLabel("密码",{exact:true}).fill("OrgAdmin@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"组织架构"}).click();

      for(const departmentName of ["E2E 原部门","E2E 新部门"]){
        await page.getByRole("button",{name:"新增组织"}).click();
        await page.getByLabel("名称").fill(departmentName);
        await page.getByRole("button",{name:"保存组织"}).click();
      }
      for(const [groupName,departmentName] of [["E2E 原小组","E2E 原部门"],["E2E 新小组","E2E 新部门"]]){
        await page.getByRole("button",{name:"新增组织"}).click();
        await page.getByLabel("名称").fill(groupName);
        await page.getByLabel("类型").selectOption("group");
        await page.getByLabel("所属部门").selectOption({label:departmentName});
        await page.getByRole("button",{name:"保存组织"}).click();
      }

      await page.getByRole("button",{name:"新增任职"}).click();
      let assignmentDialog=page.getByRole("dialog");
      await assignmentDialog.getByRole("combobox").nth(0).selectOption({label:"E2E 异动业务员（e2e_org_member）"});
      await page.getByLabel("生效日期").fill("2026-07-01");
      await assignmentDialog.getByRole("combobox").nth(1).selectOption({label:"E2E 原部门"});
      await assignmentDialog.getByRole("combobox").nth(2).selectOption({label:"E2E 原小组"});
      await assignmentDialog.getByRole("combobox").nth(3).selectOption({label:"E2E 异动组长（e2e_org_leader）"});
      await assignmentDialog.getByRole("combobox").nth(4).selectOption({label:"E2E 异动主管（e2e_org_supervisor）"});
      await page.getByRole("button",{name:"保存任职"}).click();

      await expect(page.getByRole("button",{name:"办理组织异动"})).toBeVisible({timeout:1_000});
      await page.getByRole("button",{name:"办理组织异动"}).click();
      assignmentDialog=page.getByRole("dialog");
      await assignmentDialog.getByRole("combobox").nth(0).selectOption({label:"E2E 异动业务员（e2e_org_member）"});
      await page.getByLabel("生效日期").fill("2026-08-01");
      await assignmentDialog.getByRole("combobox").nth(1).selectOption({label:"E2E 新部门"});
      await assignmentDialog.getByRole("combobox").nth(2).selectOption({label:"E2E 新小组"});
      await assignmentDialog.getByRole("combobox").nth(3).selectOption({label:"E2E 异动组长（e2e_org_leader）"});
      await assignmentDialog.getByRole("combobox").nth(4).selectOption({label:"E2E 异动主管（e2e_org_supervisor）"});
      await page.getByRole("button",{name:"确认异动"}).click();

      const oldAssignment=page.locator(".compact-list > div").filter({hasText:"E2E 异动业务员"}).filter({hasText:"E2E 原部门 / E2E 原小组"});
      const newAssignment=page.locator(".compact-list > div").filter({hasText:"E2E 异动业务员"}).filter({hasText:"E2E 新部门 / E2E 新小组"});
      await expect(oldAssignment).toContainText("2026-07-01 至 2026-07-31");
      await expect(newAssignment).toContainText("2026-08-01 起");

      let failOrganizationRefresh=true;
      await page.route("**/api/organization",async(route)=>{
        if(failOrganizationRefresh&&route.request().method()==="GET"){
          failOrganizationRefresh=false;
          await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({message:"组织列表暂不可用"})});
          return;
        }
        await route.continue();
      });
      await newAssignment.getByRole("button",{name:"关闭任职"}).click();
      const closeDialog=page.getByRole("dialog",{name:"关闭人员任职"});
      await closeDialog.getByLabel("离任生效日期").fill("2026-10-01");
      await closeDialog.getByRole("button",{name:"确认关闭"}).click();
      await expect(newAssignment).toContainText("2026-08-01 至 2026-09-30");
      await expect(page.getByRole("alert")).toHaveText("任职已关闭，但组织列表刷新失败，请刷新页面重试。");
      await expect(newAssignment.getByRole("button",{name:"关闭任职"})).toHaveCount(0);

      const currentLeader=page.locator(".responsibility-list > div").filter({hasText:"E2E 新小组"}).filter({hasText:"E2E 异动组长"}).filter({hasText:"2026-08-01 起"});
      await currentLeader.getByRole("button",{name:"更换负责人"}).click();
      const successorDialog=page.getByRole("dialog",{name:"更换负责人"});
      await successorDialog.getByLabel("继任负责人").selectOption({label:"E2E 继任组长（e2e_org_successor）"});
      await successorDialog.getByLabel("继任生效日期").fill("2026-09-01");
      await successorDialog.getByRole("button",{name:"确认继任"}).click();
      await expect(page.locator(".responsibility-list > div").filter({hasText:"E2E 新小组"}).filter({hasText:"E2E 异动组长"})).toContainText("2026-08-01 至 2026-08-31");
      await expect(page.locator(".responsibility-list > div").filter({hasText:"E2E 新小组"}).filter({hasText:"E2E 继任组长"})).toContainText("2026-09-01 起");

      const currentSupervisor=page.locator(".responsibility-list > div").filter({hasText:"E2E 新部门"}).filter({hasText:"E2E 异动主管"}).filter({hasText:"2026-08-01 起"});
      await currentSupervisor.getByRole("button",{name:"更换负责人"}).click();
      const supervisorDialog=page.getByRole("dialog",{name:"更换负责人"});
      await supervisorDialog.getByLabel("继任负责人").selectOption({label:"E2E 继任主管（e2e_org_supervisor_successor）"});
      await supervisorDialog.getByLabel("继任生效日期").fill("2026-09-01");
      await supervisorDialog.getByRole("button",{name:"确认继任"}).click();
      await expect(page.locator(".responsibility-list > div").filter({hasText:"E2E 新部门"}).filter({hasText:"E2E 异动主管"})).toContainText("2026-08-01 至 2026-08-31");
      await expect(page.locator(".responsibility-list > div").filter({hasText:"E2E 新部门"}).filter({hasText:"E2E 继任主管"})).toContainText("2026-09-01 起");

      await page.getByRole("button",{name:"退出登录"}).click();
      await expect(page.getByRole("heading",{name:"登录系统"})).toBeVisible();
      await page.getByLabel("账号",{exact:true}).fill("e2e_org_assistant");
      await page.getByLabel("密码",{exact:true}).fill("OrgAssistant@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      await page.getByRole("button",{name:"录入新订单"}).click();
      const createOrderDialog=page.getByRole("dialog",{name:"录入订单业绩"});
      await page.getByLabel("订单编号").fill("ORG-TRANSFER-E2E-100");
      await page.getByLabel("收到日期").fill("2026-07-15");
      await page.getByLabel("客户名称").fill("组织异动客户");
      await page.getByLabel("客户单位",{exact:true}).fill("组织异动测试单位");
      await page.getByLabel("来源区域原文").fill("外贸组织线索");
      await createOrderDialog.getByLabel("标准业务区域").selectOption("EXT-TRADE");
      await createOrderDialog.getByLabel("业务员").selectOption({label:"E2E 异动业务员"});
      await page.getByLabel("服务类型").fill("组织快照验收");
      await page.getByLabel("营业额").fill("100");
      await page.getByRole("button",{name:"确认入账"}).click();

      const orderRow=page.getByRole("row").filter({hasText:"ORG-TRANSFER-E2E-100"});
      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await page.getByLabel("调整后营业额").fill("90");
      await page.getByLabel("原因（必填）").fill("异动生效后修改营业额");
      await page.getByRole("button",{name:"确认追加事件"}).click();
      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();

      const events=page.locator(".event-ledger li");
      await expect(events).toHaveCount(2);
      await expect(events.nth(0)).toContainText("E2E 原部门 / E2E 原小组");
      await expect(events.nth(1)).toContainText("E2E 新部门 / E2E 新小组");
});

test("订单搜索与不可变事件链在浏览器和数据库中保持一致", async ({ database, page },testInfo) => {
  test.slow();
    await seedTestUser(database.url, {
      username: "e2e_ledger_assistant",
      displayName: "E2E 账本销售助理",
      password: "Ledger@123",
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });
    await seedTestUser(database.url, {
      username: "e2e_accounting_leader",
      displayName: "E2E 销售助理组长",
      password: "Ledger@123",
      roleCode: "sales_assistant_leader",
      roleName: "销售助理组长",
    });
    await seedTestUser(database.url, {
      username: "e2e_accounting_hr",
      displayName: "E2E 人事",
      password: "Ledger@123",
      roleCode: "hr",
      roleName: "人事部",
    });
    const memberUserId=await seedTestUser(database.url, {
      username: "e2e_ledger_member",
      displayName: "E2E 账本业务员",
      password: "Ledger@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const leaderUserId=await seedTestUser(database.url, {
      username: "e2e_ledger_leader",
      displayName: "E2E 账本组长",
      password: "Ledger@123",
      roleCode: "sales_leader",
      roleName: "业务员组长",
    });
    const supervisorUserId=await seedTestUser(database.url, {
      username: "e2e_ledger_supervisor",
      displayName: "E2E 账本主管",
      password: "Ledger@123",
      roleCode: "sales_supervisor",
      roleName: "业务主管",
    });
    const setup=new Client({connectionString:database.url});await setup.connect();
    try{
      const people=await setup.query<{user_id:string;id:string}>("select user_id::text,p.id::text from people p where user_id=any($1::bigint[])",[[memberUserId,leaderUserId,supervisorUserId]]);
      const personId=(userId:string)=>people.rows.find((row)=>row.user_id===userId)!.id;
      const department=await setup.query<{id:string}>("insert into org_units(name,unit_type) values('E2E 账本部门','department') returning id::text");
      const group=await setup.query<{id:string}>("insert into org_units(name,unit_type,parent_id) values('E2E 账本小组','group',$1) returning id::text",[department.rows[0]!.id]);
      await setup.query(`insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$3,'leader','2026-01-01'),($2,$4,'supervisor','2026-01-01')`,[personId(leaderUserId),personId(supervisorUserId),group.rows[0]!.id,department.rows[0]!.id]);
      await setup.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[personId(memberUserId),department.rows[0]!.id,group.rows[0]!.id]);
      await setup.query("update org_units set is_active=true where id=any($1::bigint[])",[[department.rows[0]!.id,group.rows[0]!.id]]);
    }finally{await setup.end();}

      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_ledger_assistant");
      await page.getByLabel("密码", { exact: true }).fill("Ledger@123");
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();
      await page.getByRole("button", { name: "订单业绩", exact:true }).click();

      await page.getByRole("button", { name: "录入新订单" }).click();
      const createOrderDialog=page.getByRole("dialog",{name:"录入订单业绩"});
      await page.getByLabel("订单编号").fill("CHAIN-E2E-110");
      await page.getByLabel("客户名称").fill("事件链客户");
      await page.getByLabel("客户单位",{exact:true}).fill("事件链测试单位");
      await page.getByLabel("来源区域原文").fill("外贸事件线索");
      await createOrderDialog.getByLabel("标准业务区域").selectOption("EXT-TRADE");
      await createOrderDialog.getByLabel("业务员").selectOption({label:"E2E 账本业务员"});
      await page.getByLabel("服务类型").fill("浏览器验收");
      await page.getByLabel("营业额").fill("110");
      await page.getByRole("button", { name: "确认入账" }).click();
      const orderRow=page.getByRole("row").filter({hasText:"CHAIN-E2E-110"});
      await expect(orderRow).toBeVisible();

      await page.getByLabel("定位订单").fill("CHAIN-E2E-110");
      await expect(page).toHaveURL(/orderSearch=CHAIN-E2E-110/);
      await expect(orderRow).toBeVisible();
      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await expect(page.getByRole("heading",{name:"不可变事件链"})).toBeVisible();
      await expect(page.getByLabel("事件发生日期")).toHaveCount(0);
      await expect(page.locator(".event-summary b")).toHaveText(["+¥110.00"]);
      await expect(page.getByText("外贸 (EXT-TRADE) · 来源 外贸事件线索 · 客户单位 事件链测试单位")).toBeVisible();
      await page.getByLabel("调整后营业额").fill("100");
      await page.getByLabel("原因（必填）").fill("浏览器改单为 100");
      await page.getByRole("button",{name:"确认追加事件"}).click();

      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await page.getByRole("button",{name:"整单暂停"}).click();
      await page.getByLabel("原因（必填）").fill("浏览器整单暂停");
      await page.getByRole("button",{name:"确认追加事件"}).click();

      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await expect(page.getByRole("button",{name:"整单暂停"})).toHaveCount(0);
      await page.getByLabel("原因（必填）").fill("浏览器订单重启");
      await page.getByRole("button",{name:"确认追加事件"}).click();

      await orderRow.getByRole("button",{name:"查看 / 调整"}).click();
      await expect(page.locator(".event-summary b")).toHaveText(["+¥110.00","-¥10.00","-¥100.00","+¥100.00"]);
      await expect(page.getByText(/组长 E2E 账本组长 · 主管 E2E 账本主管/).first()).toBeVisible();
      await page.screenshot({path:testInfo.outputPath("event-chain.png"),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      const dialog=page.getByRole("dialog");
      const dialogBox=await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.x+dialogBox!.width).toBeLessThanOrEqual(390);
      await page.screenshot({path:testInfo.outputPath("event-chain-narrow.png"),fullPage:true});
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(orderRow.getByRole("button",{name:"查看 / 调整"})).toBeFocused();

      await page.setViewportSize({width:1280,height:900});
      await page.getByRole("button",{name:"退出登录"}).click();
      await page.getByLabel("账号").fill("e2e_accounting_leader");
      await page.getByLabel("密码", { exact: true }).fill("Ledger@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      await expect(page.getByRole("heading",{name:"记账治理工作台"})).toBeVisible();
      await page.getByLabel("记账月份").fill("2026-07");
      await page.getByLabel("核对说明").fill("七月数据浏览器核对完成");
      await page.getByRole("button",{name:"提交核对确认"}).click();
      await expect(page.getByText("操作已记录并刷新。")).toBeVisible();

      await page.getByRole("button",{name:"退出登录"}).click();
      await page.getByLabel("账号").fill("e2e_accounting_hr");
      await page.getByLabel("密码", { exact: true }).fill("Ledger@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      await page.getByLabel("记账月份").fill("2026-07");
      await page.getByLabel("关账说明").fill("七月浏览器关账");
      await page.getByRole("button",{name:"关闭记账期间"}).click();
      await expect(page.getByText(/已关闭 · 版本 1/)).toBeVisible();

      await page.getByRole("button",{name:"退出登录"}).click();
      await page.getByLabel("账号").fill("e2e_accounting_leader");
      await page.getByLabel("密码", { exact: true }).fill("Ledger@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      await page.getByLabel("记账月份").fill("2026-07");
      const correctionForm=page.getByRole("heading",{name:"申请关闭月更正"}).locator("..");
      await correctionForm.locator("select").first().selectOption({label:"CHAIN-E2E-110 · 事件链客户"});
      await correctionForm.getByLabel("原业务日期").fill("2026-07-15");
      await correctionForm.getByLabel("发生时标准业务区域").selectOption("CN-JS");
      await correctionForm.getByLabel("发生时来源区域原文").fill("江苏历史凭证");
      await correctionForm.getByLabel("发生时客户单位").fill("事件链历史单位");
      await correctionForm.getByLabel("分析维度证据").fill("原始订单与回款凭证");
      await correctionForm.getByLabel("申请原因").fill("浏览器更正申请");
      await correctionForm.getByRole("button",{name:"提交更正申请"}).click();
      await expect(page.getByText(/CHAIN-E2E-110 · 营业额修改/)).toBeVisible();
      await expect(page.getByText(/江苏历史凭证 · 事件链历史单位 · 证据：原始订单与回款凭证/)).toBeVisible();

      await page.getByRole("button",{name:"退出登录"}).click();
      await page.getByLabel("账号").fill("e2e_accounting_hr");
      await page.getByLabel("密码", { exact: true }).fill("Ledger@123");
      await page.getByRole("button",{name:"进入 SampleFlow"}).click();
      await page.getByRole("button",{name:"订单业绩",exact:true}).click();
      await page.getByLabel("审批意见").fill("同意浏览器更正");
      await page.getByRole("button",{name:"批准",exact:true}).click();
      await expect(page.getByText(/approved/)).toBeVisible();

      const evidence=new Client({connectionString:database.url});await evidence.connect();
      try{
        const result=await evidence.query<{delta_amount:string;order_sequence:number}>(`select e.delta_amount::text,e.order_sequence from performance_events e join performance_orders o on o.id=e.order_id where o.qingflow_order_no='CHAIN-E2E-110' order by e.order_sequence`);
        expect(result.rows.map((row)=>Number(row.delta_amount))).toEqual([110,-10,-100,100]);
        expect(result.rows.map((row)=>row.order_sequence)).toEqual([1,2,3,4]);
      }finally{await evidence.end();}
});
