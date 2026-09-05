// Generates the raster favicons from the same geometry as public/favicon.svg.
//
// Run with `npm run icons --prefix frontend`. The outputs are committed, so
// this is not part of the build — it exists so the binaries in public/ have a
// source rather than being two files nobody can regenerate or adjust.
//
// It rasterises rather than shelling out to a converter on purpose: this repo
// has no ImageMagick or librsvg, and macOS's `qlmanage` renders an SVG at its
// intrinsic size into a corner of the requested canvas rather than filling it,
// which silently produces a mostly-empty icon. Two polygons and a couple of
// circles are less code than working around that, and they behave identically
// on every machine.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// ---- The mark, in the 32-unit space favicon.svg uses ----
// Kept in sync with public/favicon.svg by hand. If you change one, change the
// other: the SVG is what modern browsers actually load, and these are the
// fallbacks for the ones that don't.
const INK = [0x14, 0x26, 0x2d];
const RING = [0x3d, 0x55, 0x66];
const NORTH = [0x93, 0xb4, 0xf7];
const SOUTH = [0x6d, 0x87, 0x94];

const northNeedle = [
  [16, 4.6],
  [20.1, 15.1],
  [16, 16],
  [11.9, 15.1],
];
const southNeedle = [
  [16, 27.4],
  [11.9, 16.9],
  [16, 16],
  [20.1, 16.9],
];

/** Crossing-number test. Handles the needles' concave notch at the pivot. */
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Colour of the mark at a point in 32-unit space, or null for transparent.
 *
 * `disc` fills the circle (the favicon, which is a disc on its own); when it
 * is false the caller has already painted a background (the touch icon, which
 * is a square).
 */
function sample(x, y, { disc }) {
  const d = Math.hypot(x - 16, y - 16);
  if (inPolygon(x, y, northNeedle)) return NORTH;
  if (inPolygon(x, y, southNeedle)) return SOUTH;
  if (d <= 15.8 && d >= 14.7) return RING;
  if (disc && d <= 16) return INK;
  return null;
}

/**
 * Rasterise to RGBA. `span` is how many 32-unit cells the image covers — 32
 * for the favicon (edge to edge) and 44 for the touch icon, whose extra 12
 * units are the padding iOS's rounded-square mask needs.
 */
function raster(size, { span, background, disc }) {
  const SS = 4; // 4x4 samples per pixel; enough antialiasing at these sizes
  const px = Buffer.alloc(size * size * 4);
  const origin = (span - 32) / 2;

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = ((pxi + (sx + 0.5) / SS) / size) * span - origin;
          const uy = ((py + (sy + 0.5) / SS) / size) * span - origin;
          const c = sample(ux, uy, { disc }) ?? background;
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + pxi) * 4;
      // Averaging colour over only the covered samples, then averaging
      // coverage separately, keeps edge pixels the right hue instead of
      // dragging them toward black.
      const covered = a / 255;
      px[i] = covered ? Math.round(r / covered) : 0;
      px[i + 1] = covered ? Math.round(g / covered) : 0;
      px[i + 2] = covered ? Math.round(b / covered) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

// ---- Minimal PNG encoder ----

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function pngAt(width, height, rgba) {
  // Every scanline gets a leading filter byte; 0 means "no filter", which is
  // fine here — deflate handles these flat colour fields well enough.
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = (size, rgba) => pngAt(size, size, rgba);

/**
 * An .ico is a 6-byte directory, one 16-byte entry per image, then the
 * payloads. Since Vista a payload may be a PNG rather than a BMP, so one
 * 32x32 PNG behind 22 bytes of header is a complete, valid icon.
 */
function ico(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 32; // width  (0 would mean 256)
  entry[1] = 32; // height
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12); // offset past header + entry
  return Buffer.concat([header, entry, pngBuf]);
}

// ---- Outputs ----

