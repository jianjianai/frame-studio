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
import { promptsPlugin } from "./prompts.mjs";
import { materialsPlugin } from "./materials.mjs";
import { coversPlugin } from "./covers.mjs";
import { remoteSyncPlugin } from "./remote-sync.mjs";
import { uploadsPlugin } from "./uploads.mjs";
import { studioRoutes } from "./routes/studio.mjs";
import { aiPlugin } from "./ai/routes.mjs";
import { speechPlugin } from "./speech/plugin.mjs";

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

export const plugins = [corePlugin, speechPlugin, experiencePlugin, materialsPlugin, coversPlugin, remoteSyncPlugin, uploadsPlugin, promptsPlugin, mcpPlugin, oauthPlugin, studioRoutes, aiPlugin];
