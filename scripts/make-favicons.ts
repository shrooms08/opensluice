#!/usr/bin/env tsx
/**
 * Generates the raster icons from the canonical OpenSluice mark geometry:
 *   apps/web/public/favicon-16.png          (optical variant paths)
 *   apps/web/public/favicon-32.png          (standard mark)
 *   apps/web/public/favicon-48.png          (standard mark)
 *   apps/web/public/favicon.ico             (16 + 32 + 48 in an ICO container)
 *   apps/web/public/apple-touch-icon.png    (180px, opaque plate)
 *   apps/web/public/icon-192.png            (opaque plate)
 *   apps/web/public/icon-512.png            (opaque plate)
 *
 * The outputs are CHECKED IN (deterministic, and this keeps a native
 * dependency out of the build). `sharp` is deliberately NOT a dependency of
 * this repo: adding it would put a large platform-specific binary in the
 * lockfile and pull it into every `npm ci`, including the Docker build, for a
 * script that runs only when the mark changes. Install it ad hoc instead:
 *
 *   npm i --no-save sharp && npm run icons
 *
 * Transparent rasters can't adapt to the tab theme, so favicon-16/32/48 and
 * the ICO use the ink water (#0a0a0a) — legacy consumers default to a light
 * UI, and modern browsers pick the theme-aware favicon.svg instead. The
 * apple-touch-icon and the PWA icons must be opaque (iOS and Android
 * composite transparency onto an unknown, usually black, surface), so those
 * get a #0a0a0a plate with the light water on top. The blade is always
 * #f7931a and the geometry is never altered.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// Resolved at run time so the missing-dependency case gives a useful message
// instead of an unresolved-import stack trace.
const sharp = await import("sharp")
  .then((m) => m.default)
  .catch(() => {
    console.error(
      "make-favicons needs sharp, which is intentionally not a dependency of this repo.\n" +
        "Install it for this run:  npm i --no-save sharp",
    );
    process.exit(1);
  });

const out = (f: string) => fileURLToPath(new URL(`../apps/web/public/${f}`, import.meta.url));

const BLADE = "#f7931a";
const INK = "#0a0a0a";
const PAPER = "#f5f5f5";

/** Standard mark — every layer above 16px. */
const std = (water: string) => `<rect x="9.5" y="3" width="3" height="7.5" fill="${BLADE}"/>
  <path d="M3 12h6v3h12v6H3z" fill="${water}"/>`;

/**
 * Optical variant — the 16px layer only. At that size the standard blade and
 * the 3-unit water step fall below one device pixel and turn to mush, so the
 * shapes are thickened and the whole mark is pushed out toward the edges. The
 * 1.5-unit open gap is preserved exactly (blade bottom y=10, water top y=11.5).
 */
const small = (water: string) => `<rect x="9" y="2" width="4" height="8" fill="${BLADE}"/>
  <path d="M2.5 11.5h6.5v4H21.5v6H2.5z" fill="${water}"/>`;

const svg = (shapes: string, plate?: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      (plate ? `<rect width="24" height="24" fill="${plate}"/>` : "") +
      `${shapes}</svg>`,
  );

async function png(shapes: string, size: number, plate?: string): Promise<Buffer> {
  return sharp(svg(shapes, plate), { density: (72 * size) / 24 })
    .resize(size, size)
    .png()
    .toBuffer();
}

/** Minimal ICO container with PNG-encoded entries (supported by all modern consumers). */
function buildIco(entries: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size === 256 ? 0 : size, o); // width
    dir.writeUInt8(size === 256 ? 0 : size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

const p16 = await png(small(INK), 16);
const p32 = await png(std(INK), 32);
const p48 = await png(std(INK), 48);

await writeFile(out("favicon-16.png"), p16);
await writeFile(out("favicon-32.png"), p32);
await writeFile(out("favicon-48.png"), p48);
await writeFile(
  out("favicon.ico"),
  buildIco([
    { size: 16, data: p16 },
    { size: 32, data: p32 },
    { size: 48, data: p48 },
  ]),
);

await writeFile(out("apple-touch-icon.png"), await png(std(PAPER), 180, INK));
await writeFile(out("icon-192.png"), await png(std(PAPER), 192, INK));
await writeFile(out("icon-512.png"), await png(std(PAPER), 512, INK));

console.log(
  "wrote favicon-16/32/48.png, favicon.ico, apple-touch-icon.png, icon-192.png, " +
    "icon-512.png to apps/web/public/",
);
