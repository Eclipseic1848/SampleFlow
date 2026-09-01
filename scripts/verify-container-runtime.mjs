import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const migrationsRoot = fileURLToPath(new URL("../apps/api/migrations/", import.meta.url));
const project = `sfsecurity${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const restoreDatabase = `sampleflow_restore_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const inheritedEnvironmentKeys = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC",
  "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "DOCKER_HOST", "DOCKER_CONTEXT",
  "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
];
const environment = Object.fromEntries(inheritedEnvironmentKeys.flatMap((key) =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]
));
Object.assign(environment, {
  APP_ORIGINS: `http://127.0.0.1:${port}`,
  WEB_PORT: String(port),
  POSTGRES_DB: "sampleflow_security_test",
  POSTGRES_USER: "sampleflow_security_admin",
  POSTGRES_PASSWORD: "security-test-admin-password-only",
  DB_MIGRATION_USER: "sampleflow_security_migration",
  DB_MIGRATION_PASSWORD: "security-test-migration-password-only",
  DB_APP_USER: "sampleflow_security_app",
  DB_APP_PASSWORD: "security-test-app-password-only",
  DB_BACKUP_USER: "sampleflow_security_backup",
  DB_BACKUP_PASSWORD: "security-test-backup-password-only",
  DATABASE_OPERATION_UID: String(process.getuid?.() ?? 1000),
  DATABASE_OPERATION_GID: String(process.getgid?.() ?? 1000),
  BOOTSTRAP_ADMIN_USERNAME: "security-test-admin",
  BACKUP_FILE_NAME: "sampleflow.dump",
  RESTORE_DB_NAME: restoreDatabase,
  DATABASE_URL: "postgres://unused:unused@127.0.0.1/unused",
  SESSION_COOKIE_SECURE: "false",
  IMPORT_SOURCE_PATH: "./.sampleflow/import-source.xlsx",
  IMPORT_CONFIG_ID: "",
  IMPORT_OPERATOR_USER_ID: "",
  IMPORT_BATCH_ID: "",
  IMPORT_CONFIRMED_WARNINGS: "",
});

const composeBase = ["compose", "-p", project, "--env-file", ".env.example"];
const gateDirectoryPrefix = join(tmpdir(), "sampleflow-compose-gate-");
let gateDirectory;
let backupDirectory;
let oldMigrationsDirectory;
let ownsGateDirectory = false;
let ownsResources = false;
let acquiredResources = false;
let restoredApiId;
let activeChild;
let interruptedCode;
let cleaning = false;

function docker(args, { capture = false, sensitive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      env: environment,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) return resolve(stdout);
      const details = sensitive ? "敏感输出已隐藏" : (stderr || stdout).trim();
      const error = new Error(`[容器验收] Docker 命令失败（${signal ?? code}）${details ? `\n${details}` : ""}`);
      error.stdout = sensitive ? "" : stdout;
      error.stderr = sensitive ? "" : stderr;
      reject(error);
    });
  });
}

function compose(args, options) {
  return docker([...composeBase, ...args], options);
}

async function assertLocalDockerEndpoint() {
  const configuredContext = environment.DOCKER_CONTEXT?.trim();
  let endpoint;
  if (configuredContext) {
    endpoint = (await docker(["context", "inspect", configuredContext, "--format", "{{.Endpoints.docker.Host}}"], { capture: true })).trim();
  } else if (environment.DOCKER_HOST?.trim()) {
    endpoint = environment.DOCKER_HOST.trim();
  } else {
    const currentContext = (await docker(["context", "show"], { capture: true })).trim();
    endpoint = (await docker(["context", "inspect", currentContext, "--format", "{{.Endpoints.docker.Host}}"], { capture: true })).trim();
  }
  assert.match(endpoint, /^(npipe|unix):\/\//, `容器验收只允许本机 Docker endpoint，当前为 ${endpoint}`);
}

function prepareGateDirectory() {
  gateDirectory = mkdtempSync(gateDirectoryPrefix);
  ownsGateDirectory = true;
  backupDirectory = join(gateDirectory, "backups");
  oldMigrationsDirectory = join(gateDirectory, "old-migrations");
  mkdirSync(backupDirectory);
  mkdirSync(oldMigrationsDirectory);
  const migrations = readdirSync(migrationsRoot).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.length > 1, "升级验收至少需要两个迁移版本");
  for (const name of migrations.slice(0, -1)) {
    copyFileSync(join(migrationsRoot, name), join(oldMigrationsDirectory, name));
  }
  environment.BACKUP_DIRECTORY = backupDirectory;
  return { current: migrations.length, old: migrations.length - 1 };
}

