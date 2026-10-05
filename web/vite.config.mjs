import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Production build of the studio UI. Works and the preview stage are always compiled live by the server. */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "web/dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: fileURLToPath(new URL("index.html", import.meta.url)) },
  },
});