// favicon.ico — the legacy fallback. A disc, edge to edge, transparent
// outside it, so it sits on a tab strip of any colour.
const fav = png(32, raster(32, { span: 32, background: null, disc: true }));
writeFileSync(join(PUBLIC, "favicon.ico"), ico(fav));

// apple-touch-icon.png — iOS masks this to a rounded square and composites
// anything transparent onto black, so it is opaque, square, and padded.
const touch = png(180, raster(180, { span: 44, background: INK, disc: false }));
writeFileSync(join(PUBLIC, "apple-touch-icon.png"), touch);

/**
 * og-image.png — the picture on a shared link.
 *
 * Deliberately wordless. Every platform that renders one of these already
 * shows og:title and og:description as text beside it, so setting the name and
 * the pitch in pixels too would be the same words twice, in a font that would
 * have to be embedded here to exist at all.
 *
 * So the right half carries the app's actual signature instead: the reach /
 * target / safety stack from the homepage hero, in the three colours that
 * carry those meanings everywhere else in Compass. That says what this is —
 * a balanced college list — in a way a mark centred on an empty field cannot,
 * and it still reads at the thumbnail size a card is actually seen at. The
 * faint arc behind it is the same sky the app sits on.
 */
function ogImage() {
  const W = 1200;
  const H = 630;
  const SS = 3;
  const px = Buffer.alloc(W * H * 4);

  const MARK = { cx: 300, cy: 315, r: 150 }; // the compass, left third
  const ARC = { cx: 1150, cy: 315, r: 330 }; // the horizon, bleeding off-frame
  const ARC_COLOR = [0x21, 0x3a, 0x45];
  const CARD = [0x1d, 0x33, 0x3c]; // a shade off the ink, the way a panel is

  // Reach, target, safety — the accents the dark theme uses for each, and the
  // same order and meaning the hero stacks them in. Widths differ so the group
  // reads as a list rather than a bar chart.
  const rows = [
    { y: 150, w: 470, accent: [0xf7, 0xb2, 0x64] },
    { y: 268, w: 530, accent: [0x6a, 0xcb, 0x87] },
    { y: 386, w: 430, accent: [0x93, 0xb4, 0xf7] },
  ];
  const ROW_H = 84;
  const ROW_X = 560;
  const RADIUS = 14;

  /** Rounded-rect hit test, so the cards have the app's own corner radius. */
  function inRoundRect(x, y, rx, ry, w, h, r) {
    if (x < rx || x > rx + w || y < ry || y > ry + h) return false;
    const cx = Math.min(Math.max(x, rx + r), rx + w - r);
    const cy = Math.min(Math.max(y, ry + r), ry + h - r);
    return Math.hypot(x - cx, y - cy) <= r;
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          let c = INK;

          const ad = Math.hypot(fx - ARC.cx, fy - ARC.cy);
          if (ad <= ARC.r + 1.4 && ad >= ARC.r - 1.4) c = ARC_COLOR;

          for (const row of rows) {
            if (inRoundRect(fx, fy, ROW_X, row.y, row.w, ROW_H, RADIUS)) {
              // A 6px accent bar down the leading edge — the tier marker the
              // list cards wear in the app.
              c = fx < ROW_X + 6 ? row.accent : CARD;
            }
          }

          // The mark is drawn in its own 32-unit space, mapped onto the frame.
          const ux = ((fx - MARK.cx) / MARK.r) * 16 + 16;
          const uy = ((fy - MARK.cy) / MARK.r) * 16 + 16;
          c = sample(ux, uy, { disc: true }) ?? c;

          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const i = (y * W + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = 255; // opaque: a card with alpha composites onto who knows what
    }
  }
  return pngAt(W, H, px);
}

const og = ogImage();
writeFileSync(join(PUBLIC, "og-image.png"), og);

console.log(`favicon.ico        ${ico(fav).length} bytes`);
console.log(`apple-touch-icon   ${touch.length} bytes`);
console.log(`og-image.png       ${og.length} bytes`);
