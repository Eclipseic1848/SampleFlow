import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

const root = new URL("../", import.meta.url);
const rootPath = decodeURIComponent(root.pathname).replace(/^\/(.:\/)/, "$1");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootPath,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function waitForPort(port, host, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`等待 ${host}:${port} 超时`));
          return;
        }
        setTimeout(probe, 800);
      });
    };
    probe();
  });
}

run("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d", "db"]);
await waitForPort(55432, "127.0.0.1", 60000);
run("npm.cmd", ["run", "db:migrate"]);
run("npm.cmd", ["run", "db:seed"]);
run("npm.cmd", ["run", "db:import-legacy"]);

if (process.platform === "win32") {
  setTimeout(() => {
    spawn("cmd", ["/c", "start", "", "http://localhost:5174"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }, 1800);
}

const dev = spawn("npm.cmd", ["run", "dev"], {
  cwd: rootPath,
  shell: process.platform === "win32",
  stdio: "inherit",
});

dev.on("exit", (code) => process.exit(code ?? 0));
