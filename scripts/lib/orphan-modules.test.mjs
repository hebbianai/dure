import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ORPHAN_ALLOWLIST,
	orphanModuleViolations,
	scanOrphanModules,
} from "./orphan-modules.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-modules-"));
	temporaryDirectories.push(root);
	return root;
}

function write(root, filename, content) {
	const pathname = path.join(root, filename);
	fs.mkdirSync(path.dirname(pathname), { recursive: true });
	fs.writeFileSync(pathname, content);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("orphan module scan", () => {
	test("flags a module whose only importer is its own test", () => {
		const root = temporaryDirectory();
		write(root, "src/main.tsx", 'import { live } from "@/lib/live";\n');
		write(root, "src/lib/live.ts", "export const live = 1;\n");
		write(root, "src/lib/dead.ts", "export const dead = 1;\n");
		write(root, "src/lib/dead.test.ts", 'import { dead } from "./dead";\nvoid dead;\n');
		expect(scanOrphanModules(root)).toEqual(["src/lib/dead.ts"]);
		expect(orphanModuleViolations(root)[0]).toContain(
			"orphanModule: src/lib/dead.ts",
		);
	});

	test("counts dynamic imports, re-exports, and relative side-effect imports", () => {
		const root = temporaryDirectory();
		write(root, "src/main.tsx", 'void import("@/lib/lazy");\nexport { a } from "./lib/rex";\nimport "./lib/effect";\n');
		write(root, "src/lib/lazy.ts", "export const l = 1;\n");
		write(root, "src/lib/rex.ts", "export const a = 1;\n");
		write(root, "src/lib/effect.ts", "globalThis;\n");
		expect(scanOrphanModules(root)).toEqual([]);
	});

	test("entry roots and the test kit never count as orphans", () => {
		const root = temporaryDirectory();
		write(root, "src/main.tsx", "export {};\n");
		write(root, "src/qa/probe.ts", "export {};\n");
		write(root, "src/test/fixtures.ts", "export {};\n");
		expect(scanOrphanModules(root)).toEqual([]);
	});

	test("ignores deterministic protocol check output inside src", () => {
		const root = temporaryDirectory();
		write(root, "src/main.tsx", "export {};\n");
		write(
			root,
			"src/contracts/generated/terminalStateCheck/state_pb.ts",
			"export const generated = true;\n",
		);
		expect(scanOrphanModules(root)).toEqual([]);
	});

	test("allowlist entries all carry a non-empty reason", () => {
		for (const [filename, reason] of Object.entries(ORPHAN_ALLOWLIST)) {
			expect(filename.startsWith("src/"), filename).toBe(true);
			expect(typeof reason === "string" && reason.length >= 8, filename).toBe(
				true,
			);
		}
	});
});
