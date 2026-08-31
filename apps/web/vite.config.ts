import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const forbiddenProductionBundleValues = ["SampleFlow@2026", "开发环境已预填销售助理演示账号"];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "SAMPLEFLOW_");

  return {
    plugins: [react(), {
      name: "reject-development-login-in-production",
      apply: "build",
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle).flatMap((output) => output.type === "chunk" ? [output.code] : []);
        for (const [index, value] of forbiddenProductionBundleValues.entries()) {
          if (chunks.some((chunk) => chunk.includes(value))) throw new Error(`生产 Bundle 包含开发登录信息标记 ${index + 1}`);
        }
      },
    }],
    server: {
      proxy: {
        "/api": env.SAMPLEFLOW_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
      },
    },
  };
});
