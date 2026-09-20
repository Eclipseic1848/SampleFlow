import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { ROLE_POLICIES } from "../../api/src/modules/authorization.js";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect,test } from "./full-stack.js";

test.beforeAll(()=>{process.env.SAMPLEFLOW_ACCEPTANCE_OVERRIDE="enabled-for-customer-uat";});
test.afterAll(()=>{delete process.env.SAMPLEFLOW_ACCEPTANCE_OVERRIDE;});
test("验收专用账号不换登录完成下达、确认和两级审批",async({database,page})=>{
  test.setTimeout(90_000);
  const id=await seedTestUser(database.url,{username:"customer_uat",displayName:"客户验收",password:"Uat@12345",roleCode:"sales_manager",roleName:"销售经理"});
  const client=new pg.Client({connectionString:database.url});await client.connect();
  try{
    for(const [role,policy] of Object.entries(ROLE_POLICIES)){
      await client.query("insert into roles(code,name) values($1,$2) on conflict do nothing",[role,policy.name]);
      await client.query("insert into user_roles(user_id,role_code) values($1,$2) on conflict do nothing",[id,role]);
    }
    await client.query("insert into acceptance_operator(user_id,database_name,expires_at) values($1,current_database(),now()+interval '1 day')",[id]);
  }finally{await client.end();}
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/");await page.getByLabel("账号",{exact:true}).fill("customer_uat");await page.getByLabel("密码",{exact:true}).fill("Uat@12345");
  await page.getByRole("button",{name:"进入 SampleFlow"}).click();
  await expect(page.getByText("验收专用账号：允许跨角色办理及自行审批，所有操作真实生效。正式交付前必须关闭验收例外。")).toBeVisible();
  await page.getByRole("link",{name:"目标管理",exact:true}).click();await page.getByRole("button",{name:"下达目标",exact:true}).click();
  await page.getByLabel("目标月份").fill("2026-09");await expect(page.getByLabel("目标责任人")).toBeEnabled();await page.getByLabel("目标金额").fill("1000");
  await page.getByRole("button",{name:"提交待确认"}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button",{name:"确认目标",exact:true}).click();await expect(page.getByRole("dialog")).toContainText("验收专用账号代操作");
  await page.getByRole("dialog").getByRole("button",{name:"确认目标",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  for(const stage of ["总经理","人事"]){
    await page.getByRole("button",{name:"批准",exact:true}).click();await page.getByLabel("审批意见").fill(`验收${stage}审批`);
    await page.getByRole("button",{name:"确认批准",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(page.getByRole("button",{name:"查看正式报表"})).toBeVisible();
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:800});
    await page.screenshot({path:join(tmpdir(),`sampleflow-uat-${width}.png`)});
    expect(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>e.className)}))).toMatchObject({width,scroll:width});
  }
  expect(errors).toEqual([]);
});
