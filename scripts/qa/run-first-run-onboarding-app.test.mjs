import {
	chmodSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const launcher = join(
	repositoryRoot,
	"scripts/qa/run-first-run-onboarding-app.sh",
);
const temporaryRoots = [];

function temporaryRoot(prefix) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function executable(directory, name, source) {
	const path = join(directory, name);
	writeFileSync(path, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("first-run onboarding app isolation", () => {
	it("derives distinct WebView instances while allowing the same port", () => {
		const tools = temporaryRoot("dure-onboarding-tools-");
		executable(
			tools,
			"corepack",
			'printf \'{"dureHome":"%s","legacyHome":"%s","instance":"%s","port":"%s"}\\n\' "$DURE_HOME" "$HEBBIAN_HOME" "$HEBBIAN_DEV_INSTANCE" "$DURE_DEV_PORT"',
		);
		const firstRoot = temporaryRoot("dure-onboarding-first-");
		const secondRoot = temporaryRoot("dure-onboarding-second-");
		const canonicalFirstRoot = realpathSync(firstRoot);
		const canonicalSecondRoot = realpathSync(secondRoot);
		const env = {
			...process.env,
			PATH: `${tools}${delimiter}${process.env.PATH ?? ""}`,
		};
		const launch = (root) =>
			spawnSync("sh", [launcher, root, "15541"], {
				cwd: repositoryRoot,
				encoding: "utf8",
				env,
			});

		const first = launch(firstRoot);
		const second = launch(secondRoot);
		expect(first.status, first.stderr).toBe(0);
		expect(second.status, second.stderr).toBe(0);
		const firstReceipt = JSON.parse(first.stdout);
		const secondReceipt = JSON.parse(second.stdout);
		expect(firstReceipt).toMatchObject({
			dureHome: `${canonicalFirstRoot}/dure-home`,
			legacyHome: `${canonicalFirstRoot}/dure-home`,
			port: "15541",
		});
		expect(secondReceipt).toMatchObject({
			dureHome: `${canonicalSecondRoot}/dure-home`,
			legacyHome: `${canonicalSecondRoot}/dure-home`,
			port: "15541",
		});
		expect(firstReceipt.instance).toMatch(/^[a-f0-9]{20}$/);
		expect(firstReceipt.instance).not.toBe(secondReceipt.instance);
		expect(launch(firstRoot).stdout).toBe(first.stdout);
	});

	it("fails closed before launch when custom WKWebsiteDataStore is unavailable", () => {
		const tools = temporaryRoot("dure-onboarding-old-macos-");
		executable(tools, "uname", 'printf \'Darwin\\n\'');
		executable(tools, "sw_vers", 'printf \'13.6.9\\n\'');
		const root = temporaryRoot("dure-onboarding-unsupported-");
		const result = spawnSync("sh", [launcher, root, "15541"], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${tools}${delimiter}/usr/bin:/bin`,
			},
		});

		expect(result.status).toBe(64);
		expect(result.stderr).toContain("requires macOS 14 or newer");
	});
});
