import fs from "node:fs";

const remoteNames = [
  "assets",
  "engines",
  "speech_providers",
  "engines_discover",
  "speech_status",
  "speech_cancel",
  "engine_add",
  "engine_test",
  "use",
  "speech",
];
export const workToolHelp = {
  schemaVersion: 1,
  guide: "docs/CREATOR-WORKFLOW.md",
  input:
    "JSON object, @file, or - for stdin. Credentials belong in @file or stdin, never command arguments.",
  local: {
    capabilities: {
      category: "optional visual|media|animation|audio",
      query: "optional case-insensitive text, at most 200 characters",
      id: "optional exact capability id; omit all filters for the complete catalog",
      note: "Visual/audio frameworks and animation helpers; engines below lists configured speech services.",
    },
    context: { project: "optional outside a task; inferred inside a task" },
    reference: {
      name: "optional fixed reference name; omit to list the catalog",
    },
    check: {
      project: "optional",
      runtime:
        "boolean, default false; true adds short playback and a storyboard",
      start: "optional seconds",
      end: "optional seconds, at most 6 seconds after start",
    },
  },
  remote: {
    ask: {
      title: "optional short creative clarification",
      questions:
        "1..4 questions with id, question, optional options, multiSelect and allowOther; waits for human answers in the SAME task",
      requestKey: "optional stable id for resuming the same question",
    },
    assets: {
      search: "optional text",
      limit: "1..200, default 60",
      offset: "nonnegative integer, default 0",
    },
    engines: {
      note: "Provider/model capabilities, built-in voices and credential presence; no secrets",
    },
    speech_providers: {},
    engines_discover: {
      engine: "required existing engine id",
      cursor: "optional nextCursor from ElevenLabs",
      search: "optional voice search",
    },
    speech_status: { requestId: "required synthesis request UUID" },
    speech_cancel: {
      requestId:
        "required synthesis request UUID; remote requests may still be billed",
    },
    engine_add: {
      name: "required",
      url: "required provider API base URL",
      provider:
        "optional compatible|openai|minimax|doubao|elevenlabs|qwen3; discover presets first",
      model: "required",
      voice: "default voice id; ElevenLabs may omit until catalog discovery",
      apiKey: "optional secret",
    },
    engine_test: {
      engine: "required engine id",
      text: "required audition text",
      voice: "optional",
      speed: "optional; engine capabilities.speed range, default 1",
      options:
        "optional model-supported expression object: instructions, emotion, language, pitch, pauses, pronunciation, stability, similarity, style, dictionaries, previousText, nextText. Read engines capabilities first.",
      fallback: "error (default) or explicit omit, which returns warnings",
      requestId:
        "optional fresh UUID for progress/cancellation; never repeat an accepted ID",
    },
    use: { asset: "required material id from this repository" },
    speech: {
      engine: "required engine id",
      text: "required final narration",
      voice: "optional",
      speed: "optional; engine capabilities.speed range, default 1",
      options:
        "optional model-supported expression object: instructions, emotion, language, pitch, pauses, pronunciation, stability, similarity, style, dictionaries, previousText, nextText. Read engines capabilities first.",
      fallback: "error (default) or explicit omit, which returns warnings",
      requestId:
        "optional fresh UUID for progress/cancellation; never repeat an accepted ID",
    },
  },
  notes: [
    "Local capabilities/context/reference/check do not need platform credentials. Remote actions require an active platform task.",
    "engines lists real model capabilities. Discover configured voice catalogs before auditioning. Chinese pronunciation/pauses are provider-specific; unsupported controls are rejected, never fabricated. Built-ins cannot be replaced.",
    "engine_test creates temporary audition audio; speech creates a material. Neither automatically edits audioTracks or subtitles.",
    "Remote writes are never retried automatically; after a timeout their outcome may be unknown. Inspect assets before repeating speech.",
  ],
};

export function toolError(code, message, nextAction, details = {}) {
  return Object.assign(new Error(message), { code, nextAction, ...details });
}

export function redactToolText(text, env = process.env) {
  let value = String(text);
  for (const [key, secret] of Object.entries(env))
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && secret?.length >= 8)
      value = value.split(secret).join("[redacted]");
  return value.replace(
    /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})/g,
    "[redacted]",
  );
}

