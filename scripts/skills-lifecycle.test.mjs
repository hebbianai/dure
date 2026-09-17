// Subprocess tests for `dure skills status|install|update|remove` — the CLI
// surface built on cli/lib/skill-install.mjs's receipts/provider scanning and
// cli/lib/contracts/skill-install.mjs's pure state derivation. `list` and
// `path` are unchanged and stay covered by scripts/skills-commands.test.mjs.
//
// Named skills-lifecycle.test.mjs, not skills-command(s).test.mjs:
// scripts/skills-commands.test.mjs already exists as the drift guard for
// skill content, and a name one letter apart from it is how someone edits
// the wrong file.
//
// Hard constraint: nothing here may touch a real ~/.claude, ~/.codex or
// ~/.dure. Every test's HOME and DURE_HOME point at a fresh temp directory,
// and makeTempHome() asserts that directory is under the OS temp directory
// before any test is allowed to write into it — the same guard
// scripts/skill-install.test.mjs uses for the library layer underneath this.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "cli", "dure.mjs");
const skillsRoot = join(repoRoot, "cli", "skills");

const cleanups = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A fresh temp directory to use as HOME, verified to live under the OS temp
 *  directory before any test points the CLI at it — so a future edit that
 *  swaps in a real home fails this assertion instead of quietly writing
 *  into someone's machine. */
function makeTempHome() {
	const home = mkdtempSync(join(tmpdir(), "dure-skills-lifecycle-home-"));
	expect(home.startsWith(tmpdir())).toBe(true);
	cleanups.push(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

function markProviderPresent(home, provider) {
	mkdirSync(join(home, provider === "claude" ? ".claude" : ".codex"), { recursive: true });
}

function receiptFileFor(home, provider, name) {
	return join(home, "dure-home", "skills", "receipts", provider, `${name}.json`);
}

function installedFileFor(home, provider, name) {
	return join(home, provider === "claude" ? ".claude" : ".codex", "skills", name, "SKILL.md");
}

function bundledSkillNames() {
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

/** Runs the real CLI against `home` (HOME and DURE_HOME both pinned to it, so
 *  the receipt store lands in the same temp tree as the provider homes) and
 *  never throws on a non-zero exit — every assertion here needs the exact
 *  status code, not a caught exception. `cwd`, when given, is the child
 *  process's working directory — used only by the legacy cwd-scoped
 *  `install` path, which must never run against this test file's own cwd
 *  (the shared worktree checkout). */
function runCli(args, home, cwd) {
	try {
		const stdout = execFileSync(process.execPath, [cliPath, ...args], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, DURE_HOME: join(home, "dure-home") },
			...(cwd ? { cwd } : {}),
		});
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
}

/** A fresh temp directory to use as the child CLI's cwd, verified to live
 *  under the OS temp directory — mirrors makeTempHome()'s guard so the
 *  legacy cwd-scoped `install` path (which writes to `<cwd>/.claude/skills`)
 *  never touches this test file's own working directory. */
function makeTempCwd() {
	const cwd = mkdtempSync(join(tmpdir(), "dure-skills-lifecycle-cwd-"));
	expect(cwd.startsWith(tmpdir())).toBe(true);
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

/** The receipts directory under a temp home's DURE_HOME — must stay absent
 *  or empty for any scenario that should never adopt or write a receipt. */
function receiptsDirFor(home) {
	return join(home, "dure-home", "skills", "receipts");
}

describe("dure skills status", () => {
	it("lists every bundled skill for both providers in JSON", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		markProviderPresent(home, "codex");

		const result = runCli(["skills", "status", "--json"], home);

		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout);
		for (const name of bundledSkillNames()) {
			expect(report.skills.some((skill) => skill.name === name && skill.provider === "claude")).toBe(true);
			expect(report.skills.some((skill) => skill.name === name && skill.provider === "codex")).toBe(true);
		}
		expect(report.skipped).toEqual([]);
	});
});

describe("dure skills install --global", () => {
	// The legacy cwd path still maps `hebbian` to the `dure` bundle. The
	// receipted path must not: it would install bundle content under a
	// directory name that status, update and remove all look up by bundled
	// name, leaving it permanently invisible to them. Pinned so the asymmetry
	// is a decision rather than something a future reader "restores".
	it("refuses the legacy hebbian alias instead of installing it unmanageably", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");

		const result = runCli(["skills", "install", "hebbian", "--global"], home);

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/Bundled skill 'hebbian' was not found/);
		expect(existsSync(installedFileFor(home, "claude", "hebbian"))).toBe(false);
		expect(existsSync(installedFileFor(home, "claude", "dure"))).toBe(false);
	});

	it("installs 'dure' with that exact spelling and writes both present providers", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		markProviderPresent(home, "codex");

		const result = runCli(["skills", "install", "dure", "--global"], home);

		expect(result.status).toBe(0);
		const bundled = readFileSync(join(skillsRoot, "dure", "SKILL.md"));
		const claudeTarget = installedFileFor(home, "claude", "dure");
		const codexTarget = installedFileFor(home, "codex", "dure");
		expect(existsSync(claudeTarget)).toBe(true);
		expect(existsSync(codexTarget)).toBe(true);
		expect(readFileSync(claudeTarget)).toEqual(bundled);
		expect(readFileSync(codexTarget)).toEqual(bundled);
		expect(existsSync(receiptFileFor(home, "claude", "dure"))).toBe(true);
		expect(existsSync(receiptFileFor(home, "codex", "dure"))).toBe(true);
	});

	it("exits 2 for an unknown skill name and writes nothing", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");

		const result = runCli(["skills", "install", "definitely-not-a-bundled-skill", "--global"], home);

		expect(result.status).toBe(2);
		expect(existsSync(join(home, ".claude", "skills", "definitely-not-a-bundled-skill"))).toBe(false);
	});

	it("exits 2 for an unknown --provider value", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");

		const result = runCli(["skills", "install", "dure", "--global", "--provider", "bogus"], home);

		expect(result.status).toBe(2);
	});

	it("creates an absent provider home only for an explicit --provider, never for the implicit default", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		// codex's home is never created ahead of time.

		const implicit = runCli(["skills", "install", "dure", "--global"], home);
		expect(implicit.status).toBe(0);
		expect(existsSync(join(home, ".codex"))).toBe(false);
		expect(implicit.stdout).toMatch(/codex: skipped \(provider not present\)/);

		const explicit = runCli(["skills", "install", "dure", "--global", "--provider", "codex"], home);
		expect(explicit.status).toBe(0);
		expect(existsSync(join(home, ".codex"))).toBe(true);
		expect(existsSync(installedFileFor(home, "codex", "dure"))).toBe(true);
	});
});

