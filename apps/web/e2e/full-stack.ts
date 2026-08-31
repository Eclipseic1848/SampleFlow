import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import {
  type TestDatabase,
  withMigratedTestDatabase,
} from "../../api/src/test-support/test-database.js";

const apiRoot = fileURLToPath(new URL("../../api/", import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const viteEntry = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

type FullStackDatabase = Readonly<TestDatabase & {
  apiBaseUrl: string;
  webBaseUrl: string;
}>;

type RunningProcess = Readonly<{
  child: ChildProcessWithoutNullStreams;
  label: string;
  log: () => string;
}>;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function allocatePorts(): Promise<readonly [number, number]> {
  const servers = [createServer(), createServer()];
  try {
    const ports = await Promise.all(servers.map((server) => new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("无法分配 E2E 端口"));
        else resolve(address.port);
      });
    })));
    return [ports[0]!, ports[1]!];
  } finally {
    await Promise.all(servers.filter((server) => server.listening).map(closeServer));
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function startNode(label: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): RunningProcess {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: string) => { output = `${output}${chunk}`.slice(-4_000); };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => append(`${error.message}\n`));
  return { child, label, log: () => output.trim() };
}

async function waitForServer(process: RunningProcess, url: string, expectedContent: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      throw new Error(`${process.label} 在就绪前退出\n${process.log()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok && (await response.text()).includes(expectedContent)) {
        await delay(50);
        if (process.child.exitCode === null && process.child.signalCode === null) return;
      }
    } catch {
      // 服务尚未监听时继续等待。
    }
    await delay(100);
  }
  throw new Error(`等待 ${process.label} 就绪超时\n${process.log()}`);
}

async function stopProcess(process: RunningProcess): Promise<void> {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  const exited = once(process.child, "exit");
  process.child.kill();
  await Promise.race([exited, delay(3_000)]);
  if (process.child.exitCode === null && process.child.signalCode === null) {
    const forcedExit = once(process.child, "exit");
    process.child.kill("SIGKILL");
    await Promise.race([forcedExit, delay(3_000)]);
  }
  if (process.child.exitCode === null && process.child.signalCode === null) {
    throw new Error(`无法停止测试 ${process.label} 进程 ${process.child.pid}`);
  }
}

export const test = base.extend<{ database: FullStackDatabase }>({
  database: [async ({}, use, testInfo) => {
    await withMigratedTestDatabase(async (database) => {
      const [apiPort, webPort] = await allocatePorts();
      const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
      const webBaseUrl = `http://127.0.0.1:${webPort}`;
      const readyToken = randomUUID();
      const processes: RunningProcess[] = [];
      let setupError: unknown;

      try {
        const api = startNode("API", ["--import", "tsx", "src/server.ts"], apiRoot, {
          ...process.env,
          API_PORT: String(apiPort),
          APP_ORIGINS: webBaseUrl,
          DATABASE_URL: database.url,
          NODE_ENV: "test",
          SAMPLEFLOW_E2E_READY_TOKEN: readyToken,
        });
        processes.push(api);
        await waitForServer(api, `${apiBaseUrl}/api/__e2e/ready`, readyToken);

        const web = startNode("Web", [viteEntry, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], webRoot, {
          ...process.env,
          SAMPLEFLOW_API_PROXY_TARGET: apiBaseUrl,
        });
        processes.push(web);
        await waitForServer(web, `${webBaseUrl}/api/__e2e/ready`, readyToken);
        await use({ ...database, apiBaseUrl, webBaseUrl });
      } catch (error) {
        setupError = error;
        throw error;
      } finally {
        const cleanupErrors: unknown[] = [];
        for (const process of processes.reverse()) {
          try {
            await stopProcess(process);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (setupError || cleanupErrors.length || testInfo.status !== testInfo.expectedStatus) {
          const processLog = processes.map((process) => `[${process.label}]\n${process.log() || "无输出"}`);
          const cleanupLog = cleanupErrors.map((error) => `[清理]\n${error instanceof Error ? error.message : String(error)}`);
          const log = [...processLog, ...cleanupLog].join("\n\n");
          const logPath = testInfo.outputPath("full-stack.log");
          await writeFile(logPath, log, "utf8");
          await testInfo.attach("full-stack.log", { path: logPath, contentType: "text/plain" });
        }
        if (!setupError && cleanupErrors.length) throw cleanupErrors[0];
      }
    });
  }, { timeout: 75_000 }],
  baseURL: async ({ database }, use) => use(database.webBaseUrl),
});

export { expect };
