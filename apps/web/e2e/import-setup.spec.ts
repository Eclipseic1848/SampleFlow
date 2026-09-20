import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect,test } from "./full-stack.js";

for (const continuation of [false,true]) test(`销售助理组长在导入窗口补齐统计资料并无负责人入账${continuation?"（Excel 续导）":""}`,async({database,page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await seedTestUser(database.url,{username:"setup_leader",displayName:"补齐组长",password:"Role@123",roleCode:"sales_assistant_leader",roleName:"销售助理组长"});
  const client=new pg.Client({connectionString:database.url});await client.connect();
  try{
    await client.query("update import_configs set status='approved',business_region_mapping='{\"外贸\":\"EXT-TRADE\"}',approved_at=now() where config_key='standard-performance' and version=2");
    if(continuation) await client.query(`insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,required_columns,allowed_event_types,business_region_mapping,fixed_event_type,allow_legacy_source_key,approved_at)
      select 'excel-ledger-continuation',1,'Excel 流水续导','approved',sheet_name,expected_headers,column_mapping-'sourceRecordId',required_columns,'["legacy_adjustment"]',business_region_mapping,'legacy_adjustment',true,now()
      from import_configs where config_key='standard-performance' and version=2`);
  }finally{await client.end();}
  await page.goto("/");await page.getByLabel("账号").fill("setup_leader");await page.getByLabel("密码",{exact:true}).fill("Role@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();
  await page.getByRole("link",{name:"订单业绩",exact:true}).click();await page.getByRole("button",{name:"Excel 导入"}).click();
  if(!continuation){
    await page.getByRole("radio",{name:/接着导入 Excel 业绩流水/}).check();
    await expect(page.getByText(/使用系统固定规则，无需申请或人事审批/)).toBeVisible();
    await expect(page.getByRole("button",{name:"检查文件（暂不入账）"})).toBeDisabled();
    await page.getByRole("radio",{name:/导入订单业绩/}).check();
  }
  if(continuation){
    await page.getByRole("radio",{name:/接着导入 Excel 业绩流水/}).check();
    await expect(page.getByLabel("导入模板类型")).toHaveCount(0);
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      await page.getByRole("radio",{name:/接着导入 Excel 业绩流水/}).scrollIntoViewIfNeeded();
      await page.screenshot({path:join(tmpdir(),`sampleflow-continuation-choice-${width}.png`)});
      expect(await page.getByRole("dialog").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    }
    await expect(page.getByText(/不要合并同一订单的多行/)).toBeVisible();
  }
  await page.locator('input[type="file"]').setInputFiles(fileURLToPath(new URL("../public/SampleFlow标准业绩导入模板.xlsx",import.meta.url)));
  await page.getByRole("button",{name:"检查文件（暂不入账）"}).click();
  await expect(page.getByRole("heading",{name:"预检未通过"})).toBeVisible();
  await page.getByRole("button",{name:"核对并补齐人员和归属"}).click();
  const setup=page.getByRole("region",{name:"补齐人员与统计归属"});
  await expect(setup.getByLabel("统计部门",{exact:true})).toHaveValue("E2E 销售部");
  await expect(setup.getByLabel("统计小组",{exact:true})).toHaveValue("E2E 销售组");
  await expect(setup.getByRole("button",{name:"保存资料并重新检查"})).toBeDisabled();
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});await setup.scrollIntoViewIfNeeded();
    await page.screenshot({path:join(tmpdir(),`sampleflow-statistical-setup-${continuation?"continuation-":""}${width}.png`)});
    const overflow=await page.getByRole("dialog").evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth,children:[...element.querySelectorAll("*")].filter(child=>child.getBoundingClientRect().right>element.getBoundingClientRect().right).slice(0,6).map(child=>({tag:child.tagName,className:child.className,width:child.getBoundingClientRect().width}))}));
    expect(overflow.scroll<=overflow.width,JSON.stringify({width,...overflow})).toBe(true);
  }
  await setup.getByRole("checkbox").check();await setup.getByRole("button",{name:"保存资料并重新检查"}).click();
  await expect(page.getByRole("heading",{name:"预检通过，等待确认"})).toBeVisible();
  if(continuation){
    await expect(page.getByRole("button",{name:"确认整批入账"})).toBeDisabled();
    await page.getByRole("checkbox",{name:"我已核对并确认此条警告"}).check();
  }
  await expect(page.getByRole("button",{name:"确认整批入账"})).toBeEnabled();
  const verify=new pg.Client({connectionString:database.url});await verify.connect();
  try{expect((await verify.query("select count(*) from performance_events")).rows[0].count).toBe("0");}finally{await verify.end();}
  await page.getByRole("button",{name:"确认整批入账"}).click();
  await expect(page.getByRole("dialog",{name:"Excel 批量导入"})).toBeHidden();await expect(page.getByText("001-A",{exact:true})).toBeVisible();
  const ledger=new pg.Client({connectionString:database.url});await ledger.connect();
  try{
    const events=await ledger.query("select event_type,delta_amount::text from performance_events");
    expect(events.rows).toEqual([{event_type:continuation?"legacy_adjustment":"initial",delta_amount:"100.00"}]);
  }finally{await ledger.end();}
  expect(errors).toEqual([]);
});
