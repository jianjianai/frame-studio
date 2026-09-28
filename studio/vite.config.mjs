import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: "../studio-dist", emptyOutDir: true },
  server: { host: "127.0.0.1" },
});
