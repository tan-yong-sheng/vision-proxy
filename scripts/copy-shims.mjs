// Copy the standalone hook shims (plain .mjs, not compiled by tsc) into dist/shims
// so an installed `vp` binary can reference them from the same directory tree.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "shims");
const dst = join(root, "dist", "shims");

// The hook shims `import "./shared.mjs"`, so a build that does not ship it
// produces an installed shim that throws `node:internal/modules/esm/resolve`
// at hook runtime. Fail the build loudly rather than shipping a broken copy.
if (!existsSync(join(src, "shared.mjs"))) {
	process.stderr.write(
		"[copy-shims] ERROR: src/shims/shared.mjs is missing; hook shim would fail to resolve.\n",
	);
	process.exit(1);
}

mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
	if (!f.endsWith(".mjs") || f.endsWith(".e2e.mjs")) continue;
	copyFileSync(join(src, f), join(dst, f));
}
