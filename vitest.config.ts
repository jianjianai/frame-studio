import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    globalSetup: ["tests/setup/temp.mjs"],
  },
});
