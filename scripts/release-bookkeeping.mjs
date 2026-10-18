#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { RELEASE_REPOSITORY } from "./lib/public-release-contract.mjs";
import {
	applyReleaseBookkeeping,
	describeReleaseBookkeeping,
	planReleaseBookkeeping,
} from "./lib/release-bookkeeping.mjs";
import {
	RELEASE_CANDIDATE_FILES,
	RELEASE_CARGO_WORKSPACES,
} from "./lib/release-candidate.mjs";

const USAGE = "usage: release-bookkeeping.mjs vX.Y.Z [--apply]";
const environment = withoutLocalGitOverrides();

function git(root, ...args) {
	return execFileSync("git", args, {
		cwd: root,
		env: environment,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** Regenerate each lockfile offline, then prove Cargo accepts it unchanged. */
function regenerateCargoLocks(root) {
	for (const { manifestPath } of RELEASE_CARGO_WORKSPACES) {
		for (const flags of [["--offline"], ["--offline", "--locked"]])
			execFileSync(
				"cargo",
				[
					"metadata",
					...flags,
					"--format-version",
					"1",
					"--manifest-path",
					manifestPath,
				],
				{ cwd: root, env: environment, stdio: ["ignore", "ignore", "inherit"] },
			);
	}
}

/** The canonical repository, not a local or forked ref, decides which
 * versions are reserved. A missing local tag is fetched by exact name. */
function reservedTagSha(root, remote, tag) {
	const ref = `refs/tags/${tag}`;
	const sha = git(root, "ls-remote", "--refs", remote, ref)
		.split("\n")
		.map((line) => line.split("\t"))
		.find(([, name]) => name === ref)?.[0];
	if (!sha)
		throw new Error(`release_bookkeeping_tag_unreserved: ${tag} on ${remote}`);
	try {
		git(root, "rev-parse", "--quiet", "--verify", `${ref}^{commit}`);
	} catch {
		git(root, "fetch", "--no-tags", remote, `${ref}:${ref}`);
	}
	return sha;
}

function changedLines(before, after) {
	const left = before.split("\n");
	const right = after.split("\n");
	return left.filter((line, index) => line !== right[index]).length;
}

export function runReleaseBookkeeping(
	argv,
	{
		cwd = process.cwd(),
		remote = `https://github.com/${RELEASE_REPOSITORY}.git`,
		regenerateLocks = regenerateCargoLocks,
		log = console.log,
	} = {},
) {
	const apply = argv.includes("--apply");
	const tags = argv.filter((value) => value !== "--apply");
	if (
		tags.length !== 1 ||
		argv.length !== tags.length + Number(apply) ||
		!/^v\d+\.\d+\.\d+$/.test(tags[0])
	)
		throw new Error(USAGE);
	const [tag] = tags;
	const root = git(cwd, "rev-parse", "--show-toplevel");
	const plan = planReleaseBookkeeping({
		root,
		tag,
		tagSha: reservedTagSha(root, remote, tag),
	});
	const description = describeReleaseBookkeeping(plan);
	if (plan.files.length === 0) {
		log(`The version inventory already matches ${tag}; nothing to reconcile.`);
		return description;
	}
	log(
		`Reconcile ${plan.currentVersion} -> ${plan.version} from ${tag} (${plan.tagSha}) onto ${plan.head}:`,
	);
	for (const file of plan.files)
		log(
			`  ${file.path}: ${changedLines(file.before, file.after)} version line(s)`,
		);
	if (!apply) {
		log("Dry run; no files changed. Rerun with --apply to write them.");
		return description;
	}
	applyReleaseBookkeeping(plan);
	const projected = new Map(
		RELEASE_CANDIDATE_FILES.map((file) => [
			file,
			readFileSync(join(plan.root, file), "utf8"),
		]),
	);
	try {
		regenerateLocks(plan.root);
	} catch (error) {
		throw new Error(
			`release_bookkeeping_cargo_validation_failed: ${error.message}\nThe planned files are written; review git diff or restore them before retrying.`,
		);
	}
	for (const [file, bytes] of projected)
		if (readFileSync(join(plan.root, file), "utf8") !== bytes)
			throw new Error(
				`release_bookkeeping_cargo_regeneration_changed: ${file}; review git diff before committing`,
			);
	log(
		"Applied. Cargo regenerated the lockfiles offline and accepted them with --locked.",
	);
	log(
		`Review git diff, then commit: chore(release): reconcile versions through ${tag}`,
	);
	return description;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		runReleaseBookkeeping(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
