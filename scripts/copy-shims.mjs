// Copy the standalone hook shims (plain .mjs, not compiled by tsc) into dist/shims
// so an installed `vp` binary can reference them from the same directory tree.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "shims");
const dst = join(root, "dist", "shims");
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
	if (!f.endsWith(".mjs") || f.endsWith(".e2e.mjs")) continue;
	copyFileSync(join(src, f), join(dst, f));
}
