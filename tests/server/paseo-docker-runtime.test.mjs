import test from "node:test";
import assert from "node:assert/strict";
import { dockerRuntimeFixture } from "./paseo-docker-runtime-fixture.mjs";

test(
  "Production Docker Paseo: six bounded native startups, exact image/UID/network, selected-profile work bridge and canonical Git/validation",
  { skip: process.env.FRAME_TEST_EXECUTOR !== "1", timeout: 300000 },
  async (t) => {
    const report = await dockerRuntimeFixture(t);
    assert.equal(report.readyWorks.length, 6);
    assert(report.maximumStarting > 0 && report.maximumStarting <= 2);
    assert.equal(report.checks.length, 4);
    assert.equal(report.sharedSpeech.state, "preparing");
    assert.equal(report.sharedSpeech.speechReadyClaimed, false);
    assert.equal(report.sharedSpeechDownloadAborted, true);
    assert.equal(report.selectedCredentialHashVerified, true);
    assert.equal(report.sharedGitIndexVerified, true);
    assert.equal(report.canonicalValidation.state, "passed");
    assert.match(report.canonicalValidation.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.canonicalValidation.checks,
      ["scope", "structure", "project-tests", "project-types", "runtime"]);
    assert.equal(report.noPaidProvider, true);
    t.diagnostic(JSON.stringify(report));
  },
);
