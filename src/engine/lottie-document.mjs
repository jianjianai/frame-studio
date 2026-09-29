/** Shared import/probe/runtime contract for self-contained Lottie Canvas data. */
export function validateLottie(data) {
  if (
    !data ||
    !Number.isFinite(data.fr) ||
    data.fr <= 0 ||
    data.fr > 240 ||
    !Number.isFinite(data.ip) ||
    !Number.isFinite(data.op) ||
    data.op <= data.ip ||
    !Number.isFinite(data.w) ||
    !Number.isFinite(data.h) ||
    data.w <= 0 ||
    data.h <= 0 ||
    data.w > 16384 ||
    data.h > 16384 ||
    !Array.isArray(data.layers)
  )
    throw new Error("Invalid Lottie dimensions, timing or layers");
  const visit = (node, depth = 0) => {
    if (depth > 100) throw new Error("Lottie nesting is too deep");
    if (!node || typeof node !== "object") return;
    if (
      typeof node.p === "string" &&
      !/^data:image\/(png|jpeg|webp);base64,/.test(node.p)
    )
      throw new Error("Lottie images must be embedded PNG/JPEG/WebP data");
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(data);
  return data;
}
