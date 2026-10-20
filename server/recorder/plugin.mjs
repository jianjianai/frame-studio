import { Recorder } from "./index.mjs";
import { readJson } from "../http.mjs";

export async function recorderPlugin(services) {
  const { router, settings } = services;
  const recorder = (services.recorder = new Recorder(services));
  await recorder.reload();
  services.closers.push(() => recorder.stop());
  // A changed custom API profile may add an upstream host to intercept.
  services.events.subscribe((event) => {
    if (event.type === "settings" && event.key === "ai") recorder.reload();
  });

  router.get("/api/recorder", () => recorder.status());
  router.patch("/api/recorder", async ({ req }) => {
    const body = await readJson(req);
    settings.update("recorder", (current) => ({
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      url: typeof body.url === "string" ? body.url.trim() : current.url,
      connections: Number.isInteger(body.connections) ? Math.min(32, Math.max(1, body.connections)) : current.connections,
    }));
    if (typeof body.key === "string") settings.setSecret("recorderKey", body.key.trim());
    await recorder.reload();
    return recorder.status();
  });
}
