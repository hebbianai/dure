// The filesystem half of the skill install lifecycle: receipts, provider
// targets, and inspection. Task 1's `skillInstallState` is pure and untested
// here (see scripts/skill-install-state.test.mjs); this file only exercises
// the I/O that feeds it — computing digests, reading/writing receipts, and
// walking provider skill directories.
//
// Hard constraint: nothing here may touch a real `~/.claude`, `~/.codex` or
// `~/.dure`. Every test gets its `home` from `makeTempHome()`, which asserts
// the directory it just created is under the OS temp directory before any
// test is allowed to write into it — so a future edit that swaps in a real
// home fails loudly instead of quietly writing into someone's machine.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	inspectSkills,
	installSkill,
	providerTargets,
	removeSkill,
} from "../cli/lib/skill-install.mjs";

const cleanups = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A fresh temp directory to use as `home`, verified to live under the OS
 *  temp directory before any test writes to it. This is the guard the brief
 *  asks for: a future edit that points `home` at a real home directory fails
 *  this assertion instead of silently writing there. */
function makeTempHome() {
	const home = mkdtempSync(join(tmpdir(), "dure-skill-install-home-"));
	expect(home.startsWith(tmpdir())).toBe(true);
	cleanups.push(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

/** A temp bundle directory standing in for `cli/skills/`: one skill, named
 *  "widget", whose SKILL.md content the test controls directly so it can
 *  rewrite the "shipped" source mid-test without touching the real bundle. */
function makeTempBundle(initialContent = "---\nname: widget\n---\nV1\n") {
	const bundleDir = mkdtempSync(join(tmpdir(), "dure-skill-install-bundle-"));
	expect(bundleDir.startsWith(tmpdir())).toBe(true);
	cleanups.push(() => rmSync(bundleDir, { recursive: true, force: true }));
	mkdirSync(join(bundleDir, "widget"), { recursive: true });
	writeFileSync(join(bundleDir, "widget", "SKILL.md"), initialContent);
	return bundleDir;
}

/** An environment carrying its own DURE_HOME, nested under `home` so the
 *  whole fixture — provider directories and the receipt store alike — is one
 *  temp tree removed in a single cleanup. */
function environmentFor(home) {
	return { DURE_HOME: join(home, "dure-home") };
}

function markProviderPresent(home, provider) {
	const directory = provider === "claude" ? ".claude" : ".codex";
	mkdirSync(join(home, directory), { recursive: true });
}

function receiptFileFor(home, provider, name) {
	return join(home, "dure-home", "skills", "receipts", provider, `${name}.json`);
}

function skillFor(inspection, provider, name) {
	return inspection.skills.find((skill) => skill.provider === provider && skill.name === name);
}

describe("providerTargets", () => {
	it("reports each provider's skills root and whether its home exists", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const targets = providerTargets({ home, environment: environmentFor(home) });
		const claude = targets.find((target) => target.provider === "claude");
		const codex = targets.find((target) => target.provider === "codex");
		expect(claude).toEqual({
			provider: "claude",
			skillsRoot: join(home, ".claude", "skills"),
			present: true,
		});
		expect(codex).toEqual({
			provider: "codex",
			skillsRoot: join(home, ".codex", "skills"),
			present: false,
		});
	});
});

describe("installSkill", () => {
	it("writes the skill file and its receipt, and inspection reports current", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);

		const result = installSkill({ name: "widget", provider: "claude", home, environment, bundleDir });

		const expectedTarget = join(home, ".claude", "skills", "widget", "SKILL.md");
		const bundleBytes = readFileSync(join(bundleDir, "widget", "SKILL.md"));
		// Cross-check the digest independently of the module under test, rather
		// than trusting that its own hashing matches its own hashing.
		const expectedDigest = createHash("sha256").update(bundleBytes).digest("hex");
		expect(result.target).toBe(expectedTarget);
		expect(result.digest).toBe(expectedDigest);
		expect(existsSync(expectedTarget)).toBe(true);
		expect(readFileSync(expectedTarget, "utf8")).toBe(bundleBytes.toString("utf8"));

		const receiptFile = receiptFileFor(home, "claude", "widget");
		expect(existsSync(receiptFile)).toBe(true);
		const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
		expect(receipt.digest).toBe(result.digest);
		expect(receipt.name).toBe("widget");
		expect(receipt.provider).toBe("claude");
		expect(receipt.target).toBe(expectedTarget);

		const inspection = inspectSkills({ home, environment, bundleDir });
		const entry = skillFor(inspection, "claude", "widget");
		expect(entry.state).toBe("current");
		expect(entry.owner).toBe("skills");
		expect(entry.target).toBe(expectedTarget);
		expect(entry.bundleDigest).toBe(expectedDigest);
	});

	it("refuses to install onto a provider whose home does not exist by default, and does not create it", () => {
		const home = makeTempHome();
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);

		// createProviderHome defaults to false: this is the implicit-provider-set
		// path (e.g. `--provider all`), which must never invent a home for a tool
		// nobody asked it to touch.
		expect(() =>
			installSkill({ name: "widget", provider: "codex", home, environment, bundleDir }),
		).toThrow();
		expect(existsSync(join(home, ".codex"))).toBe(false);
	});

	it("still refuses when createProviderHome is explicitly false", () => {
		const home = makeTempHome();
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);

		expect(() =>
			installSkill({
				name: "widget",
				provider: "codex",
				home,
				environment,
				bundleDir,
				createProviderHome: false,
			}),
		).toThrow();
		expect(existsSync(join(home, ".codex"))).toBe(false);
	});

	it("creates the provider home and installs when createProviderHome is true", () => {
		const home = makeTempHome();
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);

		// The caller only passes this when the provider came from an explicit
		// flag (`--provider codex`) — the user has asked for this provider in as
		// many words, so refusing here would be obstruction, not caution.
		const result = installSkill({
			name: "widget",
			provider: "codex",
			home,
			environment,
			bundleDir,
			createProviderHome: true,
		});

		expect(existsSync(join(home, ".codex"))).toBe(true);
		const expectedTarget = join(home, ".codex", "skills", "widget", "SKILL.md");
		expect(result.target).toBe(expectedTarget);
		expect(existsSync(expectedTarget)).toBe(true);
		expect(existsSync(receiptFileFor(home, "codex", "widget"))).toBe(true);
	});
});

