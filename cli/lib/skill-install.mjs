// The filesystem half of the shipped-skill install lifecycle. Task 1's
// cli/lib/contracts/skill-install.mjs derives a state from three digests and
// touches nothing on disk; this module computes those three digests, reads
// and writes the receipts that record an install, and walks the providers a
// skill can land in. Every filesystem root and environment read is an
// injectable parameter with a real default, the way cli/lib/feedback-command.mjs
// takes them — that is what lets the tests in scripts/skill-install.test.mjs
// exercise this without ever touching a real home directory.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appRootDirectory } from "./app-control-location.mjs";
import { isSkillReceipt, SKILL_RECEIPT_SCHEMA, skillInstallState } from "./contracts/skill-install.mjs";
import { readCliVersion } from "./feedback-command.mjs";

// Where a provider keeps its skills, relative to the user's home directory.
// This must agree with cli/lib/orchestration-integration.mjs's own PROVIDERS
// table (`.claude`/`.codex`, `skills/<name>/SKILL.md`) — that module already
// installs dure-orchestration to both locations, and a second table naming a
// different path would silently split "where the skill actually is" from
// "where this module looks for it".
const PROVIDER_DIRECTORIES = Object.freeze({
	claude: ".claude",
	codex: ".codex",
});

// The skills Dure ships under cli/skills/<name>/SKILL.md. Resolved from this
// file's own location (cli/lib/skill-install.mjs -> ../skills) rather than
// process.cwd(), so it is correct regardless of where `dure` is invoked from.
const DEFAULT_BUNDLE_DIR = fileURLToPath(new URL("../skills", import.meta.url));

// dure-orchestration is installed and receipted by `dure integration`
// (cli/lib/orchestration-integration.mjs), never by this module. It lands at
// the same <skillsRoot>/<name>/SKILL.md shape as a bundled skill, so it is
// cheap to report presence for, but folding it through skillInstallState
// would compare it against a receipt this module never wrote — every install
// would read as "unmanaged", which is false. It is reported separately
// instead, with only what this module actually knows: whether the file is
// there, and the command that owns it.
const DURE_ORCHESTRATION_SKILL_NAME = "dure-orchestration";

function digestBytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The disk digest for a skill target: `null` (never `""` — skillInstallState's
 *  contract requires that exact spelling of "absent") when the file does not
 *  exist or cannot be read, a sha256 hex digest otherwise. Any read error
 *  (missing file, a directory in its place, EACCES) folds to "absent" here:
 *  from this module's perspective those are all "there is nothing usable on
 *  disk", and skillInstallState only needs to know that, not why. */
function readDiskDigestOrNull(targetPath) {
	try {
		return digestBytes(readFileSync(targetPath));
	} catch {
		return null;
	}
}

function bundleSkillPath(bundleDir, name) {
	return join(bundleDir, name, "SKILL.md");
}

/** The digest of a skill as Dure currently ships it. Deliberately does not
 *  catch: per the Task 1 ruling, bundleDigest is never null — a shipped skill
 *  that cannot be read is a packaging bug at the reading site, not a state
 *  for the derivation to represent. Letting this throw is that "erroring
 *  where you read it". */
function readBundleDigest(bundleDir, name) {
	return digestBytes(readFileSync(bundleSkillPath(bundleDir, name)));
}

/** The names of every skill Dure ships from `bundleDir`: a subdirectory
 *  containing a SKILL.md, mirroring the filter `dure skills list` already
 *  uses in cli/dure.mjs's `cmdSkills`. Sorted for deterministic output. */
function shippedSkillNames(bundleDir) {
	return readdirSync(bundleDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(bundleSkillPath(bundleDir, entry.name)))
		.map((entry) => entry.name)
		.sort();
}

function receiptFilePath({ environment, provider, name }) {
	return join(appRootDirectory(environment), "skills", "receipts", provider, `${name}.json`);
}

/** Reads and validates a receipt, folding both "no file" and "file present
 *  but not a valid receipt" (corrupt JSON, or JSON that fails isSkillReceipt)
 *  into the same `null` — exactly the "no receipt" case skillInstallState
 *  expects, per Task 1's contract notes. A corrupt receipt must never crash
 *  inspection; it degrades to being treated as if it were never written. */
function readReceiptOrNull(path) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	return isSkillReceipt(parsed) ? parsed : null;
}

function writeReceipt(path, receipt) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

function buildReceipt({ name, provider, target, digest }) {
	return {
		schemaVersion: SKILL_RECEIPT_SCHEMA,
		name,
		provider,
		target,
		digest,
		cliVersion: readCliVersion(),
		installedAt: new Date().toISOString(),
	};
}

function providerHomePath(home, provider) {
	const directory = PROVIDER_DIRECTORIES[provider];
	if (!directory) throw new Error(`unknown skill provider: ${provider}`);
	return join(home, directory);
}

/**
 * Every provider this module knows about, with where it keeps skills and
 * whether it is actually present on this machine. `environment` is accepted
 * (rather than only `home`) purely so callers — `inspectSkills` chief among
 * them — can forward the same options object they already have without
 * re-destructuring; provider locations do not currently depend on it.
 */
export function providerTargets({ home = homedir(), environment = process.env } = {}) {
	void environment;
	return Object.keys(PROVIDER_DIRECTORIES).map((provider) => {
		const providerHome = providerHomePath(home, provider);
		return {
			provider,
			skillsRoot: join(providerHome, "skills"),
			present: existsSync(providerHome),
		};
	});
}