describe("dure skills update --all", () => {
	it("re-installs a hand-edited file, and a second run reports everything already current", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		markProviderPresent(home, "codex");
		const names = bundledSkillNames();
		for (const name of names) {
			expect(runCli(["skills", "install", name, "--global"], home).status).toBe(0);
		}

		const target = installedFileFor(home, "claude", "dure");
		writeFileSync(target, "hand-edited nonsense\n");

		const firstUpdate = runCli(["skills", "update", "--all", "--global"], home);
		expect(firstUpdate.status).toBe(0);
		expect(firstUpdate.stdout).toMatch(/dure \(claude\): reinstalled \(was modified\)/);
		expect(readFileSync(target)).toEqual(readFileSync(join(skillsRoot, "dure", "SKILL.md")));

		const secondUpdate = runCli(["skills", "update", "--all", "--global"], home);
		expect(secondUpdate.status).toBe(0);
		const lines = secondUpdate.stdout.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(names.length * 2); // every bundled skill, both providers
		for (const line of lines) expect(line).toMatch(/already current$/);
	});

	it("does not perform a first install for a bundled skill that was never installed", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const names = bundledSkillNames();
		expect(names.length).toBeGreaterThan(1); // otherwise this test exercises nothing
		runCli(["skills", "install", names[0], "--global"], home);

		const result = runCli(["skills", "update", "--all", "--global"], home);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(new RegExp(`${names[0]} \\(claude\\): already current`));
		for (const name of names.slice(1)) {
			expect(result.stdout).toMatch(new RegExp(`${name} \\(claude\\): not installed, skipped`));
			expect(existsSync(installedFileFor(home, "claude", name))).toBe(false);
		}
	});
});

