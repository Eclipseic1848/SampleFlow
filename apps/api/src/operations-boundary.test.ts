import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { withTestDatabase } from "./test-support/test-database.js";

const { Client }=pg;
const execFileAsync=promisify(execFile);
const root=fileURLToPath(new URL("../../../",import.meta.url));
const apiRoot=fileURLToPath(new URL("../",import.meta.url));

test("常驻开发启动不隐式执行历史导入，构建上下文排除原始办公文件",async()=>{
  const [devStart,dockerIgnore,gitIgnore,dockerfile]=await Promise.all([
    readFile(`${root}scripts/dev-start.mjs`,"utf8"),
    readFile(`${root}.dockerignore`,"utf8"),
    readFile(`${root}.gitignore`,"utf8"),
    readFile(`${root}apps/api/Dockerfile`,"utf8"),
  ]);
  assert.doesNotMatch(devStart,/db:import-legacy/);
  assert.match(dockerIgnore,/^\*\.xlsx$/m);
  assert.match(dockerIgnore,/^\*\.docx$/m);
  assert.match(gitIgnore,/^!apps\/web\/public\/SampleFlow标准业绩导入模板\.xlsx$/m);
  assert.doesNotMatch(gitIgnore,/^!apps\/web\/public\/\*\.xlsx$/m);
  assert.doesNotMatch(dockerfile,/\.xlsx|\.docx|原始数据/);
});

test("历史导入命令只接受显式来源，不绑定工作区示例文件",async()=>{
  const source=await readFile(`${apiRoot}src/cli/import-legacy.ts`,"utf8");
  assert.match(source,/--source/);
  assert.doesNotMatch(source,/\.\.\/\.\.\/\.\.\/\.\.\/原始数据1\.xlsx/);
});

test("并发迁移作业共享数据库锁且只应用每个迁移一次",async()=>{
  await withTestDatabase(async(database)=>{
    const run=()=>execFileAsync(process.execPath,["--import","tsx","src/cli/migrate.ts"],{
      cwd:apiRoot,env:{...process.env,DATABASE_URL:database.url,NODE_ENV:"test"},encoding:"utf8",
    });
    const results=await Promise.all([run(),run()]);
    assert.equal(results.length,2);
    const client=new Client({connectionString:database.url});await client.connect();
    try{
      const duplicates=await client.query("select name,count(*) from schema_migrations group by name having count(*)>1");
      assert.equal(duplicates.rowCount,0);
    }finally{await client.end();}
  });
});
