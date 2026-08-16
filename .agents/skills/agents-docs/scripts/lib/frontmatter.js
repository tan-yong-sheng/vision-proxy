// Frontmatter read/write helpers. Extracted from docs.js with zero behavior change.

import * as fs from "node:fs";
import { serializeYaml } from "./yaml.js";

export function stripFrontmatter(text) {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) return text.slice(end + 5);
  }
  return text;
}

export function withFrontmatter(text, fm) {
  return `---\n${serializeYaml(fm)}\n---\n${stripFrontmatter(text).replace(/^\n+/, "\n")}`;
}

export function writeDoc(doc, text) {
  fs.writeFileSync(doc.abs, text);
}
