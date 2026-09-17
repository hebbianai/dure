import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withoutLocalGitOverrides } from "./git-environment.mjs";
import { normalizeFullCommitSha } from "./release-gate.mjs";
import {
	RELEASE_CANDIDATE_FILES,
	RELEASE_CARGO_WORKSPACES,
	replaceReleaseCargoLock,
} from "./release-candidate.mjs";
import {
	VERSION_FILES,
	bump,
	parseVersion,
	readUnifiedVersion,
	readVersionText,
	replaceVersion,
} from "./release-version.mjs";

function git(root, ...args) {
	return execFileSync("git", args, {
		cwd: root,
		env: withoutLocalGitOverrides(),
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function inventory(read, current, next) {
	return [
		...VERSION_FILES.map((file) => ({
			path: file.path,
			after: replaceVersion(file, read(file.path), next),
		})),
		...RELEASE_CARGO_WORKSPACES.map((entry) => ({
			path: entry.lockPath,
			after: replaceReleaseCargoLock(
				read(entry.lockPath),
				entry,
				current,
				next,
			),
		})),
	];
}

/** Validate a reserved immutable version-only tag, then project only its version
 * onto current source. Never copy a historical file snapshot onto newer main. */
export function planReleaseBookkeeping({ root, tag, tagSha }) {
	root = realpathSync(root);
	if (!/^v\d+\.\d+\.\d+$/.test(tag))
		throw new Error("release_bookkeeping_tag_invalid");
	const expected = normalizeFullCommitSha(tagSha, "reserved tag SHA");
	const actual = git(root, "rev-parse", `refs/tags/${tag}^{commit}`).trim();
	if (actual !== expected) throw new Error("release_bookkeeping_tag_mismatch");
	const parents = git(root, "rev-list", "--parents", "-n", "1", actual)
		.trim()
		.split(" ");
	if (parents.length !== 2)
		throw new Error("release_bookkeeping_single_parent_required");
	const parent = parents[1];
	const readTag = (sha, file) => git(root, "show", `${sha}:${file}`);
	const prior = JSON.parse(readTag(parent, "package.json")).version;
	const next = tag.slice(1);
	if (bump(prior, "patch") !== next && bump(prior, "minor") !== next)
		throw new Error("release_bookkeeping_transition_invalid");
	for (const file of VERSION_FILES) {
		if (
			readVersionText(file, readTag(parent, file.path)) !== prior ||
			readVersionText(file, readTag(actual, file.path)) !== next
		)
			throw new Error("release_bookkeeping_tag_version_mismatch");
	}
	const changed = git(root, "diff", "--name-only", parent, actual)
		.trim()
		.split("\n")
		.sort();
	if (
		JSON.stringify(changed) !==
		JSON.stringify([...RELEASE_CANDIDATE_FILES].sort())
	)
		throw new Error("release_bookkeeping_version_only_tag_required");
	for (const file of inventory((name) => readTag(parent, name), prior, next)) {
		for (const sha of [parent, actual]) {
			if (
				!git(root, "ls-tree", sha, "--", file.path).startsWith("100644 blob ")
			)
				throw new Error("release_bookkeeping_tag_mode_changed");
		}
		if (readTag(actual, file.path) !== file.after)
			throw new Error(`release_bookkeeping_tag_body_changed: ${file.path}`);
	}
	const current = readUnifiedVersion(root);
	const left = parseVersion(current);
	const right = parseVersion(next);
	const difference = left.findIndex((value, index) => value !== right[index]);
	if (difference >= 0 && left[difference] > right[difference])
		throw new Error("release_bookkeeping_downgrade_refused");
	const head = git(root, "rev-parse", "HEAD").trim();
	const files = inventory(
		(file) => {
			if (
				!lstatSync(join(root, file)).isFile() ||
				realpathSync(join(root, file)) !== join(root, file) ||
				!git(root, "ls-files", "-s", "--", file).startsWith("100644 ")
			)
				throw new Error(
					"release_bookkeeping_regular_tracked_file_required: " + file,
				);
			return readFileSync(join(root, file), "utf8");
		},
		current,
		next,
	)
		.map((file) => ({
			...file,
			before: readFileSync(join(root, file.path), "utf8"),
		}))
		.filter((file) => file.before !== file.after);
	return {
		root,
		head,
		tag,
		tagSha: actual,
		currentVersion: current,
		version: next,
		files,
	};
}

export function describeReleaseBookkeeping(plan) {
	return {
		head: plan.head,
		tag: plan.tag,
		tagSha: plan.tagSha,
		currentVersion: plan.currentVersion,
		version: plan.version,
		files: plan.files.map(({ path, before, after }) => ({
			path,
			beforeSha256: createHash("sha256").update(before).digest("hex"),
			afterSha256: createHash("sha256").update(after).digest("hex"),
		})),
	};
}

export function applyReleaseBookkeeping(plan) {
	if (
		git(plan.root, "rev-parse", "HEAD").trim() !== plan.head ||
		git(plan.root, "status", "--porcelain=v1", "--untracked-files=all")
	)
		throw new Error("release_bookkeeping_clean_unchanged_checkout_required");
	for (const file of plan.files) {
		if (
			!lstatSync(join(plan.root, file.path)).isFile() ||
			realpathSync(join(plan.root, file.path)) !== join(plan.root, file.path) ||
			readFileSync(join(plan.root, file.path), "utf8") !== file.before
		)
			throw new Error("release_bookkeeping_source_changed");
	}
	for (const file of plan.files)
		writeFileSync(join(plan.root, file.path), file.after);
}
