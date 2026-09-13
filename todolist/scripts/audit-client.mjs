/**
 * Fails when client code reaches for DOM globals, HTML elements, CSS class names, or DOM event
 * handlers. Plugin client bundles run on iOS, Android, and React Native Web, so any of these is a
 * bug outside a platform-gated `client/web.ts`.
 *
 * Comments and string literals are blanked before matching: real DOM access never lives inside
 * either, and prose mentioning "document." or a tag name is not a defect. TypeScript generics such
 * as `Promise<void>` are not HTML elements, so the element pattern only matches real tag syntax.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ALLOWED_FILES = new Set(["client/web.ts"]);
const PATTERNS = [
  {
    name: "DOM global",
    regex: /\b(?:document|window|localStorage|sessionStorage|navigator|location)\s*\./,
  },
  {
    name: "HTML element",
    regex:
      /<\/?(?:div|span|button|p|a|ul|li|input|img|section|header|footer|table|form|label|h[1-6])(?:\s[^>]*)?\/?>/,
  },
  { name: "CSS class name", regex: /\bclassName\s*=/ },
  {
    name: "DOM event handler",
    regex: /\bon(?:Click|MouseEnter|MouseLeave|PointerEnter|PointerLeave|KeyDown|KeyUp)\s*=/,
  },
];

/** Replaces comment and string-literal contents with spaces, preserving line structure. */
function blankNonCode(source) {
  const out = source.split("");
  let index = 0;
  let state = "code";
  let quote = "";
  const blank = (at) => {
    if (out[at] !== "\n") out[at] = " ";
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        state = "string";
        quote = char;
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") state = "code";
      else blank(index);
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        blank(index);
        blank(index + 1);
        state = "code";
        index += 2;
        continue;
      }
      blank(index);
      index += 1;
      continue;
    }
    // string
    if (char === "\\") {
      blank(index);
      blank(index + 1);
      index += 2;
      continue;
    }
    if (char === quote) {
      state = "code";
      index += 1;
      continue;
    }
    blank(index);
    index += 1;
  }
  return out.join("");
}

function walk(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const findings = [];
let scanned = 0;
for (const file of walk("client")) {
  const relative = file.split(path.sep).join("/");
  if (ALLOWED_FILES.has(relative)) continue;
  scanned += 1;
  const raw = readFileSync(file, "utf8");
  const code = blankNonCode(raw).split("\n");
  raw.split("\n").forEach((line, index) => {
    for (const { name, regex } of PATTERNS) {
      if (regex.test(code[index] ?? "")) findings.push(`${relative}:${index + 1}: ${name}: ${line.trim()}`);
    }
  });
}

if (findings.length > 0) {
  console.error(`Client DOM audit failed with ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}
console.log(`Client DOM audit clean: ${scanned} files in client/ use React Native primitives only.`);