async function reserveProxyNetwork() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const subnet = `10.${randomInt(64, 192)}.${randomInt(0, 256)}.0/24`;
    try {
      await docker([
        "network", "create", "--subnet", subnet,
        "--label", `com.docker.compose.project=${project}`,
        "--label", "com.docker.compose.network=proxy",
        `${project}_proxy`,
      ], { capture: true });
      ownsResources = true;
      acquiredResources = true;
      environment.SAMPLEFLOW_PROXY_SUBNET = subnet;
      return;
    } catch (error) {
      if (!String(error.stderr).includes("Pool overlaps")) throw error;
    }
  }
  throw new Error("无法占用独立的容器验收网段");
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  const errors = [];
  const attempt = async (label, run) => {
    try { await run(); } catch (error) { errors.push(new Error(`${label}：${error.message}`)); }
  };
  try {
    if (restoredApiId) {
      await attempt("删除恢复库验收 API", () => docker(["rm", "-f", restoredApiId], { capture: true }));
      restoredApiId = undefined;
    }
    if (ownsResources) {
      await attempt("Compose down", () => compose(["--profile", "operations", "down", "--rmi", "local", "-v", "--remove-orphans"]));
      await attempt("删除残留验收镜像", async () => {
        const images = (await docker(["image", "ls", "--filter", `reference=${project}-*`, "--format", "{{.Repository}}:{{.Tag}}"], { capture: true }))
          .trim().split(/\r?\n/).filter(Boolean);
        if (images.length > 0) await docker(["image", "rm", ...images]);
      });
      for (const [kind, args] of [
        ["容器", ["container", "ls", "-aq", "--filter", `label=com.docker.compose.project=${project}`]],
        ["网络", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]],
        ["卷", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]],
        ["镜像", ["image", "ls", "-q", "--filter", `reference=${project}-*`]],
      ]) {
        await attempt(`检查残留${kind}`, async () => {
          assert.equal((await docker(args, { capture: true })).trim(), "", `${project} 遗留${kind}`);
        });
      }
      ownsResources = false;
    }
    if (ownsGateDirectory) {
      try {
        assert.ok(gateDirectory.startsWith(gateDirectoryPrefix), "拒绝清理非本次验收临时目录");
        rmSync(gateDirectory, { recursive: true, force: true });
        ownsGateDirectory = false;
      } catch (error) {
        errors.push(new Error(`删除验收临时目录：${error.message}`));
      }
    }
  } finally {
    cleaning = false;
  }
  if (errors.length > 0) throw new AggregateError(errors, "容器验收清理失败");
}

function requestStop(code) {
  interruptedCode ??= code;
  try { activeChild?.kill("SIGTERM"); } catch {}
}

process.once("SIGINT", () => requestStop(130));
process.once("SIGTERM", () => requestStop(143));

async function inspect(containerId) {
  return JSON.parse(await docker(["inspect", containerId], { capture: true }))[0];
}

async function assertRuntime(containerId, expected) {
  const details = await inspect(containerId);
  if (expected.nonRoot !== false) {
    const uid = Number((await docker(["exec", containerId, "id", "-u"], { capture: true })).trim());
    assert.ok(uid > 0, `${expected.name} 以 root 运行`);
  }
  assert.equal(details.State.Health.Status, "healthy");
  assert.equal(details.HostConfig.NanoCpus, expected.cpus);
  assert.equal(details.HostConfig.Memory, expected.memory);
  assert.equal(details.HostConfig.LogConfig.Type, "json-file");
  assert.deepEqual(details.HostConfig.LogConfig.Config, { "max-file": "5", "max-size": "10m" });
}

