import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "SAMPLEFLOW_");

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": env.SAMPLEFLOW_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
      },
    },
  };
});