describe("dure skills remove", () => {
	it("deletes the installed file and its receipt", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		runCli(["skills", "install", "dure", "--global"], home);
		const target = installedFileFor(home, "claude", "dure");
		const receipt = receiptFileFor(home, "claude", "dure");
		expect(existsSync(target)).toBe(true);
		expect(existsSync(receipt)).toBe(true);

		const result = runCli(["skills", "remove", "dure"], home);

		expect(result.status).toBe(0);
		expect(existsSync(target)).toBe(false);
		expect(existsSync(receipt)).toBe(false);
	});

	it("exits 2 when no name is given", () => {
		const home = makeTempHome();

		const result = runCli(["skills", "remove"], home);

		expect(result.status).toBe(2);
	});
});

// Regression coverage for the Task 3 review's Critical finding: `update`
// without `--global` used `process.cwd()` as its `home`, but the receipt
// store (cli/lib/skill-install.mjs's receiptFilePath) is keyed to
// appRootDirectory(environment) — DURE_HOME or the real homedir() — and never
// follows a `home` argument. A cwd-scoped update could therefore adopt or
// overwrite a receipt in the user's real global store while only ever
// touching a project-local file. `update` now requires `--global` and must
// reject its absence before doing any home-scoped filesystem work at all.
// Task 4: `dure doctor --json` reports every shipped skill's install state
// as a single `dure-skills` dependency, replacing the old single-skill
// `dure-skill` row. src/lib/agents/agentEnvironment.ts (a concurrent task on
// this same branch) compares fixCommand/updateCommand verbatim across the
// CLI/settings-page shell boundary, so these tests pin the exact spellings,
// not just presence.
describe("dure doctor — dure-skills dependency", () => {
	it("replaces the legacy dure-skill id and reports every bundled skill missing per present provider when nothing is installed", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		markProviderPresent(home, "codex");

		const result = runCli(["doctor", "--json"], home);

		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.dependencies.some((dependency) => dependency.id === "dure-skill")).toBe(false);
		const dureSkills = report.dependencies.find((dependency) => dependency.id === "dure-skills");
		expect(dureSkills).toBeTruthy();
		expect(dureSkills.fixCommand).toBe("dure skills install --global");
		expect(dureSkills.updateCommand).toBe("dure skills update --all --global");
		expect(dureSkills.ok).toBe(false);

		const names = bundledSkillNames();
		expect(dureSkills.details.length).toBe(names.length * 2); // every bundled skill, both providers
		for (const provider of ["claude", "codex"]) {
			for (const name of names) {
				const detail = dureSkills.details.find((d) => d.provider === provider && d.name === name);
				expect(detail).toBeTruthy();
				expect(detail.state).toBe("missing");
			}
		}
		// The orchestration skill is a different dependency's authority; it must
		// never appear inside dure-skills' details.
		expect(dureSkills.details.some((d) => d.name === "dure-orchestration")).toBe(false);
	});

	it("spells per-detail fix and update commands exactly, in --global --provider order", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		markProviderPresent(home, "codex");
		const name = bundledSkillNames()[0];

		const result = runCli(["doctor", "--json"], home);

		const dureSkills = JSON.parse(result.stdout).dependencies.find((dependency) => dependency.id === "dure-skills");
		for (const provider of ["claude", "codex"]) {
			const detail = dureSkills.details.find((d) => d.provider === provider && d.name === name);
			expect(detail.fixCommand).toBe(`dure skills install ${name} --global --provider ${provider}`);
			expect(detail.updateCommand).toBe(`dure skills update ${name} --global --provider ${provider}`);
		}
	});

	// This is the literal command cmdEnvironmentDoctor publishes as the
	// dure-skills dependency's fixCommand (cli/dure.mjs's `report.dependencies`
	// entry with id "dure-skills") — the settings page is about to put a
	// button on that exact string. Task 4's fix-1 review found that running
	// this literal command (no name, no per-name loop) left three of the four
	// bundled skills missing: `cmdSkills`'s install branch defaulted a nameless
	// install to the single skill "dure". Unlike the superseded version of
	// this test, this must run the doctor's exact fixCommand once — a loop
	// that installs every bundled name individually proves the end state is
	// reachable but never exercises what the button will actually run.
	it("reports every detail current and ok true after `dure skills install --global`", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		markProviderPresent(home, "codex");

		const install = runCli(["skills", "install", "--global"], home);
		expect(install.status).toBe(0);

		const result = runCli(["doctor", "--json"], home);

		expect(result.status).toBe(0);
		const dureSkills = JSON.parse(result.stdout).dependencies.find((dependency) => dependency.id === "dure-skills");
		expect(dureSkills.ok).toBe(true);
		expect(dureSkills.details.length).toBe(bundledSkillNames().length * 2); // every bundled skill, both providers
		expect(dureSkills.details.every((d) => d.state === "current")).toBe(true);
	});

	// parseOpts consumes `--all` into opts.all before it ever reaches
	// opts.rest, so `dure skills install --all --global` already resolves to
	// the same nameless-install path as `dure skills install --global` by
	// construction — nobody had to add an --all branch to cmdSkills's install
	// sub for this to work. Pinned so a user who learned `update --all` and
	// reaches for the same spelling on install finds it already does the
	// right thing.
	it("`--all --global` installs every bundled skill, the same as the nameless form", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		markProviderPresent(home, "codex");

		const result = runCli(["skills", "install", "--all", "--global"], home);

		expect(result.status).toBe(0);
		for (const name of bundledSkillNames()) {
			expect(existsSync(installedFileFor(home, "claude", name))).toBe(true);
			expect(existsSync(installedFileFor(home, "codex", name))).toBe(true);
		}
	});

	it("a provider whose home is absent contributes no details and does not prevent ok:true", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		// codex's home is never created.
		for (const name of bundledSkillNames()) {
			expect(runCli(["skills", "install", name, "--global"], home).status).toBe(0);
		}

		const result = runCli(["doctor", "--json"], home);

		const dureSkills = JSON.parse(result.stdout).dependencies.find((dependency) => dependency.id === "dure-skills");
		expect(dureSkills.ok).toBe(true);
		expect(dureSkills.details.some((d) => d.provider === "codex")).toBe(false);
		expect(dureSkills.details.length).toBe(bundledSkillNames().length);
	});

	it("with neither provider present, ok is vacuously true and details is empty", () => {
		const home = makeTempHome();
		// Neither ~/.claude nor ~/.codex exists in this temp home.

		const result = runCli(["doctor", "--json"], home);

		expect(result.status).toBe(0);
		const dureSkills = JSON.parse(result.stdout).dependencies.find((dependency) => dependency.id === "dure-skills");
		expect(dureSkills.ok).toBe(true);
		expect(dureSkills.details).toEqual([]);
	});

	it("prints one indented `<provider>/<name> — <state>` line per non-current detail in human-readable output", () => {
		const home = makeTempHome();
		markProviderPresent(home, "claude");
		const names = bundledSkillNames();

		const result = runCli(["doctor"], home);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/Dure skills — dure skills install --global/);
		for (const name of names) {
			expect(result.stdout).toMatch(new RegExp(`    claude/${name} — missing`));
		}
	});
});

