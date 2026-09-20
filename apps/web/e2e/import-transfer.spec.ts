import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strFromU8,strToU8,unzipSync,zipSync } from "fflate";
import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect,test } from "./full-stack.js";

test("组长在导入窗口核对调组日期后入账，不用切换账号",async({database,page})=>{
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{
    // 登录前会话探测返回401是预期行为，其余错误仍使测试失败。
    if(message.type()==="error"&&!(message.location().url.endsWith("/api/auth/me")&&message.text().includes("401 (Unauthorized)")))errors.push(`${message.location().url}: ${message.text()}`);
  });
  await seedTestUser(database.url,{username:"transfer_leader",displayName:"核对组长",password:"Role@123",roleCode:"sales_assistant_leader",roleName:"销售助理组长"});
  const client=new pg.Client({connectionString:database.url});await client.connect();
  try{
    const person=(await client.query("insert into people(display_name,source_key) values('示例业务员','transfer:example') returning id")).rows[0].id;
    const department=(await client.query("insert into org_units(name,unit_type) values('原部门','department') returning id")).rows[0].id;
    const group=(await client.query("insert into org_units(name,unit_type,parent_id) values('原小组','group',$1) returning id",[department])).rows[0].id;
    await client.query("insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$2,'leader','2026-01-01'),($1,$3,'supervisor','2026-01-01')",[person,group,department]);
    await client.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')",[person,department,group]);
    await client.query("update import_configs set status='approved',business_region_mapping='{\"外贸\":\"EXT-TRADE\"}',approved_at=now() where config_key='standard-performance' and version=2");
  }finally{await client.end();}
  const archive=unzipSync(await readFile(new URL("../public/SampleFlow标准业绩导入模板.xlsx",import.meta.url)));
  const xml=strFromU8(archive["xl/worksheets/sheet1.xml"]!);
  archive["xl/worksheets/sheet1.xml"]=strToU8(xml
    .replace(/<c r="A2"[^>]*>.*?<\/c>/,'<c r="A2" t="inlineStr"><is><t>8月</t></is></c>')
    .replace(/<c r="B2"[^>]*>.*?<\/c>/,'<c r="B2" t="inlineStr"><is><t>2026-08-01</t></is></c>'));
  await page.goto("/");await page.getByLabel("账号").fill("transfer_leader");await page.getByLabel("密码",{exact:true}).fill("Role@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();
  await page.getByRole("link",{name:"订单业绩",exact:true}).click();
  await expect(page).toHaveTitle(/SampleFlow/);
  expect(page.url().startsWith(database.webBaseUrl)).toBe(true);
  await page.getByRole("button",{name:"Excel 导入"}).click();
  await page.getByRole("radio",{name:/导入订单业绩/}).check();
  await page.locator('input[type="file"]').setInputFiles({name:"调组验证.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:Buffer.from(zipSync(archive))});
  await page.getByRole("button",{name:"检查文件（暂不入账）"}).click();
  await expect(page.getByRole("heading",{name:"预检未通过"})).toBeVisible();
  await page.getByRole("button",{name:"核对并补齐人员和归属"}).click();
  const setup=page.getByRole("region",{name:"补齐人员与统计归属"});
  await expect(setup.getByText("系统归属：原部门 / 原小组")).toBeVisible();
  const save=setup.getByRole("button",{name:"保存资料并重新检查"});
  await expect(save).toBeDisabled();
  const transferConfirmation=setup.getByRole("checkbox",{name:/我确认调组日期和文件归属正确/});
  await expect(transferConfirmation).toBeDisabled();
  await setup.getByLabel("调组生效日期").fill("2026-08-01");
  await transferConfirmation.check();
  await setup.getByLabel("调组生效日期").fill("2026-08-02");
  await expect(transferConfirmation).not.toBeChecked();
  await setup.getByLabel("调组生效日期").fill("2026-08-01");
  await transferConfirmation.check();
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    await setup.getByRole("heading",{name:"员工已调组？请核对生效日期"}).scrollIntoViewIfNeeded();
    if(width===390)await setup.getByLabel("调组生效日期").scrollIntoViewIfNeeded();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(await page.getByRole("dialog").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await page.screenshot({path:join(tmpdir(),`sampleflow-import-transfer-${width}.png`)});
  }
  await setup.getByRole("checkbox",{name:"我已核对人员身份及统计归属；保存资料不等于入账。"}).check();
  await expect(save).toBeEnabled();await save.click();
  await expect(page.getByRole("heading",{name:"预检通过，等待确认"})).toBeVisible();
  const verify=new pg.Client({connectionString:database.url});await verify.connect();
  try{
    expect((await verify.query("select count(*) from performance_events")).rows[0].count).toBe("0");
    expect((await verify.query("select count(*) from performance_statistical_transfers")).rows[0].count).toBe("1");
  }finally{await verify.end();}
  await page.getByRole("button",{name:"确认整批入账"}).click();
  await expect(page.getByRole("dialog",{name:"Excel 批量导入"})).toBeHidden();
  await expect(page.getByText("001-A",{exact:true})).toBeVisible();
  const ledger=new pg.Client({connectionString:database.url});await ledger.connect();
  try{
    expect((await ledger.query("select group_name,delta_amount::text from performance_events")).rows).toEqual([{group_name:"E2E 销售组",delta_amount:"100.00"}]);
    expect((await ledger.query("select g.name from org_memberships m join org_units g on g.id=m.group_id")).rows).toEqual([{name:"原小组"}]);
  }finally{await ledger.end();}
  expect(errors).toEqual([]);
});
