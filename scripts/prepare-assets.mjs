import { updateWaveforms } from "./waveforms.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { optimize } from "svgo";
const root = process.cwd();
const save = async (name, text) => {
  const p = path.join(root, "public", name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
};
const svg = (w, h, content) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="' +
  w +
  '" height="' +
  h +
  '" viewBox="0 0 ' +
  w +
  " " +
  h +
  '">' +
  content +
  "</svg>";
let seed = 791;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const house = (x, y, s, c) =>
  '<g transform="translate(' +
  x +
  " " +
  y +
  ") scale(" +
  s +
  ')"><rect x="-43" y="-85" width="86" height="85" rx="4" fill="' +
  c +
  '"/><path d="M-54-82L0-130 54-82Z" fill="#465f62"/><path d="M-49-87L0-130 49-87" fill="none" stroke="#e8b08b" stroke-width="5"/><rect x="-12" y="-36" width="24" height="36" rx="12" fill="#475f63"/><g fill="#ffedba"><rect x="-31" y="-65" width="17" height="23" rx="3"/><rect x="15" y="-65" width="17" height="23" rx="3"/></g><path d="M-30-54H-15M23-65V-43" stroke="#7d9290" stroke-width="2"/><rect x="23" y="-122" width="12" height="33" fill="#465f62"/></g>';
await save(
  "art/paper-plane.svg",
  svg(
    250,
    140,
    '<path d="M12 18L238 60 62 120 84 75Z" fill="#fdf9e9" stroke="#dcba96" stroke-width="2"/><path d="M12 18L84 75 238 60Z" fill="#fffdf5"/><path d="M84 75L62 120 119 85 238 60Z" fill="#e7dbc7"/><path d="M84 75L101 94 119 85 238 60Z" fill="#d5b69c"/><path d="M12 18L119 85" fill="none" stroke="#e3cbb2" stroke-width="1.4"/><path d="M141 47L163 51 153 58 131 53Z" fill="#d66a52"/><path d="M151 49L142 55" stroke="#f3d5b9" stroke-width="2"/>',
  ),
);
await save(
  "art/cloud.svg",
  svg(
    420,
    170,
    '<path d="M38 133C-1 132 10 77 48 81 37 30 122 9 143 62 170 1 262 21 267 83 317 44 367 76 351 109 411 83 443 145 383 151H40Z" fill="#fff8e6" opacity=".87"/>',
  ),
);
let peaks = "";
for (let i = 0; i < 21; i++) {
  const x = i * 370 - 170;
  const h = 210 + rand() * 260;
  peaks +=
    '<path d="M' +
    x +
    " 640 Q" +
    (x + 190) +
    " " +
    (640 - h * 1.28) +
    " " +
    (x + 400) +
    ' 640Z" fill="' +
    (i % 2 ? "#b7c9c0" : "#a6bdb8") +
    '"/>';
}
await save("art/mountains.svg", svg(7600, 700, peaks));
let terrain =
  '<path d="M0 770Q600 490 1160 750T2250 730T3400 680T4470 790T5530 700T6800 760V1000H0Z" fill="#91b6a4"/><path d="M0 810Q650 620 1280 810T2670 780T4160 810T5540 780T7000 830V1000H0Z" fill="#527d72"/><path d="M0 860Q1200 780 2450 875T4700 860T7000 880V1000H0Z" fill="#365e5c"/>';
for (let i = 0; i < 64; i++) {
  const x = 70 + i * 108;
  const y = 720 + Math.sin(i * 2.4) * 35;
  if (x < 950 || x > 4800)
    terrain += house(
      x,
      y,
      0.45 + rand() * 0.36,
      ["#e8ba99", "#e9d7b1", "#cbceaf"][i % 3],
    );
  else
    terrain +=
      '<g transform="translate(' +
      x +
      " " +
      y +
      ')"><path d="M0 0V-91" stroke="#486d61" stroke-width="7"/><path d="M-31-29L0-116 32-29Z" fill="' +
      (i % 2 ? "#456e64" : "#6f9983") +
      '"/></g>';
}
terrain +=
  '<g fill="#bbac93"><path d="M2420 745V825H2450V745ZM2650 738V825H2680V738ZM2880 750V825H2910V750Z"/><path d="M2380 719Q2660 691 2960 729V746Q2670 720 2380 741Z"/></g><path d="M2400 715Q2650 683 2940 724" fill="none" stroke="#f4e1b8" stroke-width="5"/>';
await save("art/landscape.svg", svg(7200, 1000, terrain));
await save(
  "art/lighthouse.svg",
  svg(
    260,
    420,
    '<ellipse cx="128" cy="396" rx="120" ry="20" fill="#274f50"/><path d="M76 380L96 90H162L185 380Z" fill="#f6e5c8"/><path d="M88 230H172L177 289H84Z" fill="#c86e52"/><path d="M93 147H167L171 198H89Z" fill="#c86e52"/><path d="M148 90L173 381H185L162 90Z" fill="#dfc6a5"/><rect x="86" y="55" width="88" height="55" rx="4" fill="#38545a"/><rect x="98" y="64" width="64" height="33" fill="#ffe2a3"/><path d="M77 54L131 13 182 54Z" fill="#435f61"/><path d="M130 14V0M79 112H181M82 127H178" stroke="#38545a" stroke-width="6"/><path d="M112 380V339Q130 314 148 339V380" fill="#3e6264"/><path d="M126 272V257M126 182V170" stroke="#365459" stroke-width="12"/><path d="M128 120V139M82 112V134M176 112V134" stroke="#38545a" stroke-width="4"/>',
  ),
);
await save(
  "art/foreground.svg",
  svg(
    1800,
    900,
    '<path d="M90 950Q210 650 99 357M165 720L-50 515M142 640L310 481" fill="none" stroke="#254c4a" stroke-width="29"/><g fill="#305b52"><ellipse cx="40" cy="373" rx="170" ry="89"/><ellipse cx="180" cy="312" rx="155" ry="100"/><ellipse cx="320" cy="474" rx="120" ry="75"/><ellipse cx="18" cy="514" rx="160" ry="105"/></g><path d="M1590 980Q1540 704 1694 427" fill="none" stroke="#254c4a" stroke-width="24"/><g fill="#305b52"><ellipse cx="1710" cy="387" rx="177" ry="112"/><ellipse cx="1560" cy="507" rx="107" ry="73"/></g>',
  ),
);
// Music is authored separately. Rebuilding illustrations must not overwrite the mastered scores.
for (const id of ["paper-wings", "sunny-rail", "tiny-seed"]) {
  await fs.access(path.join(root, "public/audio", id + ".wav")).catch(() => {
    throw new Error(
      "Missing demo master: " + id + ". Run pnpm music:build first.",
    );
  });
}
for (const filename of await fs.readdir(path.join(root, "public/art"))) {
  if (!filename.endsWith(".svg")) continue;
  const file = path.join(root, "public/art", filename);
  const input = await fs.readFile(file, "utf8");
  await fs.writeFile(file, optimize(input, { path: file }).data);
}
// Decoder files ship with three.js and remain local at runtime.
for (const [from, to] of [
  ["node_modules/three/examples/jsm/libs/draco/gltf", "public/vendor/draco"],
  ["node_modules/three/examples/jsm/libs/basis", "public/vendor/basis"],
]) {
  try {
    await fs.mkdir(to, { recursive: true });
    await fs.cp(from, to, { recursive: true });
  } catch (e) {
    console.warn("Optional decoder copy:", e.message);
  }
}
let existingImports = [];
try {
  existingImports = JSON.parse(await fs.readFile("public/assets.json", "utf8"));
} catch {}
const catalog = [];
for (const dir of ["art", "audio"])
  for (const name of await fs.readdir("public/" + dir)) {
    const file = "public/" + dir + "/" + name;
    const stat = await fs.stat(file);
    catalog.push({
      name,
      url: dir + "/" + name,
      type: dir === "art" ? "image" : "audio",
      bytes: stat.size,
      license:
        dir === "audio" &&
        ["paper-wings.wav", "sunny-rail.wav", "tiny-seed.wav"].includes(name)
          ? "原创作曲与音效；GeneralUser GS 乐器采样，见 production/music/GENERALUSER-LICENSE.txt"
          : (existingImports.find((a) => a.url === dir + "/" + name)?.license ??
            "项目原创 / Original project asset"),
    });
  }
await save(
  "assets.json",
  JSON.stringify(
    [
      ...catalog,
      ...existingImports.filter((a) => !catalog.some((c) => c.url === a.url)),
    ],
    null,
    2,
  ),
);
// ASSET-LICENSES.md is a curated source record; do not replace it during asset rebuilds.
console.log(
  "Prepared " + catalog.length + " original assets and local model decoders.",
);

await updateWaveforms();
