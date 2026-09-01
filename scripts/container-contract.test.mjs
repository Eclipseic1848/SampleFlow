import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const compose = JSON.parse(execFileSync("docker", ["compose", "--env-file", ".env.example", "config", "--format", "json"], {
  cwd: root,
  encoding: "utf8",
}));
const apiDockerfile = readFileSync(new URL("../apps/api/Dockerfile", import.meta.url), "utf8");
const webDockerfile = readFileSync(new URL("../apps/web/Dockerfile", import.meta.url), "utf8");
const nginx = readFileSync(new URL("../apps/web/nginx.conf", import.meta.url), "utf8");

test("生产 API 和 Web 镜像显式使用非 root 用户", () => {
  assert.match(apiDockerfile, /^USER node$/m);
  assert.match(webDockerfile, /^USER 101:101$/m);
});

test("常驻服务具有资源上限和有界日志轮转", () => {
  for (const name of ["db", "api", "web"]) {
    const service = compose.services[name];
    assert.ok(Number(service.cpus) > 0, `${name} 缺少 CPU 上限`);
    assert.ok(Number(service.mem_limit) > 0, `${name} 缺少内存上限`);
    assert.equal(service.logging.driver, "json-file");
    assert.equal(service.logging.options["max-size"], "10m");
    assert.equal(service.logging.options["max-file"], "5");
  }
});

test("API readiness 与 Web 静态健康入口分别驱动容器健康检查", () => {
  assert.match(compose.services.api.healthcheck.test.join(" "), /\/api\/ready/);
  assert.match(compose.services.web.healthcheck.test.join(" "), /\/healthz/);
  assert.equal(compose.services.web.ports[0].target, 8080);
  assert.match(nginx, /location = \/healthz/);
});

test("只有 Web 与 API 进入专用可信代理网络", () => {
  const proxySubnet = compose.networks.proxy.ipam.config[0].subnet;
  assert.equal(compose.services.api.environment.TRUST_PROXY_CIDR, proxySubnet);
  assert.deepEqual(Object.keys(compose.services.web.networks), ["proxy"]);
  assert.deepEqual(Object.keys(compose.services.db.networks), ["backend"]);
  assert.deepEqual(Object.keys(compose.services.api.networks).sort(), ["backend", "proxy"]);
});

test("Web 设置批准的安全响应头且不越权设置 HSTS", () => {
  assert.match(nginx, /Content-Security-Policy/);
  assert.match(nginx, /X-Content-Type-Options\s+"nosniff"/);
  assert.match(nginx, /Referrer-Policy\s+"no-referrer"/);
  assert.match(nginx, /Permissions-Policy\s+"camera=\(\), microphone=\(\), geolocation=\(\)"/);
  assert.match(nginx, /Cross-Origin-Opener-Policy\s+"same-origin"/);
  assert.doesNotMatch(nginx, /Strict-Transport-Security/i);
});

test("容器运行验收在写入前拒绝远程 Docker endpoint", () => {
  const run = (env) => spawnSync(process.execPath, ["scripts/verify-container-runtime.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const direct = run({ DOCKER_HOST: "tcp://127.0.0.1:1", DOCKER_CONTEXT: "" });
  assert.notEqual(direct.status, 0);
  assert.match(`${direct.stdout}\n${direct.stderr}`, /容器验收只允许本机 Docker endpoint/);

  const dockerConfig = mkdtempSync(join(tmpdir(), "sampleflow-docker-context-"));
  try {
    execFileSync("docker", ["context", "create", "remote-test", "--docker", "host=tcp://127.0.0.1:1"], {
      encoding: "utf8",
      env: { ...process.env, DOCKER_CONFIG: dockerConfig, DOCKER_HOST: "", DOCKER_CONTEXT: "" },
    });
    const contextOverride = run({
      DOCKER_CONFIG: dockerConfig,
      DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine",
      DOCKER_CONTEXT: "remote-test",
    });
    assert.notEqual(contextOverride.status, 0);
    assert.match(`${contextOverride.stdout}\n${contextOverride.stderr}`, /容器验收只允许本机 Docker endpoint/);
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true });
  }
});
