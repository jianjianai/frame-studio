import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

export async function browserVersion() {
  const executable = browserOptions().executablePath;
  const execute = promisify(execFile);
  // Windows GUI browsers may ignore --version and open a persistent window.
  // Read their executable metadata without launching the browser.
  const { stdout } = process.platform === "win32"
    ? await execute(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; [Diagnostics.FileVersionInfo]::GetVersionInfo($env:FRAME_BROWSER_PROBE).ProductVersion"],
      { windowsHide: true, timeout: 15000, env: { ...process.env, FRAME_BROWSER_PROBE: executable } })
    : await execute(executable, ["--version"], { timeout: 15000 });
  const version = stdout.trim();
  if (!version) throw Error("Could not read browser version: " + executable);
  return version;
}
