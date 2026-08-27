import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4174 --strictPort",
    env: { SAMPLEFLOW_API_PROXY_TARGET: "http://127.0.0.1:3100" },
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
  },
});
