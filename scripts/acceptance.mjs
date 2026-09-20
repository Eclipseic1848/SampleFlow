import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { checkEntry, entryNginx } from "./acceptance-gate.mjs";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { checkPublicEntry } from "./acceptance-browser-check.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, ".sampleflow", "acceptance");
const environmentFile = join(root, ".env.acceptance.local");
const credentialsFile = join(directory, "credentials.json");
const stateFile = join(directory, "tunnel-state.json");
const cloudflared = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
const composeArgs = ["compose", "-p", "sampleflow-acceptance", "--env-file", environmentFile,
  "-f", "docker-compose.yml", "-f", "docker-compose.acceptance.yml"];
const urlFile = join(directory, "url.txt");
const localOrigin = "http://127.0.0.1:18080";

function command(program, args, options = {}) {
  try {
    return execFileSync(program, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 210000, stdio: ["pipe", "pipe", "pipe"], ...options });
  } catch {
    throw new Error(`${program} 执行失败；为防止泄露凭据，不回显命令输出。`);
  }
}
function compose(args) { return command("docker", [...composeArgs, ...args]); }
function save(path, content) { writeFileSync(path, content, { encoding: "utf8", mode: 0o600 }); }
function secure(path) {
  const identity = command("whoami", []).trim();
  command("icacls", [path, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
}
function localDocker() {
  const context = process.env.DOCKER_CONTEXT || command("docker", ["context", "show"]).trim();
  const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
    ? process.env.DOCKER_HOST : command("docker", ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]).trim();
  assert.match(endpoint, /^npipe:\/\//, "验收脚本只允许本机 Windows Docker，不允许远程 endpoint。");
}
function configureNginx() {
  const credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
  const salt = randomBytes(16).toString("hex");
  const origins = readFileSync(environmentFile, "utf8").match(/^APP_ORIGINS=(.+)$/m)?.[1].trim().split(",");
  assert.ok(origins?.length, "缺少公网 Origin");
  save(join(directory,"entry-config.json"), JSON.stringify({username:credentials.entryUsername,passwordSalt:salt,passwordHash:scryptSync(credentials.entryPassword,salt,64).toString("hex"),csrfKey:randomBytes(32).toString("hex"),origins:[...origins,"http://127.0.0.1:18080"]}));
  // 只在验收覆盖配置添加保护；原始 Web 配置和业务逻辑不变。
  save(join(directory, "nginx.conf"), entryNginx(readFileSync(join(root,"apps/web/nginx.conf"),"utf8")));
}
async function check(origin, credentials) {
  await checkEntry(origin,credentials);
  console.log(`访问保护与就绪检查通过：${origin}`);
}

export const isPublicUrl = value => typeof value === "string" && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(value);
export const isPublishedState = (state, url) => isPublicUrl(state?.url) && state.url === url && Number.isFinite(Date.parse(state.verifiedAt));
export function ownsTunnel(state, details) {
  return Number.isSafeInteger(state?.pid) && state.pid > 0 && Boolean(details)
    && details.executable?.toLowerCase() === cloudflared.toLowerCase()
    && /(?:^|\s)--url\s+"?http:\/\/127\.0\.0\.1:18080"?(?:\s|$)/.test(details.commandLine ?? "")
    && (!state.startedAt || state.startedAt === details.startedAt);
}
function processDetails(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "进程记录无效，拒绝操作。");
  const value = command("powershell.exe", ["-NoProfile", "-Command", `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ executable=$p.ExecutablePath; commandLine=$p.CommandLine; startedAt=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`], { timeout: 15000 }).trim();
  return value ? JSON.parse(value) : null;
}
function readState() { return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null; }
export async function startupLock(port = 18081) {
  // ponytail: 本机单实例启动锁；进程退出或电脑重启后由系统释放，不留下陈旧文件锁。
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("已有启动／停止操作正在执行，或本机 18081 锁端口被占用；请稍后重试，不要重复点击。")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return server;
}
export async function tunnelReady(state) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(state?.metrics ?? "")) return false;
  try {
    const response = await fetch(state.metrics + "/ready", { signal: AbortSignal.timeout(3000), redirect: "error" });
    return response.status === 200 && (await response.json()).readyConnections > 0;
  } catch { return false; }
}
async function stopTunnel() {
  const state = readState();
  if (state) {
    const details = processDetails(state.pid);
    if (details) {
      if (ownsTunnel(state, details)) {
        process.kill(state.pid);
        await waitUntil(() => !processDetails(state.pid), 15000, "隧道尚未退出，未启动第二个实例。");
      } else console.log("重启后的旧 PID 属于其他进程；仅清理失效记录，未停止该进程。");
    }
    unlinkSync(stateFile);
  }
  save(urlFile, "公网隧道已停止。双击桌面启动程序后查看最新地址。\n");
}
export async function waitUntil(checkState, timeout, message, interval = 1000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await checkState();
    if (result) return result;
    await delay(interval);
  } while (Date.now() < deadline);
  throw new Error(message);
}
export async function ensureDocker(run = command, wait = waitUntil) {
  const available = () => {
    try { return run("docker", ["info", "--format", "{{.OSType}}"], { timeout: 5000 }).trim() === "linux"; }
    catch { return false; }
  };
  if (available()) return;
  console.log("Docker 尚未就绪，正在启动 Docker Desktop（最多等待 3 分钟）……");
  run("docker", ["desktop", "start", "--detach", "--timeout", "30"], { timeout: 40000 });
  await wait(available, 180000, "Docker Desktop 启动超时。请检查 Docker/WSL 错误，再双击启动；不要删除数据库。", 3000);
}
export const serviceStartArgs = ["up", "-d", "--wait", "--wait-timeout", "150", "--no-build", "--pull", "never", "db", "api", "acceptance-gate", "web"];
export const serviceRecoveryArgs = ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "150", "--no-build", "--pull", "never", "--force-recreate", "api", "acceptance-gate", "web"];
function openUrl(url) {
  assert.ok(isPublicUrl(url), "公网入口尚未就绪，请先启动。");
  command("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url}'`]);
}
async function startAcceptance() {
  for (const path of [environmentFile, credentialsFile, join(directory, "entry-config.json"), join(directory, "nginx.conf"), cloudflared]) {
    assert.ok(existsSync(path), `启动所需文件缺失：${path}。请联系维护人员；不要重复初始化。`);
  }
  console.log("[1/4] 检查本机 Docker；保留现有账号、密码和试用数据。");
  await ensureDocker();
  // 数据卷或已验收镜像丢失时停止，不把空库或新构建当作恢复成功。
  command("docker", ["volume", "inspect", "sampleflow-acceptance_sampleflow_pgdata"]);
  command("docker", ["image", "inspect", "sampleflow-acceptance-api", "sampleflow-acceptance-web"]);
  console.log("[2/4] 启动／检查现有验收服务（不构建、不迁移、不导入）。");
  compose(serviceStartArgs);
  const credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
  try { await check(localOrigin, credentials); }
  catch {
    console.log("本机入口检查未通过，恢复本项目 API／入口／Web；不重建数据库。");
    compose(serviceRecoveryArgs);
    await check(localOrigin, credentials);
  }
  let state = readState();
  if (state) {
    const details = processDetails(state.pid);
    if (!state.metrics) state.metrics = "http://127.0.0.1:20241";
    if (!state.url && existsSync(urlFile)) state.url = readFileSync(urlFile, "utf8").trim();
    const publishedUrl = existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : "";
    if (ownsTunnel(state, details) && isPublishedState(state, publishedUrl) && await tunnelReady(state)) {
      console.log("[3/4] 原隧道连接正常，复用当前网址。");
      // 此时公网检查失败也不主动切断仍有客户使用的健康隧道。
      await publishReady(state, credentials);
      return;
    }
    console.log("[3/4] 旧隧道已断开，正在安全恢复……");
    await stopTunnel();
  } else console.log("[3/4] 建立公网连接（最多等待 2 分钟）……");
  save(urlFile, "公网入口正在恢复，尚未检查通过；不要使用旧网址。\n");
  const logDirectory = join(directory, "tunnel-logs");
  const logFile = join(logDirectory, "cloudflared.log");
  mkdirSync(logDirectory, { recursive: true });
  if (existsSync(logFile)) copyFileSync(logFile, join(logDirectory, "previous-start.log"));
  save(logFile, "");
  // 使用 cloudflared 自带轮转日志；脱离启动窗口，关闭窗口不会断开公网。
  // 当前代理下 QUIC/UDP 持续超时；使用加密的 HTTP/2 TCP 隧道，不改变系统代理。
  const tunnel = spawn(cloudflared, ["tunnel", "--protocol", "http2", "--metrics", "127.0.0.1:0", "--log-directory", logDirectory, "--url", localOrigin, "--no-autoupdate"], { cwd: root, detached: true, windowsHide: true, stdio: "ignore" });
  await new Promise((resolve, reject) => { tunnel.once("spawn", resolve); tunnel.once("error", () => reject(new Error("无法启动 cloudflared，请检查安装路径和 Windows 权限。"))); });
  tunnel.unref();
  let ready = false;
  try {
    state = { pid: tunnel.pid, startedAt: processDetails(tunnel.pid)?.startedAt };
    assert.ok(state.startedAt, "无法核对隧道进程身份。");
    save(stateFile, JSON.stringify(state));
    await waitUntil(async () => {
      const log = readFileSync(logFile, "utf8");
      state.url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      const address = log.match(/Starting metrics server on (127\.0\.0\.1:\d+)\//)?.[1];
      if (address) state.metrics = "http://" + address;
      return isPublicUrl(state.url) && await tunnelReady(state);
    }, 120000, "公网隧道连接超时。请检查网络及现有代理是否正常；日志在 .sampleflow/acceptance/tunnel-logs/。未修改防火墙、代理或数据。");
    save(stateFile, JSON.stringify(state));
    save(environmentFile, readFileSync(environmentFile, "utf8").replace(/^APP_ORIGINS=.*$/m, `APP_ORIGINS=${state.url}`));
    configureNginx();
    compose(serviceRecoveryArgs);
    await check(localOrigin, credentials);
    await publishReady(state, credentials);
    ready = true;
  } finally {
    if (!ready) {
      // 只回收本次创建的进程，不关闭其他项目或删除业务数据。
      tunnel.kill();
      save(urlFile, "公网启动未通过检查。数据和密码保留；修复网络后请重新双击启动。\n");
    }
  }
}
async function publishReady(state, credentials) {
  console.log("[4/4] 用真实浏览器检查公网入口、系统登录页和 API 就绪……");
  await checkPublicEntry(state.url, credentials);
  assert.ok(await tunnelReady(state), "检查期间隧道已断开，请重试。");
  save(stateFile, JSON.stringify({ ...state, verifiedAt: new Date().toISOString() }));
  save(urlFile, state.url + "\n");
  console.log(`公网入口已就绪：${state.url}\n请把此最新地址发给客户。启动窗口现在可以关闭；电脑需保持联网、不睡眠。\n密码未改变。停止验收请双击桌面“SampleFlow停止公网验收.cmd”。`);
}

async function main(action) {
assert.ok(["init", "start", "stop", "check", "open", "configure-entry"].includes(action), "用法：node scripts/acceptance.mjs init|start|stop|check|open|configure-entry");
const lock = await startupLock();
try {
if (action === "open") {
  const state = readState();
  assert.ok(state && ownsTunnel(state, processDetails(state.pid)) && await tunnelReady(state), "公网入口已断开，请双击桌面启动程序恢复。");
  const url = readFileSync(urlFile, "utf8").trim();
  assert.ok(isPublishedState(state, url), "网址未完成检查，请先运行启动程序。");
  await check(localOrigin, JSON.parse(readFileSync(credentialsFile, "utf8")));
  openUrl(url);
  return;
}
if (action === "stop") {
  await stopTunnel();
  console.log("本项目公网隧道已停止；数据库和其他项目不受影响。");
  return;
}
localDocker();
if(action==="configure-entry"){configureNginx();console.log("入口配置已生成；密码未改变，尚未重启服务。");return;}
if(action==="start"){await startAcceptance();return;}
if (action === "init") {
  assert.ok(!existsSync(environmentFile) && !existsSync(credentialsFile), "已有验收配置，拒绝覆盖密码或重复初始化。");
  const volumes = command("docker", ["volume", "ls", "--format", "{{.Name}}"]);
  assert.ok(!volumes.split(/\r?\n/).includes("sampleflow-acceptance_sampleflow_pgdata"), "验收数据卷已存在，拒绝覆盖或重新初始化。");
  mkdirSync(directory, { recursive: true });
  secure(directory);
  const template = readFileSync(join(root, ".env.acceptance.example"), "utf8");
  const environment = template.replace(/replace-with-[^\r\n]+/g, () => randomBytes(32).toString("hex"))
    .replace("https://accept.example.com", "https://acceptance.invalid");
  save(environmentFile, environment);
  // 文件不继承目录标志，单独限制环境秘密的 Windows 访问权限。
  const identity = command("whoami", []).trim();
  command("icacls", [environmentFile, "/inheritance:r", "/grant:r", `${identity}:F`, "*S-1-5-18:F"]);
  const credentials = { entryUsername: "acceptance", entryPassword: randomBytes(24).toString("base64url"), adminUsername: "sampleflow-acceptance-admin" };
  save(credentialsFile, JSON.stringify(credentials, null, 2));
  configureNginx();
  console.log("创建独立验收库；不读取开发库，不导入业务数据。");
  compose(["up", "-d", "--wait", "db"]);
  for (const operation of ["db-provision-roles", "db-migrate", "admin-bootstrap"]) {
    console.log(`执行独立验收作业：${operation}`);
    const output = compose(["--profile", "operations", "run", "--rm", "--build", operation]);
    if (operation === "admin-bootstrap") save(join(directory, "admin-bootstrap.txt"), output);
  }
  console.log("初始化完成。凭据仅保存在本机受限目录 .sampleflow/acceptance/，未打印密码。");
} else {
  const credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
  if (action === "check") {
    await check("http://127.0.0.1:18080", credentials);
  } else {
    throw new Error("未知操作。");
  }
}
} finally { await new Promise(resolve => lock.close(resolve)); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv[2]).catch(error => { console.error(`未完成：${error.message}`); process.exitCode = 1; });
}
