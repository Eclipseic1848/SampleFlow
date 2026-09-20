import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "../apps/web/node_modules/vite/dist/node/index.js";
import { chromium } from "playwright";

test("月度趋势的十二个数据点、月份和提示框在不同宽度下对齐", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../apps/web", import.meta.url)), server: { host: "127.0.0.1", port: 0 } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    // 直接挂载真实总览组件，使用合成数据，不连接客户数据库或账号。
    await page.route("**/__trend-check", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>月度趋势对齐验证</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import '/src/styles.css';
      const {Overview}=await import('/src/pages/overview-page.tsx');
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Overview,{canEdit:false,canExport:false,onEnterOrders:()=>{}}));
    </script></body></html>` }));
    await page.route("**/api/performance/dashboard", route => route.fulfill({ json: {
      month: "2026-09", metrics: { total: "100", eventCount: 12, negativeTotal: "-50", pendingApprovals: 0 },
      monthly: Array.from({ length: 12 }, (_, index) => ({ month: `2026-${String(index + 1).padStart(2, "0")}`, total: String(index === 0 ? -50 : index * 100) })),
      groups: [], recent: [], personalAchievement: null, groupAchievements: [], departmentAchievements: [], salesAchievement: null,
    } }));
    await page.goto(server.resolvedUrls.local[0] + "__trend-check");
    await page.getByRole("heading", { name: "月度业绩趋势" }).waitFor({timeout:10000});
    for (const width of [1024, 1280, 1920, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (let index = 0; index < 12; index++) {
        const point = page.locator(".trend-point").nth(index);
        const label = page.locator(".chart-labels span").nth(index);
        const [dot, month] = await Promise.all([point.boundingBox(), label.boundingBox()]);
        assert.ok(dot && month);
        assert.ok(Math.abs(dot.x + dot.width / 2 - month.x - month.width / 2) < 1, `${width}px 下 ${index + 1} 月错位`);
      }
      const point = page.locator('.trend-point[data-month="5月"]');
      await point.focus();
      const tooltip = page.getByRole("tooltip");
      assert.equal(await tooltip.textContent(), "5月 ¥400.00");
      const dot = await point.boundingBox(), tip = await tooltip.boundingBox();
      assert.ok(Math.abs(dot.x + dot.width / 2 - tip.x - tip.width / 2) < 1);
      assert.ok(tip.y + tip.height < dot.y);
      if (process.env.TREND_SCREENSHOT && width === 1280) await page.locator(".trend-panel").screenshot({ path: process.env.TREND_SCREENSHOT });
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
  } finally {
    await browser?.close();
    await server.close();
  }
});
