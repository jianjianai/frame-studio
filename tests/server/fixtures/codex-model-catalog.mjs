import readline from "node:readline";
const scenario = process.env.FRAME_CATALOG_FIXTURE || "paged";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (!id) continue;
  if (scenario === "timeout") continue;
  if (scenario === "error") {
    process.stdout.write(
      JSON.stringify({ id, error: { message: "secret-fixture-token" } }) + "\n",
    );
    continue;
  }
  let result;
  if (method === "initialize") result = { userAgent: "fixture" };
  else if (method === "account/read")
    result = {
      account: { type: scenario === "api-account" ? "apiKey" : "chatgpt" },
    };
  else if (method === "model/list") {
    if (params.includeHidden !== false) process.exit(2);
    const model = {
      id: "catalog-entry",
      model: "native-one",
      displayName: "Native One",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "max" },
      ],
      inputModalities: ["text", "image"],
      contextWindow: 300000,
      maxOutputTokens: 40000,
    };
    if (scenario === "oversize") {
      process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
      continue;
    }
    result =
      scenario === "invalid"
        ? { unexpected: [] }
        : scenario === "empty"
          ? { data: [], nextCursor: null }
          : scenario === "cycle"
            ? { data: [model], nextCursor: "same" }
            : params.cursor
              ? {
                  data: [{ model: "native-two", displayName: "Native Two" }],
                  nextCursor: null,
                }
              : {
                  data: [
                    model,
                    model,
                    { model: "hidden", hidden: true },
                    { model: "bad\u0000id" },
                  ],
                  nextCursor: "next",
                };
  } else process.exit(3); // Catalog discovery must never create a thread or inference turn.
  process.stdout.write("null\n" + JSON.stringify({ id, result }) + "\n");
}
