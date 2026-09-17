// Guards the shipped agent skills against CLI drift. A skill that names a
// command the CLI no longer dispatches is worse than no skill at all: the
// agent reading it will run the command and get "Unknown command". So every
// `dure <group>` written as a command inside cli/skills/**/SKILL.md must
// still resolve in cli/dure.mjs's own dispatch, and the dispatch list is
// read out of that source rather than restated here — a hardcoded copy
// would drift in exactly the way this test exists to prevent.
//
// Dispatching is not the same as working, so a second check rejects groups the
// CLI still answers but no longer performs — see `retiredCommands`. What
// remains unguarded is everything below group level: a subcommand, a flag, or
// an option's shape.
//
// It also holds `dure skills list` to the truth: an agent discovers skills
// through that listing, so a shipped skill that the listing omits is
// invisible no matter how good it is.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "cli", "dure.mjs");
const skillsRoot = join(repoRoot, "cli", "skills");

const cleanups = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** The CLI's real top-level command groups, derived from its dispatch: the
 *  `cmd === "x"` guards that run before the registry loads, plus the labels
 *  of the one `switch (cmd)` that handles the rest. */
function dispatchedCommands(source) {
	const names = new Set();
	for (const match of source.matchAll(/\bcmd === "([^"]+)"/g)) names.add(match[1]);
	const switchStart = source.indexOf("switch (cmd) {");
	if (switchStart < 0) throw new Error("cli/dure.mjs no longer has a switch (cmd) dispatch");
	const switchEnd = source.indexOf("default:", switchStart);
	for (const match of source.slice(switchStart, switchEnd).matchAll(/\bcase "([^"]+)":/g)) {
		names.add(match[1]);
	}
	return names;
}

/** The literal shape a retirement branch must use for the scan below to see
 *  it: the command named the way an agent types it. Interpolating the name
 *  (`dure ${cmd} has been retired`) does not match, and neither does a
 *  rephrasing — see RETIREMENT_PHRASING_ASSUMPTION. */
const RETIREMENT_MESSAGE = /\bdure ([a-z][a-z0-9-]*) has been retired\b/g;

/** Retirements that end a subsystem rather than a command group, so the scan
 *  must not expect a command name in them. Matched against the text around the
 *  word "retired", with hyphens normalized, so one entry covers "file mailbox"
 *  and "file-mailbox". Keep this short: every addition is a message the command
 *  scan cannot read, and the point of the list is to stay auditable. */
const SUBSYSTEM_RETIREMENTS = ["legacy session daemon", "file mailbox"];

/** Groups the dispatch still answers but no longer performs. Resolving is not
 *  the same as working: `dure checkpoint` is retired inside the dispatch, so it
 *  exits 0, writes one stderr line and does nothing — invisible to the check
 *  above, which is exactly how a retired command survived in a shipped skill.
 *
 *  ASSUMPTION (RETIREMENT_PHRASING_ASSUMPTION): every future top-level
 *  retirement writes RETIREMENT_MESSAGE's exact wording with the name spelled
 *  out. Nothing in the CLI enforces that. A branch that says "dure foo is no
 *  longer available", or builds the same sentence by interpolation, is perfectly
 *  good output that this scan cannot read — and it degrades *silently*, because
 *  the floor below stays satisfied by whichever retirements still match.
 *  `unreadableRetirements` exists to convert that one direction into a loud
 *  failure. The opposite drift is already loud: move a retirement branch out of
 *  the top-level `if` chain and the alias walk-back reaches past it into a
 *  working command's guard, which the floor rejects. */
function retiredCommands(source) {
	const retired = new Set();
	for (const match of source.matchAll(RETIREMENT_MESSAGE)) {
		retired.add(match[1]);
		const guard = source.lastIndexOf("\n  if (", match.index);
		if (guard < 0) continue;
		for (const alias of source.slice(guard, match.index).matchAll(/\bcmd === "([^"]+)"/g)) {
			retired.add(alias[1]);
		}
	}
	return retired;
}

/** Every mention of retirement in the CLI's output that `retiredCommands`
 *  cannot account for. Comment lines are dropped first — they explain
 *  retirements rather than announcing them — and each surviving mention must
 *  either carry a command name in the expected form or sit next to a known
 *  subsystem retirement. Anything else is a retirement this file has stopped
 *  covering, and the test says so instead of quietly shrinking.
 *
 *  This narrows the silent window; it does not close it. An interpolated name
 *  or a reworded sentence is caught, because both still say "retired". A
 *  retirement that avoids the word altogether — "dure foo is no longer
 *  available" — is invisible to this and to `retiredCommands` alike, and no
 *  cheap textual check finds it. That residue is the honest cost of reading
 *  intent out of message text instead of out of a declared registry. */
