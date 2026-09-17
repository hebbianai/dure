import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
	applyReleaseBookkeeping,
	planReleaseBookkeeping,
} from "./lib/release-bookkeeping.mjs";
import { RELEASE_CARGO_WORKSPACES } from "./lib/release-candidate.mjs";
import { VERSION_FILES, writeVersion } from "./lib/release-version.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const git = (root, ...args) =>
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd: root,
		encoding: "utf8",
		env: withoutLocalGitOverrides(),
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
function fixture({ corrupt = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "bookkeeping-"));
	roots.push(root);
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Release fixture");
	git(root, "config", "user.email", "release@example.test");
	git(root, "config", "commit.gpgSign", "false");
	for (const file of VERSION_FILES) {
		const body =
			file.kind === "json"
				? '{"version":"0.2.4","name":"original"}\n'
				: (file.kind === "cargo-package"
						? "[package]"
						: "[workspace.package]") + '\nversion = "0.2.4"\n';
		mkdirSync(dirname(join(root, file.path)), { recursive: true });
		writeFileSync(join(root, file.path), body);
	}
	for (const { lockPath, versionedPackages } of RELEASE_CARGO_WORKSPACES) {
		mkdirSync(dirname(join(root, lockPath)), { recursive: true });
		writeFileSync(
			join(root, lockPath),
			"version = 4\n" +
				versionedPackages
					.map(
						(name) =>
							'\n[[package]]\nname = "' + name + '"\nversion = "0.2.4"\n',
					)
					.join(""),
		);
	}
	git(root, "add", ".");
	git(root, "commit", "-m", "source");
	const parent = git(root, "rev-parse", "HEAD");
	for (const file of VERSION_FILES) writeVersion(file, "0.2.5", root);
	for (const { lockPath } of RELEASE_CARGO_WORKSPACES)
		writeFileSync(
			join(root, lockPath),
			readFileSync(join(root, lockPath), "utf8").replaceAll(
				'"0.2.4"',
				'"0.2.5"',
			),
		);
	if (corrupt)
		writeFileSync(
			join(root, "package.json"),
			'{"version":"0.2.5","name":"foreign"}\n',
		);
	git(root, "add", ".");
	git(root, "commit", "-m", "release: v0.2.5");
	const tagSha = git(root, "rev-parse", "HEAD");
	git(root, "tag", "v0.2.5");
	// A new fixture branch models newer main, not a destructive reset.
	git(root, "switch", "-c", "new-main", parent);
	writeFileSync(
		join(root, "package.json"),
		'{"version":"0.2.4","name":"NEWER MAIN"}\n',
	);
	git(root, "add", ".");
	git(root, "commit", "-m", "newer product changes");
	return { root, tag: "v0.2.5", tagSha };
}

test("plans without writes, then applies only version fields while preserving newer main", () => {
	const input = fixture();
	const plan = planReleaseBookkeeping(input);
	expect(plan.files).toHaveLength(9);
	expect(git(input.root, "status", "--porcelain")).toBe("");
	applyReleaseBookkeeping(plan);
	expect(
		JSON.parse(readFileSync(join(input.root, "package.json"), "utf8")),
	).toEqual({ version: "0.2.5", name: "NEWER MAIN" });
	const diff = git(input.root, "diff", "--numstat")
		.split("\n")
		.map((line) => line.split("\t").map(Number));
	expect(diff.reduce((sum, row) => sum + row[0], 0)).toBe(39);
	expect(diff.reduce((sum, row) => sum + row[1], 0)).toBe(39);
});

test("refuses a tag containing even one non-version byte and never adopts that file", () => {
	const input = fixture({ corrupt: true });
	expect(() => planReleaseBookkeeping(input)).toThrow(
		"release_bookkeeping_tag_body_changed",
	);
	expect(git(input.root, "status", "--porcelain")).toBe("");
});

test("refuses a mismatched immutable SHA", () => {
	expect(() =>
		planReleaseBookkeeping({ ...fixture(), tagSha: "0".repeat(40) }),
	).toThrow("release_bookkeeping_tag_mismatch");
});

test("does not overwrite WIP added after planning", () => {
	const input = fixture();
	const plan = planReleaseBookkeeping(input);
	writeFileSync(join(input.root, "notes.txt"), "user work");
	expect(() => applyReleaseBookkeeping(plan)).toThrow(
		"release_bookkeeping_clean_unchanged_checkout_required",
	);
	expect(
		JSON.parse(readFileSync(join(input.root, "package.json"), "utf8")).version,
	).toBe("0.2.4");
});
