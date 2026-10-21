import path from "node:path";
import { Renderer } from "./render.mjs";
import { Tasks } from "./tasks.mjs";
import { Exports } from "./exports.mjs";
import { ToolRegistry } from "./tools/registry.mjs";
import { registerWorkTools } from "./tools/work-tools.mjs";
import { registerPreviewTools } from "./tools/preview-tools.mjs";
import { registerAssetTools } from "./tools/asset-tools.mjs";
import { registerDocumentTools } from "./tools/document-tools.mjs";
import { registerExportTools } from "./tools/export-tools.mjs";
import { registerGuideTools } from "./tools/guide-tools.mjs";
import { registerSearchTools } from "./tools/search-tools.mjs";
import { mcpPlugin } from "./mcp.mjs";
import { oauthPlugin } from "./oauth.mjs";
import { experiencePlugin } from "./experience.mjs";
import { librariesPlugin } from "./libraries.mjs";
import { promptsPlugin } from "./prompts.mjs";
import { materialsPlugin } from "./materials.mjs";
import { reviewsPlugin } from "./reviews.mjs";
import { skillsPlugin } from "./skills.mjs";
import { resourcesPlugin } from "./resources.mjs";
import { assetPreviewsPlugin } from "./asset-previews.mjs";
import { coversPlugin } from "./covers.mjs";
import { remoteSyncPlugin } from "./remote-sync.mjs";
import { uploadsPlugin } from "./uploads.mjs";
import { browserPlugin } from "./browser.mjs";
import { blenderPlugin } from "./blender.mjs";
import { studioRoutes } from "./routes/studio.mjs";
import { aiPlugin } from "./ai/routes.mjs";
import { recorderPlugin } from "./recorder/plugin.mjs";
import { speechPlugin } from "./speech/plugin.mjs";
import { beatThisModel } from "./audio-analysis.mjs";

/** Rendering, tasks, materials, exports and the shared tool registry. */
function corePlugin(services) {
  services.tasks = new Tasks(services.events);
  services.renderer = new Renderer(services);
  services.exports = new Exports(services);
  services.checks = new Map();
  services.viewState = new Map();
  services.events.subscribe((event) => {
    if (event.type === "preview-state" && event.work) services.viewState.set(`${event.repo}/${event.work}`, { ...event, at: new Date().toISOString() });
  });
  services.closers.push(() => services.renderer.close());

  const tools = (services.tools = new ToolRegistry(services));
  registerGuideTools(tools);
  registerWorkTools(tools);
  registerPreviewTools(tools);
  registerAssetTools(tools);
  registerDocumentTools(tools);
  registerExportTools(tools);
  registerSearchTools(tools);
}

/**
 * The models features need, fetched into the data folder as the studio starts when they are
 * not there (config.downloadModels, the Docker image): voice input's and beat analysis's.
 * Nothing waits for them; a failed download is tried again every ten minutes, and until then
 * the feature says what is missing.
 */
function modelsPlugin(services) {
  if (!services.config.downloadModels) return;
  const fetchUntilThere = (name, fetch) => {
    const attempt = () =>
      fetch().then(
        () => console.log(`${name}已就绪`),
        (error) => {
          console.warn(`${name}下载失败，10 分钟后再试：${error.message}`);
          setTimeout(attempt, 10 * 60 * 1000).unref();
        },
      );
    attempt();
  };
  services.starters.push(() => {
    fetchUntilThere("语音输入模型", () => services.speech.ensureRecognition());
    fetchUntilThere("节拍模型", () => beatThisModel(path.join(services.config.dirs.models, "beat-this")));
  });
}

export const plugins = [corePlugin, speechPlugin, modelsPlugin, librariesPlugin, experiencePlugin, materialsPlugin, reviewsPlugin, skillsPlugin, resourcesPlugin, assetPreviewsPlugin, coversPlugin, remoteSyncPlugin, uploadsPlugin, browserPlugin, blenderPlugin, promptsPlugin, mcpPlugin, oauthPlugin, studioRoutes, recorderPlugin, aiPlugin];
