#!/usr/bin/env node
import { createApp } from "./app.mjs";
import { plugins } from "./plugins.mjs";

const app = await createApp({ plugins });
const url = await app.listen();
console.log(`FRAME Studio ${url}`);
console.log(`数据目录 ${app.services.config.home}`);

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  console.log(`\n${signal}: 正在关闭…`);
  const timer = setTimeout(() => process.exit(1), 8000);
  try {
    await app.close();
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
