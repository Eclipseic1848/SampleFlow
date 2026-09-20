import pg from "pg";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect,test } from "./full-stack.js";

test("空表单可选人员，切换历史日期保留选择并按统计归属入账",async({database,page})=>{
  const user=await seedTestUser(database.url,{username:"people_editor",displayName:"录入助理",password:"People@123",roleCode:"sales_assistant",roleName:"销售助理"});
  const client=new pg.Client({connectionString:database.url});await client.connect();
  try{
    const person=(await client.query("insert into people(display_name,source_key) values('历史统计业务员','people-test') returning id::text")).rows[0].id;
    const department=(await client.query("insert into org_units(name,unit_type) values('统计部门','department') returning id")).rows[0].id;
    const group=(await client.query("insert into org_units(name,unit_type,parent_id) values('统计小组','group',$1) returning id",[department])).rows[0].id;
    const batch=(await client.query(`insert into import_batches(config_id,source_file_name,source_sha256,source_bytes,status,uploaded_by,row_count,order_count,event_count,total_amount,reconciliation_summary)
      select id,'fixture.xlsx',repeat('a',64),decode('00','hex'),'blocked',$1,0,0,0,0,'{}' from import_configs limit 1 returning id`,[user])).rows[0].id;
    await client.query("insert into performance_statistical_assignments(person_id,occurred_on,department_id,group_id,batch_id,created_by) values($1,'2026-08-27',$2,$3,$4,$5)",[person,department,group,batch,user]);
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/');await page.getByLabel('账号',{exact:true}).fill('people_editor');await page.getByLabel('密码',{exact:true}).fill('People@123');await page.getByRole('button',{name:'进入 SampleFlow'}).click();
    await page.getByRole('link',{name:'订单业绩',exact:true}).click();await page.getByRole('button',{name:'录入新订单'}).click();
    const dialog=page.getByRole('dialog',{name:'录入订单业绩'}),select=dialog.getByLabel('业务员',{exact:true});
    await expect(select.locator('option',{hasText:'历史统计业务员'})).toHaveCount(1);
    await expect(dialog.getByLabel('客户姓名')).toHaveValue('');await select.selectOption(person);
    await dialog.getByLabel('日期',{exact:true}).fill('2026-08-27');await expect(select).toHaveValue(person);await expect(dialog.getByText('统计部门 / 统计小组',{exact:true})).toBeVisible();
    const response=await page.request.get('/api/performance/people?occurredOn=2026-08-27');expect(response.status()).toBe(200);expect((await response.json()).people.find((p:{id:string})=>p.id===person).organizationAvailable).toBe(true);
    await dialog.getByLabel('日期',{exact:true}).fill('2026-08-26');await expect(select).toHaveValue(person);await expect(dialog.getByText('该日期缺少唯一的业绩归属',{exact:false})).toBeVisible();
    const csrf=(await page.context().cookies()).find(cookie=>cookie.name==='sampleflow_csrf')!;
    const blocked=await page.request.post('/api/performance/orders',{headers:{origin:database.webBaseUrl,'x-csrf-token':decodeURIComponent(csrf.value)},data:{orderNo:'BLOCKED-MISSING-ORG',customerName:'测试客户',customerUnit:'测试单位',businessRegionCode:'CN-FJ',businessRegionSourceText:'福建省',salespersonPersonId:person,sourceReceivedOn:'2026-08-26',amount:100,reason:'回归验证'}});
    expect(blocked.status()).toBe(409);expect((await client.query("select count(*) from performance_orders where qingflow_order_no='BLOCKED-MISSING-ORG'")).rows[0].count).toBe('0');
    await dialog.getByLabel('日期',{exact:true}).fill('');await expect(select.locator('option',{hasText:'历史统计业务员'})).toHaveCount(1);
    await page.route('**/api/performance/people*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"message":"测试加载失败"}'}),{times:1});
    await dialog.getByLabel('日期',{exact:true}).fill('2026-08-27');await expect(dialog.getByText('测试加载失败',{exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:'重新加载业务员'}).click();await expect(dialog.getByText('测试加载失败',{exact:true})).toHaveCount(0);await expect(dialog.getByText('统计部门 / 统计小组',{exact:true})).toBeVisible();
    await dialog.getByLabel('订单编号',{exact:false}).fill('PEOPLE-REGRESSION-001');await dialog.getByLabel('客户姓名').fill('测试客户');await dialog.getByLabel('客户单位',{exact:true}).fill('测试单位');await dialog.getByLabel('省份',{exact:true}).selectOption('CN-FJ');await dialog.getByLabel('系统营业额').fill('100');
    for(const width of [1280,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:join(tmpdir(),`sampleflow-order-people-${width}.png`)});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
    await dialog.getByRole('button',{name:'确认入账'}).click();await expect(dialog).toHaveCount(0);
    const order=(await client.query("select salesperson_person_id::text,current_revenue from performance_orders where qingflow_order_no='PEOPLE-REGRESSION-001'")).rows[0];expect(order.salesperson_person_id).toBe(person);expect(order.current_revenue).toBe('100.00');
    expect(errors).toEqual([]);
  }finally{await client.end();}
});
