import { defineConfig } from "@playwright/test";

const portOffset=process.pid%10_000;
const webPort=Number(process.env.SAMPLEFLOW_E2E_WEB_PORT??20_000+portOffset);
const apiPort=Number(process.env.SAMPLEFLOW_E2E_API_PORT??30_000+portOffset);
process.env.SAMPLEFLOW_E2E_WEB_PORT=String(webPort);
process.env.SAMPLEFLOW_E2E_API_PORT=String(apiPort);

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName: "chromium",
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${webPort} --strictPort`,
    env: { SAMPLEFLOW_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
  },
});
