import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "../../scripts/browser.mjs";

test(
  "chat retries send the frozen payload after a lost acknowledgement and player movement",
  { timeout: 60000 },
  async (t) => {
    const entry = "virtual:chat-retry";
    const server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("../../", import.meta.url)),
      server: {
        host: "127.0.0.1",
        port: Number(process.env.FRAME_TEST_PORT || 55194),
        strictPort: true,
        watch: { ignored: ["**/.cache/**"] },
      },
      plugins: [
        react(),
        {
          name: "chat-retry-fixture",
          resolveId: (id) => (id === entry ? "\0" + entry : undefined),
          load: (id) =>
            id === "\0" + entry
              ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { WorkChat } from '/studio/creation.jsx';
        function Fixture() {
          const [position, setPosition] = React.useState({ time: 5, selection: { start: 4, end: 6 } });
          const [error, setError] = React.useState('');
          return React.createElement(React.Fragment, null,
            React.createElement('button', { onClick: () => setPosition({ time: 10, selection: { start: 9, end: 11 } }) }, 'Move player'),
            React.createElement('output', { id: 'error' }, error),
            React.createElement(WorkChat, { work: { id: 'work' }, tasks: [], reload() {}, notify: setError,
              position, selectedAssets: [{ id: 'asset', name: 'Fixture asset' }], onClearAssets() {} }));
        }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      `
              : undefined,
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url !== "/__chat_retry") return next();
              try {
                const html = await vite.transformIndexHtml(
                  req.url,
                  '<div id="root"></div><script type="module" src="/@id/virtual:chat-retry"></script>',
                );
                res.setHeader("Content-Type", "text/html");
                res.end(html);
              } catch (error) {
                next(error);
              }
            });
          },
        },
      ],
    });
    let browser;
    try {
      await server.listen();
      browser = await launchBrowser();
      for (const existing of [true, false])
        await t.test(
          existing ? "existing conversation" : "new conversation",
          async () => {
            const page = await browser.newPage();
            const errors = [],
              requests = [],
              turns = new Map();
            let chat = existing
              ? { id: "chat", connection: "connection", title: "Fixture chat" }
              : null;
            let creates = 0;
            page.on("pageerror", (error) => errors.push(error.message));
            await page.routeWebSocket("**/api/ws", (socket) => {
              socket.onMessage((raw) => {
                const message = JSON.parse(String(raw));
                if (message.type === "unsubscribe") return;
                const reply = (result) =>
                  socket.send(
                    JSON.stringify({
                      type: message.type === "subscribe" ? "update" : "result",
                      id: message.id,
                      result,
                    }),
                  );
                switch (message.name) {
                  case "connections_list":
                    return reply([
                      {
                        id: "connection",
                        name: "Fixture connection",
                        configured: true,
                      },
                    ]);
                  case "works_chats":
                    return reply(chat ? [chat] : []);
                  case "works_chat_turns":
                    return reply([]);
                  case "works_chat_create":
                    creates++;
                    chat = {
                      id: "created-chat",
                      connection: "connection",
                      title: "New fixture chat",
                    };
                    return reply(chat);
                  case "works_chat_send": {
                    requests.push(message.args);
                    const previous = turns.get(message.args.requestKey);
                    if (!previous) {
                      turns.set(message.args.requestKey, message.args);
                      // Commit the request, then lose its acknowledgement on the wire.
                      return socket.close({
                        code: 1011,
                        reason: "Lost acknowledgement fixture",
                      });
                    }
                    if (
                      JSON.stringify(previous) !== JSON.stringify(message.args)
                    )
                      return socket.send(
                        JSON.stringify({
                          type: "result",
                          id: message.id,
                          status: 409,
                          error: "Message request key already used",
                        }),
                      );
                    return reply({ id: "task", state: "queued" });
                  }
                  default:
                    throw Error("Unexpected fixture request: " + message.name);
                }
              });
            });
            try {
              await page.goto(
                `http://127.0.0.1:${server.httpServer.address().port}/__chat_retry`,
              );
              await page.waitForFunction(
                () =>
                  document.querySelector('[aria-label="模型连接"]')?.value ===
                  "connection",
              );
              await page
                .getByLabel("创作要求", { exact: true })
                .fill("Adjust motion");
              await page.getByRole("checkbox").check();
              await page
                .getByRole("button", { name: "发送", exact: true })
                .click();
              await page.waitForFunction(() =>
                document
                  .querySelector("#error")
                  ?.textContent.includes("连接中断"),
              );
              await page
                .getByRole("button", { name: "Move player", exact: true })
                .click();
              await page
                .getByText("附带当前画面 10.00s", { exact: true })
                .waitFor();
              await page
                .getByRole("button", { name: "发送", exact: true })
                .click();
              await page.waitForFunction(
                () =>
                  document
                    .querySelector(".chat-composer button.primary")
                    ?.textContent.trim() === "发送",
              );
              assert.equal(requests.length, 2);
              assert.deepEqual(requests[1], requests[0]);
              assert.deepEqual(requests[1].context, {
                time: 5,
                start: 4,
                end: 6,
                assets: ["asset"],
              });
              assert.equal(turns.size, 1);
              assert.equal(creates, existing ? 0 : 1);
              assert.equal(
                await page.getByLabel("创作要求", { exact: true }).inputValue(),
                "",
              );
              assert.deepEqual(errors, []);
            } finally {
              await page.close();
            }
          },
        );
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
