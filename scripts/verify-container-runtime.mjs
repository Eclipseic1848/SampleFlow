import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = `sfsecurity${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
  BOOTSTRAP_ADMIN_USERNAME: "security-test-admin",
  DATABASE_URL: "postgres://unused:unused@127.0.0.1/unused",
  SESSION_COOKIE_SECURE: "false",
  IMPORT_SOURCE_PATH: "./.sampleflow/import-source.xlsx",
  IMPORT_CONFIG_ID: "",
  IMPORT_OPERATOR_USER_ID: "",
  IMPORT_BATCH_ID: "",
  IMPORT_CONFIRMED_WARNINGS: "",
});
const composeBase = ["compose", "-p", project, "--env-file", ".env.example"];
let ownsResources = false;
let acquiredResources = false;
let cleaning = false;

function docker(args, capture = false) {
  return execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function compose(args, capture = false) {
  return docker([...composeBase, ...args], capture);
}

function assertLocalDockerEndpoint() {
  const configuredContext = environment.DOCKER_CONTEXT?.trim();
  let endpoint;
  if (configuredContext) {
    endpoint = docker(["context", "inspect", configuredContext, "--format", "{{.Endpoints.docker.Host}}"], true).trim();
  } else if (environment.DOCKER_HOST?.trim()) {
    endpoint = environment.DOCKER_HOST.trim();
  } else {
    const currentContext = docker(["context", "show"], true).trim();
    endpoint = docker(["context", "inspect", currentContext, "--format", "{{.Endpoints.docker.Host}}"], true).trim();
  }
  assert.match(endpoint, /^(npipe|unix):\/\//, `容器验收只允许本机 Docker endpoint，当前为 ${endpoint}`);
}

function reserveProxyNetwork() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const subnet = `10.${randomInt(64, 192)}.${randomInt(0, 256)}.0/24`;
    try {
      docker([
        "network", "create", "--subnet", subnet,
        "--label", `com.docker.compose.project=${project}`,
        "--label", "com.docker.compose.network=proxy",
        `${project}_proxy`,
      ], true);
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

function cleanup() {
  if (!ownsResources || cleaning) return;
  cleaning = true;
  try {
    compose(["--profile", "operations", "down", "--rmi", "local", "-v", "--remove-orphans"]);
    const images = docker(["image", "ls", "--filter", `reference=${project}-*`, "--format", "{{.Repository}}"], true).trim();
    assert.equal(images, "", `${project} 遗留验收镜像`);
    ownsResources = false;
  } finally {
    cleaning = false;
  }
}

function stopOnSignal(code) {
  try {
    cleanup();
  } catch (error) {
    console.error(`[容器验收] 信号清理失败：${error.message}`);
  }
  process.exit(code);
}

process.once("SIGINT", () => stopOnSignal(130));
process.once("SIGTERM", () => stopOnSignal(143));

function inspect(containerId) {
  return JSON.parse(docker(["inspect", containerId], true))[0];
}

function assertRuntime(containerId, expected) {
  const details = inspect(containerId);
  if (expected.nonRoot !== false) {
    const uid = Number(docker(["exec", containerId, "id", "-u"], true).trim());
    assert.ok(uid > 0, `${expected.name} 以 root 运行`);
  }
  assert.equal(details.State.Health.Status, "healthy");
  assert.equal(details.HostConfig.NanoCpus, expected.cpus);
  assert.equal(details.HostConfig.Memory, expected.memory);
  assert.equal(details.HostConfig.LogConfig.Type, "json-file");
  assert.deepEqual(details.HostConfig.LogConfig.Config, { "max-file": "5", "max-size": "10m" });
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

let failure;
try {
  assertLocalDockerEndpoint();
  reserveProxyNetwork();
  compose(["build", "api", "web"]);
  compose(["up", "-d", "--wait", "--wait-timeout", "120", "db"]);
  compose(["--profile", "operations", "run", "--rm", "db-provision-roles"]);
  compose(["--profile", "operations", "run", "--rm", "db-migrate"]);
  compose(["up", "-d", "--wait", "--wait-timeout", "180", "api", "web"]);

  const apiId = compose(["ps", "-q", "api"], true).trim();
  const webId = compose(["ps", "-q", "web"], true).trim();
  const dbId = compose(["ps", "-q", "db"], true).trim();
  assertRuntime(apiId, { name: "API", cpus: 1_000_000_000, memory: 512 * 1024 * 1024 });
  assertRuntime(webId, { name: "Web", cpus: 500_000_000, memory: 128 * 1024 * 1024 });
  assertRuntime(dbId, { name: "PostgreSQL", cpus: 2_000_000_000, memory: 1024 * 1024 * 1024, nonRoot: false });

  const health = await request("/healthz");
  assert.equal((await health.text()).trim(), "ok");
  const live = await request("/api/health");
  assert.equal((await live.json()).status, "ok");
  const ready = await request("/api/ready");
  assert.deepEqual(await ready.json(), { status: "ready", database: "connected" });

  for (const [path, label] of [["/", "页面"], ["/api/health", "API"], ["/maps/china-provinces-mit-1.0.0.geojson", "地图"]]) {
    assertHeaders(await request(path, { method: "HEAD" }), label);
  }

  const marker = `proxy-test-${Date.now()}`;
  await request(`/api/health?${marker}`, { headers: { "X-Forwarded-For": "203.0.113.99" } });
  const logs = docker(["logs", "--tail", "100", apiId], true).split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const proxyRequest = logs.findLast((entry) => entry.req?.url?.includes(marker));
  assert.ok(proxyRequest, "未找到可信代理验收请求日志");
  assert.notEqual(proxyRequest.req.remoteAddress, "203.0.113.99", "Web 未覆盖客户端伪造的转发地址");

  console.log(`[容器验收] ${project} 通过：非 root、healthy、资源、日志、健康入口、安全头和可信代理`);
} catch (error) {
  failure = error;
} finally {
  try {
    cleanup();
    if (acquiredResources) console.log(`[容器验收] 已清理 ${project} 的容器、网络、验收卷和镜像`);
  } catch (cleanupError) {
    if (failure) console.error(`[容器验收] 清理失败：${cleanupError.message}`);
    else failure = cleanupError;
  }
}

if (failure) throw failure;