describe("dure skills update requires --global", () => {
	it("update --all without --global exits 2 and writes no receipt, even when a cwd-local install already matches the bundle byte-for-byte", () => {
		const home = makeTempHome();
		const cwd = makeTempCwd();
		markProviderPresent(home, "claude");
		const names = bundledSkillNames();
		// The legacy cwd-scoped `install` (no --global) copies the bundle
		// bytes verbatim into `<cwd>/.claude/skills/<name>/SKILL.md`. Before
		// the fix, a subsequent cwd-scoped `update` would read that file as
		// "current" (disk matches bundle, no receipt) and silently adopt a
		// receipt for it — but under the *real* receipt store, not `cwd`.
		// This is the write the regression guards against, with no hand
		// edit required to reach it.
		for (const name of names) {
			expect(runCli(["skills", "install", name], home, cwd).status).toBe(0);
			expect(existsSync(join(cwd, ".claude", "skills", name, "SKILL.md"))).toBe(true);
		}

		const result = runCli(["skills", "update", "--all"], home, cwd);

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/--global/);
		expect(result.stdout).toBe("");
		const receiptsDir = receiptsDirFor(home);
		expect(!existsSync(receiptsDir) || readdirSync(receiptsDir).length === 0).toBe(true);
	});

	it("update <name> without --global exits 2 the same way", () => {
		const home = makeTempHome();
		const cwd = makeTempCwd();
		markProviderPresent(home, "claude");
		const name = bundledSkillNames()[0];
		expect(runCli(["skills", "install", name], home, cwd).status).toBe(0);

		const result = runCli(["skills", "update", name], home, cwd);

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/--global/);
		expect(result.stdout).toBe("");
		const receiptsDir = receiptsDirFor(home);
		expect(!existsSync(receiptsDir) || readdirSync(receiptsDir).length === 0).toBe(true);
	});
});
