import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createSharedSpeechModels,
  loadOfficialSpeechModels,
} from "../../integrations/paseo/speech-models.mjs";

/**
 * Use the installed official catalog and real shared cache/consumer wait path.
 * Only the trusted archive downloader is held pending: no speech-ready claim or external transfer.
 */
export async function holdSharedSpeechPreparation(
  manager,
  { runtimeRoot = process.env.FRAME_PASEO_ROOT } = {},
) {
  assert.equal(
    manager.speechModelsPromise,
    undefined,
    "Install the owned downloader before native startup",
  );
  assert(runtimeRoot, "Select the actual pinned Paseo runtime");
  const { catalog } = await loadOfficialSpeechModels(runtimeRoot);
  let calls = 0,
    aborted = false;
  const models = createSharedSpeechModels({
    data: manager.data,
    runtimeRoot,
    catalog,
    assertLeadership: () => manager.assertStartupOwner(),
    downloader: ({ signal }) => {
      calls++;
      return new Promise((_resolve, reject) => {
        const cancel = () => {
          aborted = true;
          reject(signal.reason || Error("Owned speech preparation cancelled"));
        };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  manager.speechModelsPromise = Promise.resolve(models);
  return {
    get calls() {
      return calls;
    },
    get aborted() {
      return aborted;
    },
    async state() {
      return JSON.parse(
        await fs.readFile(
          path.join(manager.data, "paseo-models/.frame-speech-state.json"),
          "utf8",
        ),
      );
    },
    close: () => models.close(),
  };
}
