import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { projectAssets } from "./scripts/project-assets.mjs";
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    projectAssets({ project: process.env.FRAME_PROJECT }),
    {
      name: "work-preview-entry",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return process.env.FRAME_WORK_PREVIEW === "1"
            ? html.replace("/src/main.tsx", "/src/work-preview.tsx")
            : html;
        },
      },
    },
  ],
  optimizeDeps: {
    include: [
      "tone",
      "tone/build/esm/classes.js",
      "remotion",
      "@remotion/player",
      "@remotion/media",
      "@remotion/web-renderer",
    ],
  },
  worker: { format: "iife" },
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fs.realpathSync(new URL("./node_modules", import.meta.url)),
      ],
    },
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
