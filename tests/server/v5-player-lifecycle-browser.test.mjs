import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "../../scripts/browser.mjs";

// A transport/lifecycle harness, not a video-render quality or external-model fixture.
const component = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePreviewSession } from '/studio/preview-session.js';
import { useBrowserExport } from '/studio/browser-export-session.js';
const latest = {id:'lifecycle-preview', source_commit:'a'.repeat(40), result:{previewVersion:10}};
function Harness() {
  const frame = useRef(null), reset = useRef(()=>{});
  const [resets, setResets] = useState(0), [mode, setMode] = useState('ignore-all'), [panel, setPanel] = useState(true);
  const [notice, setNotice] = useState('');
  const local = useBrowserExport(frame, setNotice, () => { setResets(v=>v+1); reset.current(); });
  const preview = usePreviewSession({workId:'test-work', latest, blocked:local.busy, notify:setNotice});
  reset.current = preview.restart;
  return <main>
    <p id="preview-error">{preview.error}</p>
    <button onClick={preview.retry}>Retry preview</button>
    <span id="version">{preview.reference.sourceCommit}</span>
    <select aria-label="scenario" value={mode} onChange={e=>setMode(e.target.value)}>
      <option value="ignore-all">No acknowledgement</option><option value="ignore-cancel">Late progress</option><option value="success">Success</option>
    </select>
    {preview.preview && <iframe key={preview.preview.id+':'+preview.playerGeneration+':'+mode} ref={frame} sandbox="allow-scripts" title="fixture player" src={preview.preview.url+'?mode='+mode} />}
    <button onClick={()=>local.start({width:320,fps:24,subtitles:false})}>Start export</button>
    <button onClick={local.cancel}>Cancel export</button>
    <button onClick={()=>setPanel(v=>!v)}>Toggle panel</button>
    <div id="panel" hidden={!panel}>A dock does not own the export session.</div>
    <p id="state">{local.job?.state||'idle'}</p><p id="error">{local.job?.error||''}</p>
    <p id="filename">{local.job?.filename||''}</p><p id="resets">{resets}</p><p id="notice">{notice}</p>
  </main>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;

const player = `<!doctype html><html><body>Lifecycle fixture<script>
const mode = new URLSearchParams(location.search).get('mode');
addEventListener('message', ({data}) => {
  if (data.type !== 'frame-player-command') return;
  if (data.command === 'export-start') {
    window.lastRequest = data.id;
    if (mode === 'ignore-all') return;
    parent.postMessage({type:'frame-export-state',id:data.id,state:'running',progress:{phase:'rendering',completed:1,total:10}}, '*');
    if (mode === 'success') setTimeout(()=>parent.postMessage({type:'frame-export-state',id:data.id,state:'succeeded',filename:'../fixture.webm',blob:new Blob(['fixture-bytes'],{type:'video/webm'})}, '*'), 20);
  }
  if (data.command === 'export-cancel' && mode === 'ignore-cancel') {
    // Old progress can arrive after cancellation, but cannot revive the running state.
    setTimeout(()=>parent.postMessage({type:'frame-export-state',id:window.lastRequest,state:'running',progress:{phase:'rendering',completed:2,total:10}}, '*'), 20);
  }
});
window.lifecycleReady = true;
</script></body></html>`;

test(
  "V5 browser lifecycle: retry uses existing preview, lost export acknowledgements terminate the iframe and closed panels retain state",
  { timeout: 60000 },
  async () => {
    let capabilityRequests = 0;
    let allowCapability = false;
    const virtualFile = path.resolve("tests/ui/v5-lifecycle-fixture.jsx");
    const cacheDir = path.resolve(".cache/tests/v5-player-lifecycle-" + randomUUID());
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir,
      logLevel: "error",
      appType: "custom",
      optimizeDeps: {
        include: [
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
          "lucide-react",
          "zod",
        ],
      },
      server: { host: "127.0.0.1", port: 0, watch: null },
      plugins: [
        react(),
        {
          name: "v5-lifecycle-fixture",
          resolveId(id) {
            if (
              [
                "/v5-lifecycle.jsx",
                "/tests/ui/v5-lifecycle-fixture.jsx",
                virtualFile,
              ].includes(id)
            )
              return virtualFile;
          },
          load(id) {
            if (id === virtualFile) return component;
          },
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url === "/__v5-lifecycle") {
                res.setHeader("Content-Type", "text/html");
                void vite
                  .transformIndexHtml(
                    req.url,
                    '<!doctype html><html><body><div id="root"></div><script type="module" src="/v5-lifecycle.jsx"></script></body></html>',
                  )
                  .then((html) => res.end(html), next);
              } else if (req.url?.startsWith("/__player")) {
                res.setHeader("Content-Type", "text/html");
                res.end(player);
              } else if (req.url === "/api/tasks/lifecycle-preview/preview") {
                res.setHeader("Content-Type", "application/json");
                capabilityRequests++;
                res.statusCode = allowCapability ? 200 : 503;
                res.end(
                  JSON.stringify(
                    !allowCapability
                      ? { error: "Temporary preview connection failure" }
                      : {
                          url: "/__player",
                          expires: new Date(Date.now() + 3600000).toISOString(),
                        },
                  ),
                );
              } else next();
            });
          },
        },
      ],
    });
    let browser;
    try {
      await server.listen();
      const address = server.httpServer.address();
      browser = await launchBrowser();
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Speed up only the two 15-second acknowledgement deadlines, not the playback clock.
      await page.addInitScript(() => {
        const original = window.setTimeout;
        window.setTimeout = (fn, delay, ...args) =>
          original(fn, delay === 15000 ? 1000 : delay, ...args);
      });
      await page.goto(`http://127.0.0.1:${address.port}/__v5-lifecycle`);
      await expect(page.locator("#preview-error")).toContainText(
        "Temporary preview connection failure",
      );
      const failedRequests = capabilityRequests;
      allowCapability = true;
      await page
        .getByRole("button", { name: "Retry preview", exact: true })
        .click();
      await expect(page.locator("iframe")).toBeVisible();
      await expect(page.locator("#version")).toHaveText("a".repeat(40));
      await expect(page.locator("#preview-error")).toBeEmpty();
      assert.equal(
        capabilityRequests,
        failedRequests + 1,
        "retry fetches the existing build capability only",
      );
      const readyFrame = async () => {
        const frame = await page
          .locator("iframe")
          .elementHandle()
          .then((el) => el.contentFrame());
        await frame.waitForFunction(() => window.lifecycleReady === true);
        return frame;
      };
      await readyFrame();
      await page
        .getByRole("button", { name: "Start export", exact: true })
        .click();
      await expect(page.locator("#state")).toHaveText("failed");
      await expect(page.locator("#resets")).toHaveText("1");
      await expect(page.locator("#error")).toContainText("未确认导出请求");
      await page.getByLabel("scenario").selectOption("ignore-cancel");
      await readyFrame();
      await page
        .getByRole("button", { name: "Start export", exact: true })
        .click();
      await expect(page.locator("#state")).toHaveText("running");
      await page
        .getByRole("button", { name: "Toggle panel", exact: true })
        .click();
      await expect(page.locator("#panel")).toBeHidden();
      await expect(page.locator("#state")).toHaveText("running");
      await page
        .getByRole("button", { name: "Cancel export", exact: true })
        .click();
      await page.waitForTimeout(60);
      await expect(page.locator("#state")).toHaveText("cancelling");
      await expect(page.locator("#state")).toHaveText("failed");
      await expect(page.locator("#resets")).toHaveText("2");
      await page.getByLabel("scenario").selectOption("success");
      const activeFrame = await readyFrame();
      await page
        .getByRole("button", { name: "Start export", exact: true })
        .click();
      await expect(page.locator("#state")).toHaveText("succeeded");
      await expect(page.locator("#filename")).toHaveText(".._fixture.webm");
      await activeFrame.evaluate(() =>
        parent.postMessage(
          {
            type: "frame-export-state",
            id: window.lastRequest,
            state: "failed",
            error: "late terminal overwrite",
          },
          "*",
        ),
      );
      await page.waitForTimeout(60);
      await expect(page.locator("#state")).toHaveText("succeeded");
      assert.equal(
        capabilityRequests,
        failedRequests + 1,
        "resetting an unresponsive player does not rebuild the work",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  },
);
