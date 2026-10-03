import { AsyncLocalStorage } from "node:async_hooks";
import {
  McpServer,
  createMcpHandler,
  readRequestBody,
  isJsonContentType,
} from "@modelcontextprotocol/server";
import { isMcpOperation, toolAnnotations } from "./platform-toolkit.mjs";

function freezeJson(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Share immutable schemas and descriptors, while each HTTP exchange owns its
 * server, validation context and transport. No SDK private fields are used.
 */
export function createPreparedMcpHandler({
  registry,
  execute,
  serverInfo,
  options = {},
}) {
  const catalog = new Map();
  const definitions = [];
  for (const [name, op] of Object.entries(registry)) {
    if (!isMcpOperation(name)) continue;
    const standard = op.schema["~standard"];
    const json = freezeJson(
      standard.jsonSchema.input({ target: "draft-2020-12" }),
    );
    // Keep the original Standard Schema validator, including defaults/refinements.
    const schema = Object.freeze({
      "~standard": Object.freeze({
        version: 1,
        vendor: "frame",
        validate: standard.validate.bind(standard),
        jsonSchema: Object.freeze({ input: () => json, output: () => json }),
      }),
    });
    const definition = freezeJson({
      name: "frame_" + name,
      description: op.description,
      inputSchema: { type: "object", ...json },
      annotations: toolAnnotations(name),
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: ["frame:workbench"] }],
      },
    });
    definitions.push(definition);
    catalog.set(definition.name, {
      config: Object.freeze({ ...definition, inputSchema: schema }),
      call: (args, ctx) => execute(name, args, ctx),
    });
  }
  Object.freeze(definitions);
  const requests = new AsyncLocalStorage();
  const handler = createMcpHandler(() => {
    const server = new McpServer(serverInfo, {
      capabilities: { tools: { listChanged: true } },
    });
    const message = requests.getStore();
    const messages = Array.isArray(message) ? message : [message];
    const names = new Set(
      messages
        .filter((entry) => entry?.method === "tools/call")
        .map((entry) => entry.params?.name),
    );
    for (const name of names) {
      const tool = catalog.get(name);
      if (tool) server.registerTool(name, tool.config, tool.call);
    }
    server.server.setRequestHandler("tools/list", () => ({
      tools: definitions,
    }));
    return server;
  }, options);
  return {
    ...handler,
    async fetch(request, requestOptions = {}) {
      let parsedBody = requestOptions.parsedBody;
      if (
        parsedBody === undefined &&
        request.method === "POST" &&
        isJsonContentType(request.headers.get("content-type"))
      ) {
        try {
          const body = await readRequestBody(
            request.clone(),
            options.maxRequestBodySize,
          );
          if (!body.tooLarge) parsedBody = JSON.parse(body.text);
        } catch {
          // Keep malformed, aborted and oversized requests on the SDK error path.
        }
      }
      // The legacy SDK may clone Request. Request-local context survives that
      // clone and concurrent modern/legacy exchanges cannot select each other.
      return requests.run(parsedBody, () =>
        handler.fetch(request, {
          ...requestOptions,
          ...(parsedBody !== undefined ? { parsedBody } : {}),
        }),
      );
    },
  };
}