async function psql(containerId, user, password, database, sql) {
  return docker([
    "exec", "-e", `PGPASSWORD=${password}`, containerId,
    "psql", "-X", "-qAt", "--set", "ON_ERROR_STOP=1", "--host=127.0.0.1",
    `--username=${user}`, `--dbname=${database}`, `--command=${sql}`,
  ], { capture: true });
}

async function expectFailure(run, pattern) {
  let failure;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "预期命令失败但实际成功");
  assert.match(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, pattern);
}

const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
};

function assertHeaders(response, label) {
  for (const [name, value] of Object.entries(securityHeaders)) {
    assert.equal(response.headers.get(name), value, `${label} 缺少 ${name}`);
  }
  assert.equal(response.headers.get("strict-transport-security"), null, `${label} 不应在 HTTP 层设置 HSTS`);
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `${path} 返回 ${response.status}`);
  return response;
}

async function loginThroughWeb(password) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: environment.APP_ORIGINS },
    body: JSON.stringify({ username: environment.BOOTSTRAP_ADMIN_USERNAME, password }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `真实登录返回 ${response.status}`);
}

async function waitForRestoredApi(containerId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await docker(["exec", containerId, "node", "-e",
        "fetch('http://127.0.0.1:3000/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
      ], { capture: true });
      return;
    } catch {
      const details = await inspect(containerId);
      if (!details.State.Running) throw new Error("恢复库 API 在 readiness 前退出");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("恢复库 API readiness 超时");
}

async function loginInside(containerId, password) {
  const script = `
    const ready=await fetch('http://127.0.0.1:3000/api/ready');
    if(!ready.ok) throw new Error('ready '+ready.status);
    const login=await fetch('http://127.0.0.1:3000/api/auth/login',{
      method:'POST',headers:{'content-type':'application/json',origin:process.env.APP_ORIGINS},
      body:JSON.stringify({username:process.env.SMOKE_USERNAME,password:process.env.SMOKE_PASSWORD})
    });
    if(!login.ok) throw new Error('login '+login.status);
  `;
  await docker([
    "exec", "-e", `SMOKE_USERNAME=${environment.BOOTSTRAP_ADMIN_USERNAME}`, "-e", `SMOKE_PASSWORD=${password}`,
    containerId, "node", "--input-type=module", "--eval", script,
  ], {
    capture: true,
    sensitive: true,
  });
}