export async function readToolInput(input = "{}", stdin = process.stdin) {
  const max = 256 * 1024;
  let text;
  if (input === "-") {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > max)
        throw toolError(
          "INPUT_TOO_LARGE",
          "JSON input exceeds 256 KiB.",
          "Use a smaller request.",
        );
      chunks.push(Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else if (input.startsWith("@")) {
    const stat = fs.statSync(input.slice(1));
    if (!stat.isFile() || stat.size > max)
      throw toolError(
        "INVALID_INPUT_FILE",
        "Input must be a regular JSON file no larger than 256 KiB.",
        "Check the @file path.",
      );
    text = fs.readFileSync(input.slice(1), "utf8");
  } else text = input;
  if (Buffer.byteLength(text) > max)
    throw toolError(
      "INPUT_TOO_LARGE",
      "JSON input exceeds 256 KiB.",
      "Use a smaller request.",
    );
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw toolError(
      "INVALID_JSON",
      "Expected a JSON object; request contents are omitted to protect credentials.",
      "Use @file or stdin (-) to avoid shell quoting errors.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw toolError(
      "INVALID_INPUT",
      "Expected a JSON object, not an array or null.",
      "Run node scripts/work-tool.mjs help --json.",
    );
  return value;
}

/** Bounded transport, no redirect credential forwarding and no replay of side effects. */
export async function callWorkTool(
  name,
  args,
  {
    env = process.env,
    fetchImpl = fetch,
    timeoutMs = 180000,
    maxBytes = 2 * 1024 * 1024,
  } = {},
) {
  if (!remoteNames.includes(name))
    throw toolError(
      "UNKNOWN_TOOL",
      "Unknown work tool: " + name,
      "Run node scripts/work-tool.mjs help --json.",
    );
  if (!env.FRAME_AGENT_URL || !env.FRAME_AGENT_TOKEN)
    throw toolError(
      "TASK_REQUIRED",
      "This action is available only inside an active platform AI task.",
      "Local context/check and pnpm film remain available without task credentials.",
    );
  let url;
  // @file/stdin credentials are not necessarily present in the process env.
  const redactions = { ...env };
  for (const [index, [key, value]] of Object.entries(args).entries())
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && typeof value === "string")
      redactions["REQUEST_SECRET_" + index] = value;
  try {
    url = new URL(env.FRAME_AGENT_URL.replace(/\/$/, "") + "/api/agent/action");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error();
  } catch {
    throw toolError(
      "INVALID_TASK_URL",
      "Invalid task API URL.",
      "Check the task runtime configuration; do not print credentials.",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const mutating = !["assets", "engines"].includes(name);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + env.FRAME_AGENT_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, args }),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw toolError(
        "UNEXPECTED_REDIRECT",
        "Task API redirected; credentials were not forwarded.",
        "Check FRAME_AGENT_URL rather than following the redirect.",
      );
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        controller.abort();
        throw toolError(
          "RESPONSE_TOO_LARGE",
          "Task API response exceeds the response budget.",
          mutating
            ? "The write may have completed. Inspect task/material state before repeating it."
            : "Use assets search/limit/offset to request a smaller page.",
          { outcome: mutating ? "unknown" : undefined },
        );
      }
      chunks.push(chunk);
    }
    let result;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw toolError(
        "INVALID_API_RESPONSE",
        "Task API did not return JSON (HTTP " + response.status + ").",
        "Check task connectivity and server health. The raw response was not printed.",
        {
          httpStatus: response.status,
          outcome: mutating ? "unknown" : undefined,
        },
      );
    }
    if (!response.ok) {
      const nextAction =
        response.status === 401 || response.status === 403
          ? "Check that this task is still active and has access to the material; do not replace credentials with another task's token."
          : response.status === 429
            ? "Wait for the service's retry window; do not repeatedly submit speech generation."
            : mutating
              ? "Inspect task/material state before repeating this write; it was not automatically retried."
              : "Check the request and task service, then retry this read.";
      throw toolError(
        "HTTP_" + response.status,
        redactToolText(
          result?.message ||
            result?.error?.message ||
            (typeof result?.error === "string"
              ? result.error
              : "Task API request failed"),
          redactions,
        ).slice(0, 2000),
        nextAction,
        {
          httpStatus: response.status,
          retryAfter: response.headers.get("retry-after") || undefined,
          outcome: mutating && response.status >= 500 ? "unknown" : undefined,
        },
      );
    }
    return JSON.parse(redactToolText(JSON.stringify(result), redactions));
  } catch (error) {
    if (error.nextAction) throw error;
    throw toolError(
      controller.signal.aborted ? "TASK_TIMEOUT" : "TASK_UNREACHABLE",
      controller.signal.aborted
        ? "Task API request timed out."
        : "Could not contact the task API.",
      mutating
        ? "The write outcome is unknown. Inspect task/material state before repeating it; no automatic retry was performed."
        : "Check task connectivity, then retry the read.",
      { outcome: mutating ? "unknown" : undefined },
    );
  } finally {
    clearTimeout(timer);
  }
}
