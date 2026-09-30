import path from "node:path";

/** Only Vite's content-addressed public JS/CSS are immutable across releases. */
export function publicStaticHeaders(response, file, root) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const immutable = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(
    relative,
  );
  response.header(
    "Cache-Control",
    immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
}
