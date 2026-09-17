import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

// Regression: #685 — the isolated first-run launcher could not reach a ready app and backend
// Found by /qa on 2026-09-10
// Evidence: https://github.com/hebbianai/dure-internal/issues/685

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const launcher = join(repositoryRoot, "scripts/qa/run-first-run-onboarding-app.sh");
const temporaryRoots = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("first-run onboarding build admission", () => {
	it("prepares one isolated app and backend environment", () => {
		const tools = mkdtempSync(join(tmpdir(), "dure-onboarding-tools-"));
		const root = mkdtempSync(join(tmpdir(), "dure-onboarding-environment-"));
		temporaryRoots.push(tools, root);
		mkdirSync(join(root, "dure-home"), { mode: 0o755 });
		const corepack = join(tools, "corepack");
		writeFileSync(
			corepack,
			'#!/bin/sh\nprintf \'%s\\n\' "$*" >> "${DURE_HOME%/*}/corepack.log"\nif [ "$2" = "app:dev" ]; then printf \'%s\\n%s\\n%s\\n\' "$DURE_BUILD_STORAGE_RESERVATION_V1" "$DURE_HMUX_BIN" "$DURE_HMUX_RUNTIME_BIN"; fi\n',
			{ mode: 0o700 },
		);
		chmodSync(corepack, 0o700);

		const result = spawnSync("sh", [launcher, root, "15541"], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: {
				...process.env,
				DURE_BUILD_STORAGE_RESERVATION_V1: "fixture-reservation",
				PATH: `${tools}${delimiter}${process.env.PATH ?? ""}`,
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(statSync(join(root, "dure-home")).mode & 0o777).toBe(0o700);
		expect(readFileSync(join(root, "corepack.log"), "utf8").trim().split("\n")).toEqual([
			"pnpm hmux:runtime:stage:dev",
			"pnpm app:dev",
		]);
		const [reservation, hmux, runtime] = result.stdout.trim().split("\n");
		expect(reservation).toBe("fixture-reservation");
		expect(hmux).toMatch(/\/src-tauri\/binaries\/hmux-[^/]+$/);
		expect(runtime).toMatch(/\/src-tauri\/binaries\/hmux-runtime-[^/]+$/);
	});
});
