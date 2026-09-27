import fs from "node:fs";
import { chromium } from "@playwright/test";
export function browserOptions() {
  const options = {
    headless: true,
    args: [
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  };
  const candidates = [
    process.env.FRAME_BROWSER,
    chromium.executablePath(),
    ...(process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : [
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/google-chrome",
        ]),
  ];
  const executablePath = candidates.find((p) => p && fs.existsSync(p));
  if (!executablePath)
    throw new Error(
      "No Chromium browser found. Run: pnpm exec playwright install chromium; or set FRAME_BROWSER.",
    );
  return { ...options, executablePath };
}
export const launchBrowser = () => chromium.launch(browserOptions());
