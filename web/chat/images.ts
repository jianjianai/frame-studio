/** Formats every supported model accepts in a prompt. */
const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_SIDE = 2000;
const MAX_BYTES = 3_500_000; // models reject images over about 5 MB once base64-encoded

const readDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/**
 * An image the user pasted, as base64 the AI models accept: other formats (BMP, SVG…),
 * very large or very big files are redrawn as PNG/JPEG at most 2000 px on the long side.
 */
export async function readImage(file: File): Promise<{ data: string; mimeType: string }> {
  const dataUrl = await readDataUrl(file);
  const image = new Image();
  image.src = dataUrl;
  const decoded = await image.decode().then(
    () => true,
    () => false,
  );
  const width = image.naturalWidth || 1024;
  const height = image.naturalHeight || 1024;
  if (!decoded || (ACCEPTED.includes(file.type) && file.size <= MAX_BYTES && Math.max(width, height) <= MAX_SIDE))
    return { data: dataUrl.split(",")[1], mimeType: file.type };
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  let out = canvas.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
  if (out.length > MAX_BYTES * 1.3) out = canvas.toDataURL("image/jpeg", 0.85);
  return { data: out.split(",")[1], mimeType: out.slice(5, out.indexOf(";")) };
}
