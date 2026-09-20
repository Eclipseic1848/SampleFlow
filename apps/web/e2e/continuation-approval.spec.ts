import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect,test } from "./full-stack.js";

for (const role of ["sales_assistant_leader","sales_assistant"] as const) test(`Excel 续导无需人事审批，${role}在同一窗口完成本角色操作`,async({database,page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await seedTestUser(database.url,{username:"continuation_user",displayName:"续导操作员",password:"Role@123",roleCode:role,roleName:role});
  const client=new pg.Client({connectionString:database.url});await client.connect();
  try{
    await client.query("update import_configs set business_region_mapping='{\"外贸\":\"EXT-TRADE\"}' where config_key='standard-performance' and version=2");
    expect((await client.query("select count(*) from import_configs where config_key='excel-ledger-continuation'")).rows[0].count).toBe("0");
    await page.goto("/");await page.getByLabel("账号").fill("continuation_user");await page.getByLabel("密码",{exact:true}).fill("Role@123");await page.getByRole("button",{name:"进入 SampleFlow"}).click();
    await page.getByRole("link",{name:"订单业绩",exact:true}).click();await page.getByRole("button",{name:"Excel 导入"}).click();
    await page.getByRole("radio",{name:/接着导入 Excel 业绩流水/}).check();
    await expect(page.getByText("使用系统固定规则，无需申请或人事审批。检查不会入账，销售助理组长核对结果后再确认。",{exact:true})).toBeVisible();
    await expect(page.getByLabel("导入模板类型")).toHaveCount(0);
    await expect(page.getByRole("button",{name:/提交续导规则|批准续导规则/})).toHaveCount(0);
    await page.locator('input[type="file"]').setInputFiles(fileURLToPath(new URL("../public/SampleFlow标准业绩导入模板.xlsx",import.meta.url)));
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      await page.getByRole("radio",{name:/接着导入 Excel 业绩流水/}).scrollIntoViewIfNeeded();
      await page.screenshot({path:join(tmpdir(),`sampleflow-continuation-direct-${role}-${width}.png`)});
      expect(await page.getByRole("dialog").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    }
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole("button",{name:"检查文件（暂不入账）"}).click();
    await expect(page.getByRole("heading",{name:"预检未通过"})).toBeVisible();
    expect((await client.query("select created_by,approved_by from import_configs where config_key='excel-ledger-continuation'")).rows).toEqual([{created_by:null,approved_by:null}]);
    expect((await client.query("select count(*) from performance_events")).rows[0].count).toBe("0");
    if(role==="sales_assistant_leader"){
      await page.getByRole("button",{name:"核对并补齐人员和归属"}).click();
      const setup=page.getByRole("region",{name:"补齐人员与统计归属"});await setup.getByRole("checkbox").check();await setup.getByRole("button",{name:"保存资料并重新检查"}).click();
      await expect(page.getByRole("heading",{name:"预检通过，等待确认"})).toBeVisible();
      await expect(page.getByRole("button",{name:"确认整批入账"})).toBeDisabled();
      await page.getByRole("checkbox",{name:"我已核对并确认此条警告"}).check();
      await page.getByRole("button",{name:"确认整批入账"}).click();
      await expect(page.getByRole("dialog",{name:"Excel 批量导入"})).toBeHidden();
      expect((await client.query("select event_type,delta_amount::text from performance_events")).rows).toEqual([{event_type:"legacy_adjustment",delta_amount:"100.00"}]);
    }else{
      await expect(page.getByRole("button",{name:"确认整批入账"})).toHaveCount(0);
      await expect(page.getByText(/缺少人员或统计归属时，请由销售助理组长补齐并确认/)).toBeVisible();
    }
    expect(errors).toEqual([]);
  }finally{await client.end();}
});
