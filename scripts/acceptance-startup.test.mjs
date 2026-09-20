import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ensureDocker, isPublicUrl, isPublishedState, ownsTunnel, serviceRecoveryArgs, serviceStartArgs, startupLock, tunnelReady, waitUntil } from "./acceptance.mjs";

test("Docker 未启动时调用后台启动并等待；已运行不重启，超时不报成功", async () => {
  const calls = [];
  let running = false;
  const run = (program, args) => {
    calls.push([program, ...args]);
    if (args[0] === "info") { if (!running) throw new Error("尚未启动"); return "linux\n"; }
    running = true;
    return "";
  };
  await ensureDocker(run, (check, timeout, message) => waitUntil(check, 50, message, 1));
  assert.equal(calls.filter(args => args.includes("desktop")).length, 1);
  assert.deepEqual(calls[1], ["docker", "desktop", "start", "--detach", "--timeout", "30"]);
  await ensureDocker(run);
  assert.equal(calls.filter(args => args.includes("desktop")).length, 1);
  await assert.rejects(ensureDocker(() => "", (check, timeout, message) => waitUntil(check, 3, message, 1)), /Docker Desktop 启动超时/);
});

test("陈旧 PID 不能误杀其他程序、其他端口或新进程", () => {
  const state = { pid: 123, startedAt: "2026-09-04T01:00:00Z" };
  const process = { executable: "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", commandLine: 'cloudflared tunnel --url "http://127.0.0.1:18080" --no-autoupdate', startedAt: state.startedAt };
  assert.equal(ownsTunnel(state, process), true);
  assert.equal(ownsTunnel(state, null), false);
  assert.equal(ownsTunnel({ pid: -1 }, process), false);
  assert.equal(ownsTunnel(state, { ...process, executable: "C:\\other.exe" }), false);
  assert.equal(ownsTunnel(state, { ...process, startedAt: "2026-09-04T02:00:00Z" }), false);
  for (const url of ["180800", "18080/other", "18081"]) {
    assert.equal(ownsTunnel(state, { ...process, commandLine: `cloudflared --url http://127.0.0.1:${url}` }), false);
  }
});

test("重复点击互斥，退出后可立即再次启动", async () => {
  const first = await startupLock(0);
  const port = first.address().port;
  try { await assert.rejects(startupLock(port), /已有启动／停止操作/); }
  finally { await new Promise(resolve => first.close(resolve)); }
  const next = await startupLock(port);
  await new Promise(resolve => next.close(resolve));
});

test("隧道进程存活不等于公网连接就绪，拒绝外部 metrics 地址", async () => {
  let status = 503;
  let connections = 0;
  const server = createServer((request, response) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ readyConnections: connections })); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const state = { metrics: `http://127.0.0.1:${server.address().port}` };
  try {
    assert.equal(await tunnelReady(state), false);
    status = 200;
    assert.equal(await tunnelReady(state), false);
    connections = 1;
    assert.equal(await tunnelReady(state), true);
    assert.equal(await tunnelReady({ metrics: "https://example.com" }), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await tunnelReady(state), false);
});

test("启动检查有超时，失败不能报成功；网址只允许 Quick Tunnel HTTPS", async () => {
  let calls = 0;
  assert.equal(await waitUntil(() => ++calls === 2 && "ready", 100, "超时", 1), "ready");
  await assert.rejects(waitUntil(() => false, 3, "超时", 1), /超时/);
  assert.equal(isPublicUrl("https://some-name.trycloudflare.com"), true);
  for (const value of ["http://some-name.trycloudflare.com", "https://some-name.trycloudflare.com.evil.test", "https://some-name.trycloudflare.com/'", "正在恢复", undefined]) assert.equal(isPublicUrl(value), false);
  const url = "https://some-name.trycloudflare.com";
  assert.equal(isPublishedState({ url }, url), false);
  assert.equal(isPublishedState({ url, verifiedAt: "2026-09-04T10:00:00Z" }, "正在恢复"), false);
  assert.equal(isPublishedState({ url, verifiedAt: "2026-09-04T10:00:00Z" }, url), true);
});

test("普通启动只复用既有镜像和数据；恢复服务不重建数据库", () => {
  for (const args of [serviceStartArgs, serviceRecoveryArgs]) {
    assert.ok(args.includes("--no-build"));
    assert.equal(args[args.indexOf("--pull") + 1], "never");
    assert.equal(args.some(value => /^(?:build|down|run|init|db-migrate|admin-bootstrap)$/.test(value)), false);
  }
  assert.ok(serviceRecoveryArgs.includes("--no-deps"));
  assert.equal(serviceRecoveryArgs.includes("db"), false);
  const source = readFileSync(new URL("./acceptance.mjs", import.meta.url), "utf8");
  assert.match(source, /detached: true, windowsHide: true, stdio: "ignore"/);
  assert.match(source, /"tunnel", "--protocol", "http2"/);
  assert.match(source, /await checkPublicEntry\(state.url, credentials\);[\s\S]*save\(urlFile, state.url/);
  assert.doesNotMatch(source, /--no-tls-verify|NODE_TLS_REJECT_UNAUTHORIZED|taskkill/);
});
