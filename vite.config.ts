import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { projectAssets } from "./scripts/project-assets.mjs";
export default defineConfig({
  base: "./",
  plugins: [react(), projectAssets({ project: process.env.FRAME_PROJECT })],
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/.cache/**",
        "**/exports/**",
        "**/production/**",
        "**/test-results/**",
        "**/playwright-report/**",
      ],
    },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 1600 },
});
