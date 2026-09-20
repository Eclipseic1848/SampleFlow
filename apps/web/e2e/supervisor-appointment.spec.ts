import pg from "pg";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect,test } from "./full-stack.js";

test("部门主管无需选择小组，成员表单仍保留小组选择",async({database,page})=>{
  await seedTestUser(database.url,{username:"appointment_admin",displayName:"任职管理员",password:"Role@123",roleCode:"system_admin",roleName:"系统管理员"});
  const client=new pg.Client({connectionString:database.url});await client.connect();
  try{
    const personId=(await client.query("insert into people(display_name,source_key) values('跨组主管','supervisor-ui') returning id::text")).rows[0].id;
    const departmentId=(await client.query("insert into org_units(name,unit_type) values('跨组测试部门','department') returning id::text")).rows[0].id;
    await client.query("insert into org_units(name,unit_type,parent_id) values('甲组','group',$1),('乙组','group',$1)",[departmentId]);
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/');await page.getByLabel('账号',{exact:true}).fill('appointment_admin');await page.getByLabel('密码',{exact:true}).fill('Role@123');await page.getByRole('button',{name:'进入 SampleFlow'}).click();
    await page.getByRole('link',{name:'组织架构',exact:true}).click();await page.getByRole('button',{name:'新增任职',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'新增人员任职'});
    await expect(dialog.getByRole('combobox',{name:'小组',exact:true})).toBeVisible();
    const supervisor=dialog.getByRole('combobox',{name:'部门主管',exact:true});
    await dialog.getByRole('searchbox',{name:'搜索部门主管'}).fill('跨组');
    await expect(supervisor.locator('option')).toHaveCount(2);
    await supervisor.selectOption(personId);
    await dialog.getByRole('searchbox',{name:'搜索部门主管'}).fill('不存在的人员');
    await expect(supervisor).toHaveValue(personId);
    await expect(dialog.getByText('没有匹配人员，请更换关键词；已选人员保留')).toBeVisible();
    await expect(dialog.getByRole('combobox',{name:'小组负责人',exact:true}).locator('option')).toHaveCount(3);
    await dialog.getByRole('searchbox',{name:'搜索部门主管'}).fill('APPOINTMENT_ADMIN');
    await expect(supervisor.locator('option')).toHaveCount(3);
    await dialog.getByRole('searchbox',{name:'搜索部门主管'}).press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox',{name:'任职类型',exact:true}).selectOption('supervisor');
    await expect(dialog.getByRole('combobox',{name:'小组',exact:true})).toHaveCount(0);
    await expect(dialog.getByRole('combobox',{name:'小组负责人',exact:true})).toHaveCount(0);
    await dialog.getByRole('combobox',{name:'任职人员',exact:true}).selectOption(personId);await dialog.getByRole('combobox',{name:'部门',exact:true}).selectOption(departmentId);await dialog.getByLabel('生效日期').fill('2020-01-01');
    await dialog.getByRole('searchbox',{name:'搜索任职人员'}).fill('跨组');
    await expect(dialog.getByRole('combobox',{name:'任职人员',exact:true}).locator('option')).toHaveCount(2);
    await page.screenshot({path:join(tmpdir(),'sampleflow-person-search-1280.png')});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(tmpdir(),'sampleflow-person-search-390.png')});
    await expect(dialog.getByRole('button',{name:'保存任职',exact:true})).toBeInViewport();
    await dialog.getByRole('button',{name:'保存任职',exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(page.getByText('跨组测试部门 · 部门主管',{exact:true})).toBeVisible();
    expect((await client.query('select count(*)::int n from org_memberships where person_id=$1',[personId])).rows[0].n).toBe(0);
    expect((await client.query('select count(*)::int n from org_responsibilities where person_id=$1 and org_unit_id=$2',[personId,departmentId])).rows[0].n).toBe(1);
    expect(errors).toEqual([]);
  }finally{await client.end();}
});
