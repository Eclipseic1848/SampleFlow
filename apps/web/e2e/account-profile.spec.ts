import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

test("账号表格列宽不随搜索内容变化且操作按钮固定排列", async ({database,page})=>{
  await seedTestUser(database.url,{username:"layout_admin",displayName:"布局管理员",password:"Layout@123",roleCode:"system_admin",roleName:"系统管理员"});
  const users=[{id:"9001",username:"long_account_".repeat(7),displayName:"用于验证长姓名不会挤压操作列的人员",isActive:true,mustChangePassword:false,roles:["general_manager","hr","sales_assistant","sales_assistant_leader","sales_leader","sales_manager","salesperson","sales_supervisor","system_admin"]},{id:"9002",username:"short_account",displayName:"短姓名",isActive:false,mustChangePassword:false,roles:["salesperson"]}];
  await page.route("**/api/admin/users?*",route=>{const search=new URL(route.request().url()).searchParams.get("search");const rows=search?users.slice(1):users;return route.fulfill({json:{users:rows,totalCount:rows.length,roles:[],permissionMatrix:[]}});});
  await page.goto("/?page=accounts");
  await page.getByLabel("账号",{exact:true}).fill("layout_admin");
  await page.getByLabel("密码",{exact:true}).fill("Layout@123");
  await page.getByRole("button",{name:"进入 SampleFlow"}).click();
  const table=page.locator(".accounts-table");
  for(const width of [1024,1280,1920]){
    await page.setViewportSize({width,height:900});
    await page.getByRole("searchbox",{name:"搜索账号"}).fill("");
    await expect(table.locator("tbody tr")).toHaveCount(2);
    const columns=await table.locator("th").evaluateAll(cells=>cells.map(cell=>cell.getBoundingClientRect().width));
    expect(columns.slice(3)).toEqual([80,400]);
    const tableWidth=await table.evaluate(element=>element.getBoundingClientRect().width);
    expect(columns[0]).toBeCloseTo(tableWidth*0.20,1);
    expect(columns[1]).toBeCloseTo(tableWidth*0.15,1);
    if(width>=1280) expect(await table.locator("..").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    for(const row of await table.locator("tbody tr").all()){
      const positions=await row.locator(".table-action").evaluateAll(buttons=>buttons.map(button=>{const rect=button.getBoundingClientRect();return{x:rect.x,y:rect.y,width:rect.width,right:rect.right,bottom:rect.bottom};}));
      expect(positions.map(button=>button.width)).toEqual([68,68,68,68,68]);
      expect(new Set(positions.map(button=>button.y)).size).toBe(1);
      for(let i=1;i<positions.length;i++) expect(positions[i]!.x-positions[i-1]!.right).toBe(6);
      expect(await row.locator("td").evaluateAll(cells=>cells.every(cell=>cell.scrollWidth<=cell.clientWidth+1))).toBe(true);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:join(tmpdir(),`sampleflow-account-columns-${width}.png`)});
    if(width===1024){
      const scroller=table.locator("..");
      await scroller.focus();
      await page.keyboard.press("End");
      await scroller.evaluate(element=>{element.scrollLeft=element.scrollWidth;});
      const lastAction=table.locator("tbody tr").first().getByRole("button",{name:"删除账号"});
      await expect(lastAction).toBeInViewport();
      await page.screenshot({path:join(tmpdir(),"sampleflow-account-columns-1024-actions.png")});
    }
    await page.getByRole("searchbox",{name:"搜索账号"}).fill("short_account");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    expect(await table.locator("th").evaluateAll(cells=>cells.map(cell=>cell.getBoundingClientRect().width))).toEqual(columns);
  }
});

test("账号资料可编辑且删除需要确认并修正末页分页", async ({ database, page }) => {
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  for(const [username,role] of [["profile_admin","system_admin"],...Array.from({length:9},(_,i)=>[`profile_other_${i}`,"salesperson"]),["profile_target","salesperson"]]){
    await seedTestUser(database.url,{username:username!,displayName:username==="profile_target"?"原姓名":username!,password:"Profile@123",roleCode:role!,roleName:role!});
  }
  await page.goto("/?page=accounts");
  await page.getByLabel("账号",{exact:true}).fill("profile_admin");
  await page.getByLabel("密码",{exact:true}).fill("Profile@123");
  await page.getByRole("button",{name:"进入 SampleFlow"}).click();
  await expect(page).toHaveTitle("账号管理 — SampleFlow");
  await expect(page.getByRole("heading",{name:"账号管理",exact:true})).toBeVisible();
  await page.getByRole("searchbox",{name:"搜索账号"}).fill("profile_target");
  let row=page.getByRole("row").filter({hasText:"profile_target"});
  await row.getByRole("button",{name:"编辑资料"}).click();
  let dialog=page.getByRole("dialog",{name:"编辑账号资料"});
  await dialog.getByLabel("账号",{exact:true}).fill("PROFILE_ADMIN");
  await dialog.getByRole("button",{name:"保存资料"}).click();
  await expect(dialog.getByRole("alert")).toContainText("账号名已存在");
  await dialog.getByLabel("账号",{exact:true}).fill("profile_updated");
  await dialog.getByLabel("姓名",{exact:true}).fill("修改后姓名");
  await dialog.getByRole("button",{name:"保存资料"}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("没有符合条件的账号。",{exact:true})).toBeVisible();
  await page.getByRole("searchbox",{name:"搜索账号"}).fill("修改后姓名");
  row=page.getByRole("row").filter({hasText:"profile_updated"});
  await expect(row).toContainText("修改后姓名");
  await page.setViewportSize({width:1024,height:800});
  await row.getByRole("button",{name:"删除账号",exact:true}).click();
  dialog=page.getByRole("dialog",{name:"确认删除账号"});
  await expect(dialog.getByRole("button",{name:"确认删除账号"})).toBeDisabled();
  await dialog.getByRole("button",{name:"取消",exact:true}).click();
  await expect(row).toBeVisible();
  await page.getByRole("button",{name:"清除账号搜索"}).click();
  await page.getByRole("navigation",{name:"账号分页"}).getByRole("button",{name:"下一页"}).click();
  await expect(page.getByRole("navigation",{name:"账号分页"})).toContainText("第 2 / 2 页");
  await row.getByRole("button",{name:"删除账号",exact:true}).click();
  await dialog.getByLabel("输入完整账号名确认删除").fill("profile_updated");
  await page.screenshot({path:join(tmpdir(),"sampleflow-account-delete.png")});
  await dialog.getByRole("button",{name:"确认删除账号"}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("navigation",{name:"账号分页"})).toContainText("共 10 条 · 第 1 / 1 页");
  await expect(page.getByRole("row").filter({hasText:"profile_admin"}).getByRole("button",{name:"删除账号",exact:true})).toBeDisabled();
  await page.getByRole("searchbox",{name:"搜索账号"}).fill("profile_updated");
  await expect(page.getByText("没有符合条件的账号。",{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