/**
 * Installs one bundled skill for one provider: copies the bundle's SKILL.md
 * bytes to `<skillsRoot>/<name>/SKILL.md` and writes the receipt that lets a
 * future inspection tell "current" from "modified" from "outdated".
 *
 * `createProviderHome` (default `false`) is the caller's declaration of
 * intent, not something this function infers: only the caller knows whether
 * the provider came from an implicit default (`--provider all`, where an
 * absent `~/.codex` must be skipped rather than conjured for a tool nobody
 * asked to touch) or from an explicit flag (`--provider codex`, where the
 * user has asked for this provider in as many words and refusing would be
 * obstruction, not caution). With the default `false`, an absent provider
 * home throws and nothing is created — the same posture `inspectSkills`
 * takes for its scan. With `true`, the provider home is created before the
 * skill is installed into it.
 */
export function installSkill({
	name,
	provider,
	home = homedir(),
	environment = process.env,
	bundleDir = DEFAULT_BUNDLE_DIR,
	createProviderHome = false,
}) {
	const providerHome = providerHomePath(home, provider);
	if (!existsSync(providerHome)) {
		if (!createProviderHome) {
			throw new Error(`provider home does not exist, refusing to create it: ${providerHome}`);
		}
		mkdirSync(providerHome, { recursive: true });
	}
	const bytes = readFileSync(bundleSkillPath(bundleDir, name));
	const digest = digestBytes(bytes);
	const targetDir = join(providerHome, "skills", name);
	const target = join(targetDir, "SKILL.md");
	mkdirSync(targetDir, { recursive: true });
	writeFileSync(target, bytes);
	writeReceipt(
		receiptFilePath({ environment, provider, name }),
		buildReceipt({ name, provider, target, digest }),
	);
	return { target, digest };
}

/**
 * Removes one installed skill for one provider: the installed SKILL.md and
 * its receipt. Only ever removes the single file this module (or a hand
 * adoption) owns — never the containing directory wholesale, in case a user
 * left other files alongside it. The now-empty directory is removed too, but
 * only when it is in fact empty, and only best-effort: that tidiness is not
 * part of the contract.
 */
export function removeSkill({ name, provider, home = homedir(), environment = process.env }) {
	const providerHome = providerHomePath(home, provider);
	const targetDir = join(providerHome, "skills", name);
	rmSync(join(targetDir, "SKILL.md"), { force: true });
	try {
		if (existsSync(targetDir) && readdirSync(targetDir).length === 0) {
			rmSync(targetDir, { recursive: false });
		}
	} catch {
		// Best-effort tidiness only; the file and receipt removals below are
		// the actual contract.
	}
	rmSync(receiptFilePath({ environment, provider, name }), { force: true });
}

/**
 * The read-only survey behind `dure skills status` and the doctor contract:
 * every bundled skill's state on every present provider, the providers that
 * were skipped, and dure-orchestration's presence reported separately from
 * the five-state model (see DURE_ORCHESTRATION_SKILL_NAME above).
 *
 * Adoption happens here, silently: a file that predates receipts but already
 * matches the bundle reports "current", and this function writes the receipt
 * for it before returning — every user who ran `dure skills install dure
 * --global` before receipts existed must read as up to date, not nagged as
 * unmanaged. That receipt write is best-effort: if the receipt store cannot
 * be written (a read-only `~/.dure`, for instance), the already-true "current"
 * state is still reported. Persisting it is a convenience for next time, not
 * a precondition for reporting the truth this time — so a write failure here
 * degrades silently rather than throwing out of this function or skipping
 * the rest of this provider's skills.
 */
export function inspectSkills({ home = homedir(), environment = process.env, bundleDir = DEFAULT_BUNDLE_DIR } = {}) {
	const targets = providerTargets({ home, environment });
	const skillNames = shippedSkillNames(bundleDir);
	const bundleDigests = new Map();
	const bundleDigestFor = (name) => {
		if (!bundleDigests.has(name)) bundleDigests.set(name, readBundleDigest(bundleDir, name));
		return bundleDigests.get(name);
	};

	const skills = [];
	const external = [];
	const skipped = [];

	for (const target of targets) {
		if (!target.present) {
			skipped.push({ provider: target.provider, reason: "provider_home_absent" });
			continue;
		}

		external.push({
			name: DURE_ORCHESTRATION_SKILL_NAME,
			provider: target.provider,
			present: existsSync(join(target.skillsRoot, DURE_ORCHESTRATION_SKILL_NAME, "SKILL.md")),
			owner: "integration",
			installCommand: `dure integration install --global --provider ${target.provider} --approve-global-config`,
		});

		for (const name of skillNames) {
			const targetPath = join(target.skillsRoot, name, "SKILL.md");
			const diskDigest = readDiskDigestOrNull(targetPath);
			const receiptFile = receiptFilePath({ environment, provider: target.provider, name });
			const receipt = readReceiptOrNull(receiptFile);
			const bundleDigest = bundleDigestFor(name);
			const state = skillInstallState({
				diskDigest,
				receiptDigest: receipt ? receipt.digest : null,
				bundleDigest,
			});

			if (state === "current" && !receipt) {
				try {
					writeReceipt(
						receiptFile,
						buildReceipt({ name, provider: target.provider, target: targetPath, digest: diskDigest }),
					);
				} catch {
					// See the doc comment above: a receipt store that cannot be
					// written must not turn a true "current" into a thrown error.
				}
			}

			skills.push({
				name,
				provider: target.provider,
				state,
				target: targetPath,
				owner: "skills",
				bundleDigest,
			});
		}
	}

	return { skills, external, skipped };
}
