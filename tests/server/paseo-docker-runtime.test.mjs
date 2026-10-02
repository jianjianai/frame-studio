import test from "node:test";
import assert from "node:assert/strict";
import { dockerRuntimeFixture } from "./paseo-docker-runtime-fixture.mjs";

test(
  "Production Docker Paseo: six bounded native startups, exact image/UID/network, FRAME plugin and authenticated selected-profile work bridge",
  { skip: process.env.FRAME_TEST_EXECUTOR !== "1", timeout: 240000 },
  async (t) => {
    const report = await dockerRuntimeFixture(t);
    assert.equal(report.readyWorks.length, 6);
    assert(report.maximumStarting > 0 && report.maximumStarting <= 2);
    assert.equal(report.checks.length, 4);
    assert.equal(report.sharedSpeech.state, "preparing");
    assert.equal(report.sharedSpeech.speechReadyClaimed, false);
    assert.equal(report.sharedSpeechDownloadAborted, true);
    assert.equal(report.selectedCredentialHashVerified, true);
    assert.equal(report.noPaidProvider, true);
    t.diagnostic(JSON.stringify(report));
  },
);