let failure;
try {
  await assertLocalDockerEndpoint();
  const migrationCounts = prepareGateDirectory();
  await reserveProxyNetwork();
  await compose(["build", "api", "web"]);
  await compose(["up", "-d", "--wait", "--wait-timeout", "120", "db"]);
  await compose(["--profile", "operations", "run", "--rm", "db-provision-roles"]);
  await compose([
    "--profile", "operations", "run", "--rm", "--no-deps",
    "-e", "NODE_ENV=test", "-e", "TEST_MIGRATIONS_DIR=/old-migrations",
    "-v", `${oldMigrationsDirectory}:/old-migrations:ro`, "db-migrate",
  ]);

  const dbId = (await compose(["ps", "-q", "db"], { capture: true })).trim();
  assert.equal(
    Number((await psql(dbId, environment.POSTGRES_USER, environment.POSTGRES_PASSWORD, environment.POSTGRES_DB, "select count(*) from schema_migrations")).trim()),
    migrationCounts.old,
  );
  const bootstrapOutput = await compose(["--profile", "operations", "run", "--rm", "--no-deps", "admin-bootstrap"], {
    capture: true,
    sensitive: true,
  });
  const temporaryPassword = bootstrapOutput.match(/临时密码（仅显示一次）：([^\r\n]+)/)?.[1];
  assert.ok(temporaryPassword, "管理员初始化未返回一次性临时密码");
  await expectFailure(
    () => compose(["run", "--rm", "--no-deps", "api"], { capture: true }),
    /SCHEMA_OUTDATED/,
  );

  await compose(["--profile", "operations", "run", "--rm", "--no-deps", "db-migrate"]);
  await compose(["--profile", "operations", "run", "--rm", "--no-deps", "db-migrate"]);
  assert.equal(
    Number((await psql(dbId, environment.POSTGRES_USER, environment.POSTGRES_PASSWORD, environment.POSTGRES_DB, "select count(*) from schema_migrations")).trim()),
    migrationCounts.current,
  );
  await compose(["up", "-d", "--wait", "--wait-timeout", "180", "api", "web"]);

  const apiId = (await compose(["ps", "-q", "api"], { capture: true })).trim();
  const webId = (await compose(["ps", "-q", "web"], { capture: true })).trim();
  await assertRuntime(apiId, { name: "API", cpus: 1_000_000_000, memory: 512 * 1024 * 1024 });
  await assertRuntime(webId, { name: "Web", cpus: 500_000_000, memory: 128 * 1024 * 1024 });
  await assertRuntime(dbId, { name: "PostgreSQL", cpus: 2_000_000_000, memory: 1024 * 1024 * 1024, nonRoot: false });

  const health = await request("/healthz");
  assert.equal((await health.text()).trim(), "ok");
  const live = await request("/api/health");
  assert.equal((await live.json()).status, "ok");
  const ready = await request("/api/ready");
  assert.deepEqual(await ready.json(), { status: "ready", database: "connected" });
  await loginThroughWeb(temporaryPassword);

  const uploadProbe = await fetch(`http://127.0.0.1:${port}/api/imports/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: environment.APP_ORIGINS },
    body: JSON.stringify({ fileBase64: "A".repeat(1_100_000) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.notEqual(uploadProbe.status, 413, "合同内请求不应被 Web 代理提前拒绝");

  const loginFailure = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(loginFailure.status, 403);

  const metrics = await docker(["exec", apiId, "node", "-e",
    "fetch('http://127.0.0.1:3000/internal/metrics').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))",
  ], { capture: true });
  for (const sample of [
    /sampleflow_http_requests_total\{route_template="\/api\/auth\/login",method="POST",status_category="4xx"\} 1/,
    /sampleflow_http_errors_total\{route_template="\/api\/auth\/login",method="POST",status_category="4xx"\} 1/,
    /sampleflow_http_request_duration_seconds_count\{route_template="\/api\/auth\/login",method="POST",status_category="4xx"\} 1/,
    /sampleflow_operation_failures_total\{operation="auth.login",result="failure",reason_code="AUTH_ORIGIN_INVALID"\} 1/,
    /sampleflow_database_ready 1/,
  ]) assert.match(metrics, sample);
  const publicMetrics = await request("/internal/metrics");
  assert.match(publicMetrics.headers.get("content-type") ?? "", /text\/html/);
  assert.doesNotMatch(await publicMetrics.text(), /sampleflow_database_ready/, "Web 不应代理内部指标");

  for (const [path, label] of [["/", "页面"], ["/api/health", "API"], ["/maps/china-provinces-mit-1.0.0.geojson", "地图"]]) {
    assertHeaders(await request(path, { method: "HEAD" }), label);
  }

  const marker = `proxy-test-${Date.now()}`;
  const proxyResponse = await request(`/api/health?${marker}`, { headers: { "X-Forwarded-For": "203.0.113.99" } });
  const requestId = proxyResponse.headers.get("x-request-id");
  assert.ok(requestId, "可信代理验收响应缺少请求标识");
  const logs = (await docker(["logs", "--tail", "100", apiId], { capture: true })).split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const proxyRequest = logs.findLast((entry) => entry.requestId === requestId);
  assert.ok(proxyRequest, "未找到可信代理验收请求日志");
  assert.equal(proxyRequest.routeTemplate, "/api/health");
  assert.notEqual(proxyRequest.remoteAddress, "203.0.113.99", "Web 未覆盖客户端伪造的转发地址");
  const startup = logs.find((entry) => entry.reasonCode === "STARTUP_SUCCEEDED");
  assert.ok(startup, "未找到结构化启动成功日志");
  assert.equal(startup.level, 30);

  await compose(["stop", "web", "api"]);
  await compose(["--profile", "operations", "run", "--rm", "--no-deps", "db-backup"]);
  const backupFiles = [
    environment.BACKUP_FILE_NAME,
    `${environment.BACKUP_FILE_NAME}.sha256`,
    `${environment.BACKUP_FILE_NAME}.summary`,
    `${environment.BACKUP_FILE_NAME}.summary.sha256`,
  ];
  if (process.getuid) {
    for (const name of backupFiles) {
      const details = statSync(join(backupDirectory, name));
      assert.equal(details.uid, process.getuid(), `${name} 不属于当前 CI/部署账号`);
      assert.equal(details.gid, process.getgid(), `${name} 不属于当前 CI/部署账号组`);
    }
  }
  const backup = readFileSync(join(backupDirectory, environment.BACKUP_FILE_NAME));
  assert.equal(backup.subarray(0, 5).toString("ascii"), "PGDMP");
  assert.match(readFileSync(join(backupDirectory, `${environment.BACKUP_FILE_NAME}.sha256`), "utf8"), /^[a-f0-9]{64}  sampleflow\.dump\r?\n$/);
  await compose(["--profile", "operations", "run", "--rm", "--no-deps", "db-restore-new"]);

  const restoredSummary = await compose([
    "--profile", "operations", "run", "--rm", "--no-deps",
    "-e", `SOURCE_DB_NAME=${restoreDatabase}`, "db-backup",
    "bash", "/operations/database-operations.sh", "summary",
  ], { capture: true });
  assert.equal(restoredSummary, readFileSync(join(backupDirectory, `${environment.BACKUP_FILE_NAME}.summary`), "utf8"));
  await expectFailure(
    () => psql(dbId, environment.DB_APP_USER, environment.DB_APP_PASSWORD, restoreDatabase, "create table forbidden_gate_ddl(id integer)"),
    /permission denied/,
  );
  await expectFailure(
    () => psql(dbId, environment.DB_BACKUP_USER, environment.DB_BACKUP_PASSWORD, restoreDatabase, "insert into app_metadata(key,value) values('forbidden-gate','write')"),
    /permission denied/,
  );
  const publicConnect = await psql(
    dbId,
    environment.POSTGRES_USER,
    environment.POSTGRES_PASSWORD,
    "postgres",
    `select exists(select 1 from pg_database d cross join lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) acl where d.datname='${restoreDatabase}' and acl.grantee=0 and acl.privilege_type='CONNECT')`,
  );
  assert.equal(publicConnect.trim(), "f");

  const restoredApiName = `${project}-restore-api`;
  restoredApiId = (await compose([
    "run", "-d", "--no-deps", "--name", restoredApiName,
    "-e", `DB_NAME=${restoreDatabase}`, "api",
  ], { capture: true })).trim();
  await waitForRestoredApi(restoredApiId);
  assert.ok(Number((await docker(["exec", restoredApiId, "id", "-u"], { capture: true })).trim()) > 0, "恢复库 API 以 root 运行");
  await loginInside(restoredApiId, temporaryPassword);

  console.log(`[容器验收] ${project} 通过：隔离首装、真实升级、ready/smoke、备份、新库恢复、权限与恢复库登录`);
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanup();
    if (acquiredResources) console.log(`[容器验收] 已清理 ${project} 的容器、网络、验收卷、镜像和临时备份`);
  } catch (cleanupError) {
    if (failure) console.error(`[容器验收] 清理失败：${cleanupError.message}`);
    else failure = cleanupError;
  }
}

if (interruptedCode) process.exitCode = interruptedCode;
if (failure) throw failure;
