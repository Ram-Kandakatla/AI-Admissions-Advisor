// Downloads the two typefaces from Google Fonts into public/fonts/ and writes
// the @font-face block that points at them.
//
// Run with `npm run fonts --prefix frontend`. Like build-icons.mjs, the outputs
// are committed and this is NOT part of the build — a build that reached out to
// fonts.gstatic.com would reintroduce, at deploy time, exactly the dependency
// this script exists to remove.
//
// ---- WHY SELF-HOST AT ALL ----
//
// The <link> this replaces made every visitor's browser call
// fonts.googleapis.com and fonts.gstatic.com on every page load, which handed
// Google their IP address and user agent. An IP is personal data under the
// GDPR whether or not a cookie rides along with it, and a German court has
// already found the Google Fonts CDN actionable on exactly that basis. It was
// the only third-party request Compass made, and the app's privacy and cookie
// policies had to disclose it. Self-hosting removes the request, which removes
// the disclosure, which is the rare privacy fix that also deletes code.
//
// It is faster too, which is a change from the old CDN argument: cache
// partitioning means a browser can no longer reuse another site's copy of a
// font, so the shared-cache benefit that justified the CDN has not existed for
// years. What is left is two extra DNS lookups and two TLS handshakes on the
// critical path, against files served from the origin that is already open.
//
// ---- WHY VARIABLE FONTS, AND WHY THESE SUBSETS ----
//
// Both families ship as variable fonts, so one file covers every weight the
// app uses: Bricolage 500-800 and Plex 400-700. The static alternative is four
// separate Plex files per subset — twelve files to say what three say.
//
// Only three of the six subsets Google offers are kept (see SUBSETS). Each
// @font-face carries a unicode-range, so a subset nobody triggers costs zero
// bytes at runtime — the only cost of keeping one is repository size, and the
// only cost of dropping one is that text in that script renders in the
// fallback stack instead. Latin and latin-ext are the app's own copy and most
// student names. Vietnamese is kept because Vietnamese surnames are common in
// US high schools and its diacritics are precisely what latin-ext lacks.
// Cyrillic and Greek are dropped: a note typed in Russian falls back to
// system-ui and reads perfectly well, which is not true of a Vietnamese name
// rendered half in one face and half in another.
//
// ---- LICENSING ----
//
// Both families are SIL Open Font License 1.1, which permits redistribution
// with the copyright notice and licence included. public/fonts/OFL.txt carries
// both notices; do not delete it, and do not add a family here without
// checking that it is OFL and adding its notice there too.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = join(ROOT, "public", "fonts");
const CSS_OUT = join(ROOT, "src", "styles", "fonts.css");

/**
 * The families, spelled as the CSS2 API wants them.
 *
 * The weight ranges are the variable axes, and they are the *used* range
 * rather than the full one: Bricolage also has 200-500 and Plex has 100-700,
 * but narrowing the request narrows the file. `slug` names the files on disk.
 */
const FAMILIES = [
  { name: "Bricolage Grotesque", slug: "bricolage-grotesque", query: "Bricolage+Grotesque:opsz,wght@12..96,500..800" },
  { name: "IBM Plex Sans", slug: "ibm-plex-sans", query: "IBM+Plex+Sans:wght@400..700" },
];

/** Kept, in the order the generated CSS should list them. */
const SUBSETS = ["latin", "latin-ext", "vietnamese"];

// Without a browser User-Agent the API answers with TrueType for ancient
// clients. woff2 is what every browser this app supports actually wants, and
// it is roughly half the size.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function get(url, as = "text") {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return as === "text" ? res.text() : Buffer.from(await res.arrayBuffer());
}

/** Split the API's stylesheet into `{ subset, family, weight, range, url }`. */
function parseFaces(css) {
  const faces = [];
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
  for (const [, subset, body] of css.matchAll(re)) {
    const field = (n) => (body.match(new RegExp(`${n}:\\s*([^;]+);`)) ?? [])[1]?.trim();
    faces.push({
      subset,
      family: field("font-family").replace(/^'|'$/g, ""),
      weight: field("font-weight"),
      range: field("unicode-range"),
      url: field("src").match(/url\(([^)]+)\)/)[1],
    });
  }
  return faces;
}

mkdirSync(FONT_DIR, { recursive: true });

const blocks = [];
let total = 0;

for (const family of FAMILIES) {
  const css = await get(
    `https://fonts.googleapis.com/css2?family=${family.query}&display=swap`
  );
  const faces = parseFaces(css).filter((f) => SUBSETS.includes(f.subset));

  for (const subset of SUBSETS) {
    const face = faces.find((f) => f.subset === subset);
    if (!face) throw new Error(`${family.name}: no ${subset} subset in the API response`);

    const file = `${family.slug}-${subset}.woff2`;
    const bytes = await get(face.url, "buffer");
    writeFileSync(join(FONT_DIR, file), bytes);
    total += bytes.length;
    console.log(`  ${file.padEnd(38)} ${(bytes.length / 1024).toFixed(1)} kB`);

    blocks.push(
      [
        `/* ${face.family} — ${subset} */`,
        `@font-face {`,
        `  font-family: "${face.family}";`,
        `  font-style: normal;`,
        // The variable range, verbatim. Written as two numbers so the browser
        // interpolates rather than synthesising a fake bold, which is what it
        // does when a requested weight has no face to match.
        `  font-weight: ${face.weight};`,
        // swap, not the API's default: the fallback stack is a real system
        // face, so showing it immediately and swapping is strictly better than
        // a blank paragraph while a font downloads.
        `  font-display: swap;`,
        `  src: url("/fonts/${file}") format("woff2");`,
        `  unicode-range: ${face.range};`,
        `}`,
      ].join("\n")
    );
  }
}

const header = `/* GENERATED by scripts/fetch-fonts.mjs — do not edit by hand.
 *
 * Self-hosted so no page load calls fonts.googleapis.com or fonts.gstatic.com.
 * That request was the only third party Compass talked to, and it handed every
 * visitor's IP address to Google; removing it is why /privacy and /cookies no
 * longer have to disclose one.
 *
 * Regenerate with \`npm run fonts\`. Both families are SIL OFL 1.1 — the
 * notices are in public/fonts/OFL.txt and must ship with the files.
 */\n\n`;

writeFileSync(CSS_OUT, header + blocks.join("\n\n") + "\n");
console.log(`\n${blocks.length} faces, ${(total / 1024).toFixed(1)} kB total`);
console.log(`wrote ${CSS_OUT.replace(ROOT, "frontend")}`);
