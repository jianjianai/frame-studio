import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/content/**/*.test.ts",
      "projects/*/tests/unit/**/*.test.ts",
    ],
    environment: "node",
  },
});