describe("inspectSkills state transitions", () => {
	it("reports outdated once the bundle source moves on from an installed receipt", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);
		installSkill({ name: "widget", provider: "claude", home, environment, bundleDir });

		// The CLI ships a new version of the skill; the installed copy and its
		// receipt do not change.
		writeFileSync(join(bundleDir, "widget", "SKILL.md"), "---\nname: widget\n---\nV2\n");

		const inspection = inspectSkills({ home, environment, bundleDir });
		expect(skillFor(inspection, "claude", "widget").state).toBe("outdated");
	});

	it("reports modified once the installed file is edited by hand", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);
		const { target } = installSkill({ name: "widget", provider: "claude", home, environment, bundleDir });

		writeFileSync(target, "hand-edited content\n");

		const inspection = inspectSkills({ home, environment, bundleDir });
		expect(skillFor(inspection, "claude", "widget").state).toBe("modified");
	});

	it("reports missing once the installed file is deleted", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);
		const { target } = installSkill({ name: "widget", provider: "claude", home, environment, bundleDir });

		rmSync(target);

		const inspection = inspectSkills({ home, environment, bundleDir });
		expect(skillFor(inspection, "claude", "widget").state).toBe("missing");
	});

	it("adopts a pre-existing file that already matches the bundle, silently gaining a receipt", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);
		const bundleContent = readFileSync(join(bundleDir, "widget", "SKILL.md"), "utf8");
		const targetDir = join(home, ".claude", "skills", "widget");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "SKILL.md"), bundleContent);
		const receiptFile = receiptFileFor(home, "claude", "widget");
		expect(existsSync(receiptFile)).toBe(false);

		const inspection = inspectSkills({ home, environment, bundleDir });

		expect(skillFor(inspection, "claude", "widget").state).toBe("current");
		expect(existsSync(receiptFile)).toBe(true);
		const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
		expect(receipt.digest).toBe(skillFor(inspection, "claude", "widget").bundleDigest);
	});

	it("reports unmanaged for hand-placed content that never matched the bundle, and never adopts it", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);
		const targetDir = join(home, ".claude", "skills", "widget");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "SKILL.md"), "someone else's content\n");

		const inspection = inspectSkills({ home, environment, bundleDir });

		expect(skillFor(inspection, "claude", "widget").state).toBe("unmanaged");
		expect(existsSync(receiptFileFor(home, "claude", "widget"))).toBe(false);
	});
});

describe("inspectSkills provider handling", () => {
	it("skips a provider whose home is absent instead of creating it", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		// codex's home is never created.
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);

		const inspection = inspectSkills({ home, environment, bundleDir });

		expect(inspection.skipped).toContainEqual({ provider: "codex", reason: "provider_home_absent" });
		expect(existsSync(join(home, ".codex"))).toBe(false);
		expect(inspection.skills.some((skill) => skill.provider === "codex")).toBe(false);
	});
});

describe("inspectSkills and dure-orchestration", () => {
	it("reports dure-orchestration as external, present, and never as a tracked skill", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);
		const orchestrationDir = join(home, ".claude", "skills", "dure-orchestration");
		mkdirSync(orchestrationDir, { recursive: true });
		writeFileSync(join(orchestrationDir, "SKILL.md"), "orchestration content\n");

		const inspection = inspectSkills({ home, environment, bundleDir });

		expect(inspection.external).toContainEqual({
			name: "dure-orchestration",
			provider: "claude",
			present: true,
			owner: "integration",
			installCommand: "dure integration install --global --provider claude --approve-global-config",
		});
		expect(inspection.skills.some((skill) => skill.name === "dure-orchestration")).toBe(false);
	});

	it("reports dure-orchestration as absent when its file is not on disk", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);

		const inspection = inspectSkills({ home, environment, bundleDir });

		const entry = inspection.external.find(
			(candidate) => candidate.provider === "claude" && candidate.name === "dure-orchestration",
		);
		expect(entry.present).toBe(false);
	});
});

describe("removeSkill", () => {
	it("deletes both the installed file and its receipt", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const bundleDir = makeTempBundle();
		const environment = environmentFor(home);
		const { target } = installSkill({ name: "widget", provider: "claude", home, environment, bundleDir });
		const receiptFile = receiptFileFor(home, "claude", "widget");
		expect(existsSync(target)).toBe(true);
		expect(existsSync(receiptFile)).toBe(true);

		removeSkill({ name: "widget", provider: "claude", home, environment });

		expect(existsSync(target)).toBe(false);
		expect(existsSync(receiptFile)).toBe(false);
	});
});
