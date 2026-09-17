// Test-only-consumer detection — the module class knip structurally cannot
// see. knip treats vitest files as entries, so a production module whose only
// importer is its own test suite looks "used" forever; feature removals keep
// minting this class one hop beyond every sweep (14 found by hand on
// 2026-08-16, ~2 dozen more on 2026-08-17). This scanner resolves real import
// specifiers (static, dynamic, side-effect and `export … from`) across src/
// and reports prod modules with zero non-test importers.
//
// The allowlist is shrink-only and every entry carries a reason — deliberate
// staging (a module landed ahead of its wiring) is legitimate, silent decay
// is not. Entry points come first from this list, mirroring knip.json.
import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

const NON_PRODUCT_PREFIXES = [
	// Biome formats this deterministic protocol check inside its configured src/ scope.
	"src/contracts/generated/terminalStateCheck/",
];

/** Roots that are reachable without being imported (mirrors knip.json entry). */
const ENTRY_PREFIXES = [
	"src/main.tsx",
	// index.html loads this ahead of main.tsx — the boot splash must not wait
	// for the app graph.
	"src/bootSplash.ts",
	"src/designModeInjectEntry.ts",
	"src/qa.ts",
	"src/qa/",
	"src/vite-env.d.ts",
	// The shared test kit is legitimately test-only — its consumers are the
	// suites themselves (setup, fixtures, record builders).
	"src/test/",
];

/** Deliberately staged or externally-referenced modules. Shrink-only; every
 * entry needs a reason. Deleting the module deletes the entry. */
export const ORPHAN_ALLOWLIST = {
	// Suite harness consumed only through test-file vi.mock async factories.
	"src/components/terminal/structured/structuredTerminalTestHarness.tsx":
		"structured-suite harness — reached via vi.mock factories in tests",
	// Receipt assertion helper retained for staged QA reuse.
	"src/lib/sessions/launch/spawnReceiptAssert.ts":
		"receipt assertions — staged QA reuse",
	// Confirmed loader primitive, staged ahead of its first consumer.
	"src/components/ui/dure-loader.tsx": "staged DureLoader primitive",
	// Provider capability data consumed via knip-ignored generated flows.
	"src/lib/agents/providerManifest.ts": "knip-ignored provider data surface",
	"src/lib/agents/providerSpec.ts": "knip-ignored provider data surface",
	// Vite entry for the worktree-release build: vite.config.ts swaps it in
	// for main.tsx through transformIndexHtml, so no module imports it.
	"src/worktreeReleaseBootstrap.ts":
		"Vite worktree-release entry (vite.config.ts transformIndexHtml)",
};

function walk(directory) {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const pathname = path.join(directory, entry.name);
		return entry.isDirectory() ? walk(pathname) : [pathname];
	});
}

function isSource(pathname) {
	return SOURCE_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}

function isTestFile(filename) {
	return /\.test\.tsx?$/.test(filename);
}

/** Resolve one import specifier from `importer` to a repo-relative src path,
 * or undefined for package imports. */
function resolveSpecifier(root, importer, specifier) {
	let base;
	if (specifier.startsWith("@/")) {
		base = path.join("src", specifier.slice(2));
	} else if (specifier.startsWith(".")) {
		base = path.normalize(path.join(path.dirname(importer), specifier));
	} else {
		return undefined;
	}
	for (const candidate of [
		base,
		...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
		...SOURCE_EXTENSIONS.map((extension) =>
			path.join(base, `index${extension}`),
		),
	]) {
		if (fs.existsSync(path.join(root, candidate)) && isSource(candidate)) {
			return candidate.split(path.sep).join("/");
		}
	}
	return undefined;
}

const IMPORT_SPECIFIER = /(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^import\s*["']([^"']+)["']/gm;

/** Map of module path → Set of non-test importer paths (self excluded). */
export function scanOrphanModules(root) {
	const sourceFiles = walk(path.join(root, "src"))
		.filter(isSource)
		.map((pathname) => path.relative(root, pathname).split(path.sep).join("/"))
		.filter(
			(filename) =>
				!NON_PRODUCT_PREFIXES.some((prefix) => filename.startsWith(prefix)),
		)
		.sort();
	const importedBy = new Map();
	for (const filename of sourceFiles) {
		if (isTestFile(filename)) continue;
		const text = fs.readFileSync(path.join(root, filename), "utf8");
		for (const match of text.matchAll(IMPORT_SPECIFIER)) {
			const specifier = match[1] ?? match[2] ?? match[3];
			const resolved = resolveSpecifier(root, filename, specifier);
			if (!resolved || resolved === filename) continue;
			if (!importedBy.has(resolved)) importedBy.set(resolved, new Set());
			importedBy.get(resolved).add(filename);
		}
	}
	const orphans = [];
	for (const filename of sourceFiles) {
		if (isTestFile(filename)) continue;
		if (filename.endsWith(".d.ts")) continue;
		if (ENTRY_PREFIXES.some((prefix) => filename === prefix || filename.startsWith(prefix))) {
			continue;
		}
		if ((importedBy.get(filename)?.size ?? 0) === 0) orphans.push(filename);
	}
	return orphans;
}

export function orphanModuleViolations(root) {
	return scanOrphanModules(root)
		.filter((filename) => !(filename in ORPHAN_ALLOWLIST))
		.map(
			(filename) =>
				`orphanModule: ${filename} has no production importer — delete it (its tests go with it) or stage it in ORPHAN_ALLOWLIST with a reason`,
		);
}