function unreadableRetirements(source) {
	const emitted = source
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");
	const unreadable = [];
	for (const match of emitted.matchAll(/retired/gi)) {
		const window = emitted
			.slice(Math.max(0, match.index - 160), match.index + 160)
			.replaceAll("-", " ");
		if (new RegExp(RETIREMENT_MESSAGE.source).test(window)) continue;
		if (SUBSYSTEM_RETIREMENTS.some((known) => window.includes(known))) continue;
		unreadable.push(window.trim());
	}
	return unreadable;
}

/** Only text written as code counts as a command. Fenced blocks and inline
 *  spans are where a skill tells an agent what to run; surrounding prose may
 *  say "dure" as an ordinary word and must never be parsed as an invocation. */
function codeSpans(markdown) {
	const spans = [];
	const prose = markdown.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, body) => {
		spans.push(body);
		return "\n";
	});
	for (const match of prose.matchAll(/`([^`\n]+)`/g)) spans.push(match[1]);
	return spans;
}

/** Every top-level group a skill invokes, e.g. "run" from `dure run "..."`. */
function invokedCommands(markdown) {
	const invoked = new Set();
	for (const span of codeSpans(markdown)) {
		for (const match of span.matchAll(/(?:^|[\s(;&|])dure\s+([a-z][a-z0-9-]*)/g)) {
			invoked.add(match[1]);
		}
	}
	return invoked;
}

function shippedSkills() {
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

function readSkill(name) {
	return readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
}

function readGuidance(name) {
	const guide = join(skillsRoot, name, "GUIDE.md");
	return readSkill(name) + (existsSync(guide) ? readFileSync(guide, "utf8") : "");
}

function runCli(args, options = {}) {
	return execFileSync(process.execPath, [cliPath, ...args], {
		encoding: "utf8",
		...options,
	});
}

const cliSource = readFileSync(cliPath, "utf8");
const commands = dispatchedCommands(cliSource);
const retired = retiredCommands(cliSource);
const skills = shippedSkills();

describe("dure CLI dispatch extraction", () => {
	it("finds the command groups the CLI actually handles", () => {
		// A sanity floor on the extraction itself: if this regressed to an
		// empty or tiny set, every drift assertion below would pass vacuously.
		expect(commands.size).toBeGreaterThan(30);
		for (const known of ["run", "ls", "read", "send", "wait", "feedback", "computer", "skills"]) {
			expect(commands).toContain(known);
		}
		expect(commands).not.toContain("definitely-not-a-dure-command");
	});

	it("finds retired groups without sweeping up working ones", () => {
		// Same floor, for the retirement scan: it must find something, every
		// name it finds must be a real dispatched group, and it must never
		// reach a command that still does its job.
		expect(retired.size).toBeGreaterThan(0);
		for (const group of retired) expect(commands).toContain(group);
		for (const working of ["run", "ls", "read", "send", "wait", "feedback"]) {
			expect(retired).not.toContain(working);
		}
	});

	it("leaves no retirement message the scan cannot account for", () => {
		// The scan reads one phrasing. Without this, a retirement worded any
		// other way would go uncovered and nothing would say so. If this fails
		// on a legitimate new message, either give it RETIREMENT_MESSAGE's
		// wording or add its subsystem to SUBSYSTEM_RETIREMENTS — do not widen
		// the scan's regex until it matches prose.
		expect(unreadableRetirements(cliSource)).toEqual([]);
	});

	it("catches the retirement wordings it claims to, and admits the one it misses", () => {
		// Interpolating the name, or rewording around it, is good human output
		// that `retiredCommands` cannot read. These are the cases the check
		// converts from silent to loud.
		expect(unreadableRetirements("fail(`dure ${cmd} has been retired`);")).toHaveLength(1);
		expect(unreadableRetirements('fail("dure foo was retired in 2026");')).toHaveLength(1);
		expect(unreadableRetirements('fail("dure foo has been retired");')).toEqual([]);
		// And the limit, pinned so nobody reads this as a closed door: drop the
		// word "retired" and both scans go blind.
		expect(unreadableRetirements('fail("dure foo is no longer available");')).toEqual([]);
	});
});

describe("shipped skills only name commands the CLI dispatches", () => {
	it("ships at least one skill to check", () => {
		expect(skills.length).toBeGreaterThan(0);
	});

	for (const name of skills) {
		it(`${name} names only real command groups`, () => {
			const invoked = [...invokedCommands(readGuidance(name))].sort();
			expect(invoked.length).toBeGreaterThan(0);
			expect(invoked.filter((group) => !commands.has(group))).toEqual([]);
		});

		it(`${name} tells no agent to run a retired command`, () => {
			// Write a retired command as prose (`auto`, not `dure auto`) when a
			// skill needs to warn that it is gone; a `dure …` span reads as an
			// instruction to run it, to this check and to an agent alike.
			const invoked = [...invokedCommands(readGuidance(name))].sort();
			expect(invoked.filter((group) => retired.has(group))).toEqual([]);
		});

		it(`${name} declares frontmatter matching its directory`, () => {
			const markdown = readSkill(name);
			expect(markdown.startsWith("---\n")).toBe(true);
			const frontmatter = markdown.slice(4, markdown.indexOf("\n---\n", 3));
			expect(frontmatter).toMatch(new RegExp(`^name:\\s*${name}\\s*$`, "m"));
			expect(frontmatter).toMatch(/^description:/m);
		});
	}
});

/** Runs `skills list` once, lazily. Spawning it in a describe body instead
 *  would turn a non-zero exit into a collection error that takes every test
 *  in this file down with it, reporting "no tests" rather than one failure. */
let listingOnce;
function skillsListing() {
	listingOnce ??= runCli(["skills", "list"]);
	return listingOnce;
}

describe("dure skills list", () => {
	it("names every skill directory bundled under cli/skills", () => {
		const listed = new Set(skillsListing().split("\n").map((line) => line.trim()));
		for (const name of skills) expect(listed).toContain(name);
	});

	it("names the separately shipped orchestration skill and how to install it", () => {
		// dure-orchestration ships from orchestration/integration/SKILL.md, not
		// from cli/skills, so reading the bundle directory alone under-reports
		// what an agent has. The listing must say so rather than stay silent.
		const listing = skillsListing();
		const listed = new Set(listing.split("\n").map((line) => line.trim()));
		expect(listed).toContain("dure-orchestration");
		expect(listing).toContain("dure integration install");
	});
});

describe("dure skills install", () => {
	it("installs each bundled skill into the working directory", () => {
		const scratch = mkdtempSync(join(tmpdir(), "dure-skills-install-"));
		cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
		for (const name of skills) {
			runCli(["skills", "install", name], { cwd: scratch });
			const installed = join(scratch, ".claude", "skills", name, "SKILL.md");
			expect(existsSync(installed)).toBe(true);
			expect(readFileSync(installed, "utf8")).toBe(readSkill(name));
		}
	});
});

describe("dure skills get", () => {
	function isolated() {
		const root = mkdtempSync(join(tmpdir(), "dure-skill-guide-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		return { cwd: root, env: scriptTestEnvironment({ HOME: root, DURE_HOME: join(root, "dure-home"), HMUX_DISCOVERY_ROOT: join(root, "discovery"), DURE_APP_CHANNEL: "stable" }) };
	}

	it.each(["dure", "dure-browser"])("reads %s from the selected CLI, not the provider or working directory", (name) => {
		const options = isolated();
		for (const directory of [join(options.cwd, ".codex", "skills", name), join(options.cwd, "cli", "skills", name)]) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "GUIDE.md"), "wrong installation");
			writeFileSync(join(directory, "SKILL.md"), "stale provider instructions");
		}
		const expected = readFileSync(join(skillsRoot, name, "GUIDE.md"), "utf8");
		expect(runCli(["skills", "get", name], options)).toBe(expected);
		const result = JSON.parse(runCli(["skills", "get", name, "--json"], options));
		expect(result).toMatchObject({ schemaVersion: 1, name, markdown: expected });
		const version = JSON.parse(runCli(["version", "--json"], options));
		expect(result.cli).toEqual({ packageVersion: version.packageVersion, buildId: version.buildId });
		expect(existsSync(options.env.DURE_HOME)).toBe(false);
		expect(existsSync(options.env.HMUX_DISCOVERY_ROOT)).toBe(false);
	});

	it("serves the full bundled skill when it has no separate guide", () => {
		expect(runCli(["skills", "get", "dure-cli"], isolated())).toBe(readSkill("dure-cli"));
	});

	it.each([[], ["missing"], ["../dure"], ["dure", "extra"], ["dure", "--reference", "other.md"], ["dure", "--global"]].map((args) => ({ args })))("refuses an unsupported guide request $args", ({ args }) => {
		expect(() => runCli(["skills", "get", ...args], { ...isolated(), stdio: "pipe" })).toThrow();
	});
});
