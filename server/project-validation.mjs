import path from "node:path";

/** Shared gates for isolated project results; the caller owns process limits and metrics. */
export async function validateProject({
  core,
  work,
  project,
  baselineCommit,
  run,
  measured,
}) {
  await measured(
    "scope",
    () =>
      run("node", [
        path.join(core, "scripts/project-scope.mjs"),
        project,
        "--base",
        baselineCommit,
      ]),
    { check: true },
  );
  await measured(
    "structure",
    () =>
      run("node", [
        path.join(core, "scripts/check-projects.mjs"),
        project,
        "--strict",
      ]),
    { check: true },
  );
  await measured(
    "project-tests",
    () =>
      run("node", [
        path.join(core, "scripts/film.mjs"),
        "test",
        project,
        "--json",
      ]),
    { check: true },
  );
  await measured(
    "project-types",
    async () => {
      const checked = JSON.parse(
        await run("node", [
          path.join(work, "scripts/film.mjs"),
          "typecheck",
          project,
          "--json",
        ]),
      );
      if (checked.status !== "passed")
        throw new Error("Work type validation failed");
    },
    { check: true },
  );
}
