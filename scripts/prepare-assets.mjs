const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--project" || args[1] !== "paper-wings")
  throw new Error(
    "Usage: pnpm assets --project paper-wings (only this demo has generated illustrations)",
  );
await import("../projects/paper-wings/scripts/prepare-art.mjs");
