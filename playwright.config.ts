import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { defineConfig } from "@playwright/test";
const executablePath = [
  process.env.FRAME_BROWSER,
  chromium.executablePath(),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => p && existsSync(p));
const testPort = Number(process.env.FRAME_TEST_PORT ?? 4173);
if (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535)
  throw new Error("FRAME_TEST_PORT must be an integer from 1024 to 65535");
const testURL = "http://127.0.0.1:" + testPort;
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: testURL,
    viewport: { width: 1440, height: 1000 },
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath,
      args: ["--enable-webgl", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: testURL,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
