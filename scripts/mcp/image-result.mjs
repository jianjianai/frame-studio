import sharp from "sharp";
import { fail, sha256 } from "./workspace.mjs";

const MAX_INLINE = 1024 * 1024;
/** Keep the original artifact intact; bound the model-facing image independently. */
export async function imageResult(
  bytes,
  info,
  { presentation = "native", maxWidth = 1600 } = {},
) {
  if (
    !["native", "image-only", "metadata"].includes(presentation) ||
    !Number.isInteger(maxWidth) ||
    maxWidth < 320 ||
    maxWidth > 2048
  )
    fail(
      "INVALID_OPTIONS",
      "Use native, image-only or metadata and maxWidth 320..2048.",
    );
  if (bytes.length > 32 * 1024 * 1024)
    fail("TOO_LARGE", "Image source exceeds 32 MiB.");
  const source = sharp(bytes, { limitInputPixels: 40_000_000 });
  const metadata = await source.metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height)
    fail("INVALID_IMAGE", "Expected a valid PNG artifact.");
  const detail = {
    ...info,
    source: {
      width: metadata.width,
      height: metadata.height,
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
    visualInspection: "not_confirmed",
  };
  if (presentation === "metadata")
    return {
      content: [{ type: "text", text: JSON.stringify(detail) }],
      structuredContent: detail,
    };
  let output = bytes;
  let edge = maxWidth;
  if (
    metadata.width > edge ||
    metadata.height > edge ||
    bytes.length > MAX_INLINE
  ) {
    for (let attempt = 0; attempt < 8; attempt++) {
      output = await source
        .clone()
        .resize({
          width: edge,
          height: edge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
      if (output.length <= MAX_INLINE) break;
      edge = Math.max(160, Math.floor(edge * 0.75));
    }
  }
  if (output.length > MAX_INLINE)
    fail(
      "TOO_LARGE",
      "Use metadata presentation and an authenticated download, or generate a smaller preview.",
    );
  const shown = await sharp(output).metadata();
  const image = {
    type: "image",
    mimeType: "image/png",
    data: output.toString("base64"),
    annotations: { audience: ["assistant", "user"] },
  };
  if (presentation === "image-only") return { content: [image] };
  detail.display = {
    width: shown.width,
    height: shown.height,
    bytes: output.length,
    sha256: sha256(output),
    resized: !bytes.equals(output),
  };
  detail.nextAction =
    "Inspect the returned image before judging visual quality. If the client omits it, retry presentation=image-only; a file link alone is not visual inspection.";
  return {
    content: [image, { type: "text", text: JSON.stringify(detail) }],
    structuredContent: detail,
  };
}
