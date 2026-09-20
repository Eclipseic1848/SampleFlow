import assert from "node:assert/strict";

// 使用项目已安装的 Chromium；不登录系统账号、不改密，也不写业务数据。
export async function checkPublicEntry(origin, credentials) {
  assert.match(origin, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  let stage = "连接公网入口";
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    const failures = [];
    page.on("pageerror", () => failures.push("页面脚本错误"));
    page.on("response", response => {
      if (response.headers()["www-authenticate"] || response.status() >= 500) failures.push("认证弹框或服务错误");
    });
    await page.goto(origin + "/healthz");
    const probe = paths => page.evaluate(async paths => {
      const statuses = [];
      for (const path of paths) statuses.push((await fetch(path, { signal: AbortSignal.timeout(15000) })).status);
      return statuses;
    }, paths);
    assert.deepEqual(await probe(["/", "/api/ready", "/maps/china-provinces.geojson"]), [401, 401, 401]);
    await page.goto(origin + "/?page=orders");
    await page.getByRole("heading", { name: "公网入口验证", exact: true }).waitFor();
    stage = "验证入口表单和系统登录页";
    await page.getByLabel("入口用户名", { exact: true }).fill(credentials.entryUsername);
    await page.getByLabel("入口密码", { exact: true }).fill(credentials.entryPassword);
    await page.getByRole("button", { name: "验证并进入系统" }).click();
    await page.getByRole("heading", { name: "登录系统", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("page"), "orders");
    const cookie = (await context.cookies()).find(value => value.name === "__Host-sampleflow_entry");
    assert.ok(cookie?.secure && cookie?.httpOnly && cookie?.sameSite === "Strict");
    stage = "验证 API 与退出保护";
    try {
      assert.deepEqual(await probe(["/api/auth/me", "/api/ready", "/api/auth/me", "/api/ready"]), [401, 200, 401, 200]);
      await page.reload();
      await page.getByRole("heading", { name: "登录系统", exact: true }).waitFor();
    } finally {
      await page.goto(origin + "/_entry/logout");
      await page.getByRole("button", { name: "退出公网入口", exact: true }).click();
      await page.getByRole("heading", { name: "公网入口验证", exact: true }).waitFor();
    }
    await page.goto(origin + "/healthz");
    assert.deepEqual(await probe(["/api/ready"]), [401]);
    assert.deepEqual(failures, []);
  } catch {
    // 不回显 Playwright 的表单调用日志，避免密码进入控制台。
    throw new Error(`${stage}未通过；请检查网络、现有代理或浏览器连接。未绕过入口、HTTPS 或权限检查。`);
  } finally { await browser.close(); }
}
